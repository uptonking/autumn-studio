import { mkdirSync } from "node:fs";
import {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
	type VendorAgentSession,
} from "./pi-sdk.cjs";
import type {
	ProviderConfigChanges,
	ProviderConfigState,
	ProviderEvent,
	ProviderModel,
	ProviderPersistence,
	ProviderSessionConfig,
	ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import type { settings } from "../shared/settings.js";
import { agentDir as privateAgentDir, sessionsDir } from "./paths.js";
import { createMcpBridge, type McpBridge } from "./mcp-bridge.js";
import { mapPiEvents, mapReplayEntries } from "./event-mapper.js";
import {
	buildModelRuntime,
	activeProvidersFrom,
	providerDisplayNames,
	toProviderModels,
} from "./model-runtime.js";

export type SettingsHandle = import("@getpaseo/plugin/server").PluginSettings<typeof settings.schema>;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface PromptImage {
	type: "image";
	data: string;
	mimeType: string;
}

/**
 * One Paseo provider session = one embedded pi AgentSession. Owns the
 * session's ModelRuntime (built from plugin settings), its private agentDir,
 * its pi session file (persistence), and the MCP bridge for Paseo-injected
 * servers. Everything lives in-process via the vendored SDK — no external
 * agent binary, and the user's external `~/.pi/agent` is never touched.
 */
export class EmbeddedSession {
	private readonly sessionId: string;
	private readonly piSession: VendorAgentSession;
	private readonly unsubscribe: () => void;
	private readonly modelRuntime: Awaited<ReturnType<typeof buildModelRuntime>>;
	private readonly mcpBridge: McpBridge | null;
	private readonly env: Record<string, string>;
	private readonly activeTurnRef: { current: string | null };
	private readonly models: ProviderModel[];
	private abortRequested = false;
	private currentModel: string | undefined;
	private currentThinking: ThinkingLevel;
	private closed = false;

	private constructor(
		sessionId: string,
		piSession: VendorAgentSession,
		unsubscribe: () => void,
		modelRuntime: Awaited<ReturnType<typeof buildModelRuntime>>,
		mcpBridge: McpBridge | null,
		env: Record<string, string>,
		activeTurnRef: { current: string | null },
		models: ProviderModel[],
		currentModel: string | undefined,
		currentThinking: ThinkingLevel,
	) {
		this.sessionId = sessionId;
		this.piSession = piSession;
		this.unsubscribe = unsubscribe;
		this.modelRuntime = modelRuntime;
		this.mcpBridge = mcpBridge;
		this.env = env;
		this.activeTurnRef = activeTurnRef;
		this.models = models;
		this.currentModel = currentModel;
		this.currentThinking = currentThinking;
	}

	static async create(
		sessionId: string,
		config: ProviderSessionConfig,
		persistence: ProviderPersistence | undefined,
		settingsHandle: SettingsHandle,
		emit: (event: ProviderEvent) => void,
	): Promise<EmbeddedSession> {
		const state = await settingsHandle.read();
		const providers = activeProvidersFrom(state);

		// 1. Model runtime from plugin settings — never the user's models.json.
		// Custom endpoints register their discovered models; the requested
		// model is always included so getModel resolves the catalog-advertised
		// `<entry.id>/<modelId>` id.
		const modelRuntime = await buildModelRuntime(providers, { requestModel: config.model });

		// 2. Resolve the requested model and thinking level.
		let model: unknown = undefined;
		if (config.model) {
			const [provider, modelId] = config.model.split("/", 2);
			if (provider && modelId) {
				model = modelRuntime.getModel(provider, modelId);
			}
		}

		const requestedThinking =
			normalizeThinking(config.thinkingOption) ??
			(state.status === "ready" ? normalizeThinking(state.values.defaultThinkingLevel) : undefined) ??
			"medium";

		// 3. Paseo-injected MCP servers → pi custom tools. One bad server is
		// contained inside the bridge; a total failure must not sink the session.
		let mcpBridge: McpBridge | null = null;
		try {
			mcpBridge = await createMcpBridge(config.mcpServers);
		} catch {
			mcpBridge = null;
		}

		// 4. Private agentDir — isolates the embedded agent from the user's
		// external pi configuration (extensions, settings, auth, models.json).
		// Set unconditionally: the daemon child may inherit the user's
		// PI_CODING_AGENT_DIR, which must not leak in here.
		mkdirSync(privateAgentDir(), { recursive: true });
		process.env.PI_CODING_AGENT_DIR = privateAgentDir();

		// 5. Resource loader: workspace context files (AGENTS.md etc.) plus
		// Paseo's system prompt and the user's custom instructions. Extensions
		// stay off — built-in extension paths don't resolve inside the vendor
		// bundle, and MCP arrives through the bridge instead.
		const appendPrompts: string[] = [];
		if (config.systemPrompt?.trim()) appendPrompts.push(config.systemPrompt.trim());
		if (state.status === "ready" && state.values.customInstructions.trim()) {
			appendPrompts.push(state.values.customInstructions.trim());
		}
		const resourceLoader = new DefaultResourceLoader({
			cwd: config.cwd,
			agentDir: privateAgentDir(),
			noExtensions: true,
			...(appendPrompts.length > 0
				? { appendSystemPromptOverride: (base: string[]) => [...base, ...appendPrompts] }
				: {}),
		});
		await resourceLoader.reload();

		// 6. Session manager backed by a pi session file; an existing file from
		// the persistence handle reattaches the stored conversation.
		mkdirSync(sessionsDir(), { recursive: true });
		const sessionManager = SessionManager.create(config.cwd, sessionsDir());
		const storedFile = readStoredSessionFile(persistence);
		if (storedFile) {
			sessionManager.setSessionFile(storedFile);
		}

		// 7. The embedded session itself.
		const { session: piSession } = await createAgentSession({
			cwd: config.cwd,
			model,
			thinkingLevel: requestedThinking,
			modelRuntime,
			resourceLoader,
			sessionManager,
			customTools: mcpBridge?.tools ?? [],
		});

		// 8. Snapshot the selectable models once; the composer's in-session
		// model switcher reads them from session.config.
		const defaultThinkingId =
			state.status === "ready" ? state.values.defaultThinkingLevel : "medium";
		let available: Array<{ provider: string; id: string; name: string; contextWindow?: number; reasoning?: boolean }> = [];
		try {
			available = (await modelRuntime.getAvailable()).slice();
		} catch {
			available = [];
		}
		const models = toProviderModels(available, defaultThinkingId, providerDisplayNames(providers));

		const activeTurnRef: { current: string | null } = { current: null };
		const unsubscribe = mapPiEvents(sessionId, piSession, emit, () => activeTurnRef.current);

		return new EmbeddedSession(
			sessionId,
			piSession,
			unsubscribe,
			modelRuntime,
			mcpBridge,
			{ ...config.env },
			activeTurnRef,
			models,
			config.model,
			requestedThinking,
		);
	}

	/** Paseo-side persistence handle: the pi session file path for restore. */
	getPersistence(): ProviderPersistence {
		let sessionFile: string | undefined;
		try {
			sessionFile = this.piSession.sessionManager.getSessionFile();
		} catch {
			sessionFile = undefined;
		}
		return {
			version: 1,
			data: {
				sessionFile: sessionFile ?? null,
				nativeSessionId: this.sessionId,
			},
		};
	}

	/** Replayed timeline items for `session.open` with history "replay". */
	replayHistory(): ProviderEvent[] {
		try {
			const entries = this.piSession.sessionManager.getEntries();
			return mapReplayEntries(entries).map((item) => ({
				type: "timeline.item" as const,
				sessionId: this.sessionId,
				item,
			}));
		} catch {
			return [];
		}
	}

	async prompt(
		text: string,
		images: PromptImage[],
		clientMessageId: string,
		delivery: "auto" | "steer",
		emit: (event: ProviderEvent) => void,
	): Promise<void> {
		// The user_message item is emitted here, on acceptance only — a steer
		// with no active turn must not leave a ghost message in the timeline.
		const emitUserMessage = () => {
			emit({
				type: "timeline.item",
				sessionId: this.sessionId,
				item: {
					type: "user_message",
					id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
					text,
					clientMessageId,
				},
			});
		};

		if (delivery === "steer") {
			if (!this.activeTurnRef.current) {
				emit({
					type: "session.prompt_result",
					sessionId: this.sessionId,
					clientMessageId,
					result: { type: "failed", error: { message: "There is no active turn to steer" } },
				});
				return;
			}
			try {
				await this.piSession.steer(text, images.length > 0 ? images : undefined);
			} catch (error) {
				emit({
					type: "session.prompt_result",
					sessionId: this.sessionId,
					clientMessageId,
					result: {
						type: "failed",
						error: { message: error instanceof Error ? error.message : String(error) },
					},
				});
				return;
			}
			emitUserMessage();
			emit({
				type: "session.prompt_result",
				sessionId: this.sessionId,
				clientMessageId,
				result: { type: "steer", turnId: this.activeTurnRef.current },
			});
			return;
		}

		const turnId = `turn-${Date.now()}`;
		this.activeTurnRef.current = turnId;
		this.abortRequested = false;

		emitUserMessage();
		emit({
			type: "session.prompt_result",
			sessionId: this.sessionId,
			clientMessageId,
			result: { type: "turn", turnId },
		});
		emit({ type: "session.turn", sessionId: this.sessionId, turnId, state: "started" });

		// Session env overlays process.env for the duration of the turn (pi's
		// bash tool spawns inherit it). Concurrent turns across sessions race
		// here — accepted for v1, see plan.
		const prevEnv: Record<string, string | undefined> = {};
		for (const [key, value] of Object.entries(this.env)) {
			prevEnv[key] = process.env[key];
			process.env[key] = value;
		}

		try {
			await this.piSession.prompt(text, images.length > 0 ? { images } : undefined);
			// abort() resolves the pending prompt() early — report it as
			// canceled, not completed.
			emit({
				type: "session.turn",
				sessionId: this.sessionId,
				turnId,
				state: this.abortRequested ? "canceled" : "completed",
			});
		} catch (error) {
			emit({
				type: "session.turn",
				sessionId: this.sessionId,
				turnId,
				state: this.abortRequested ? "canceled" : "failed",
				error:
					this.abortRequested || !(error instanceof Error)
						? undefined
						: { message: error.message },
			});
		} finally {
			this.activeTurnRef.current = null;
			for (const [key, val] of Object.entries(prevEnv)) {
				if (val === undefined) delete process.env[key];
				else process.env[key] = val;
			}
		}
	}

	/** Applies config changes. Returns a user-facing warning when nothing changed. */
	async configure(changes: ProviderConfigChanges): Promise<string | undefined> {
		let warning: string | undefined;
		if (changes.model !== undefined && changes.model !== null) {
			const [provider, modelId] = changes.model.split("/", 2);
			if (provider && modelId) {
				const newModel = this.modelRuntime.getModel(provider, modelId);
				if (newModel) {
					await this.piSession.setModel(newModel);
					this.currentModel = changes.model;
				} else {
					warning = `Model ${changes.model} is not available`;
				}
			}
		}
		if (changes.thinkingOption !== undefined && changes.thinkingOption !== null) {
			const level = normalizeThinking(changes.thinkingOption);
			if (level) {
				this.piSession.setThinkingLevel(level);
				this.currentThinking = level;
			}
		}
		return warning;
	}

	getConfigState(): ProviderConfigState {
		return {
			model: this.currentModel,
			mode: "default",
			thinkingOption: this.currentThinking,
			models: this.models,
			modes: [{ id: "default", label: "Default" }],
			thinkingOptions: currentModelThinkingOptions(this.models, this.currentModel, this.currentThinking),
			settings: [],
		};
	}

	async abort(): Promise<void> {
		this.abortRequested = true;
		await this.piSession.abort();
	}

	async dispose(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe();
		if (this.mcpBridge) await this.mcpBridge.dispose();
		this.piSession.dispose();
	}
}

function normalizeThinking(value: string | undefined | null): ThinkingLevel | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return (THINKING_LEVELS as readonly string[]).includes(value) ? (value as ThinkingLevel) : undefined;
}

function currentModelThinkingOptions(
	models: readonly ProviderModel[],
	currentModel: string | undefined,
	currentThinking: ThinkingLevel,
): ProviderThinkingOption[] {
	const model = models.find((m) => m.id === currentModel);
	if (!model?.thinkingOptions || model.thinkingOptions.length === 0) return [];
	return model.thinkingOptions.map((option) => ({
		id: option.id,
		label: option.label,
		isDefault: option.id === currentThinking,
	}));
}

function readStoredSessionFile(persistence: ProviderPersistence | undefined): string | undefined {
	if (!persistence || typeof persistence.data !== "object" || persistence.data === null) return undefined;
	const file = (persistence.data as Record<string, unknown>).sessionFile;
	return typeof file === "string" && file.length > 0 ? file : undefined;
}
