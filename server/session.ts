import { mkdirSync } from "node:fs";
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
import type { AutumnSettings } from "../shared/settings.js";
import { sessionAgentDir, runnerScriptPath, sessionsDir } from "./paths.js";
import { RpcProcess } from "./rpc-process.js";
import { syncAuthBackToExternal, writeAgentConfig } from "./config-writer.js";
import { mapPiRpcEvents, mapReplayEntries } from "./event-mapper.js";
import { currentProviderModels } from "./catalog.js";
import type { PiSessionEntry, PiSessionState, PiSlashCommand } from "./pi-rpc-types.js";

export type SettingsHandle = import("@getpaseo/plugin/server").PluginSettings<typeof settings.schema>;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface PromptImage {
	type: "image";
	data: string;
	mimeType: string;
}

type TurnOutcome = { state: "completed" | "failed" | "canceled"; error?: string };

const HANDSHAKE_TIMEOUT_MS = 30000;

/** Values used when the settings document is invalid: an empty, disabled config. */
const EMPTY_VALUES: AutumnSettings = {
	enabled: false,
	reuseExternalPi: false,
	defaultThinkingLevel: "medium",
	customInstructions: "",
	providers: [],
};

/**
 * One Paseo provider session = one pi child process in RPC mode. The child
 * runs the pi bundled in the plugin's node_modules via server/pi-runner.mjs,
 * reads generated config from a per-session agent dir (manual providers,
 * /v1/models discovery, optional external-pi reuse, Paseo MCP servers), and
 * speaks newline-delimited JSON over stdio. The user's external `~/.pi/agent`
 * is never the child's agent dir; rotated OAuth tokens are copied back on a
 * clean close or a crash (see syncAuthBackToExternal).
 */
export class PiRpcSession {
	private readonly sessionId: string;
	private readonly proc: RpcProcess;
	private readonly detach: () => void;
	private readonly activeTurnRef: { current: string | null };
	private readonly models: ProviderModel[];
	private readonly externalAuth: { authJson: string; stamp: string } | null;
	private readonly reuseExternalPi: boolean;
	private abortRequested = false;
	private currentModel: string | undefined;
	private currentThinking: ThinkingLevel;
	private sessionFile: string | undefined;
	private closed = false;
	private turnWaiter: { resolve: (outcome: TurnOutcome) => void } | null = null;
	private lastAgentEnd: { aborted: boolean; errorMessage?: string } | null = null;

	private constructor(
		sessionId: string,
		proc: RpcProcess,
		detach: () => void,
		activeTurnRef: { current: string | null },
		models: ProviderModel[],
		state: PiSessionState,
		requestedModel: string | undefined,
		externalAuth: { authJson: string; stamp: string } | null,
		reuseExternalPi: boolean,
	) {
		this.sessionId = sessionId;
		this.proc = proc;
		this.detach = detach;
		this.activeTurnRef = activeTurnRef;
		this.models = models;
		this.sessionFile = state.sessionFile;
		this.currentModel = state.model
			? `${state.model.provider}/${state.model.id}`
			: requestedModel;
		this.currentThinking = state.thinkingLevel;
		this.externalAuth = externalAuth;
		this.reuseExternalPi = reuseExternalPi;
	}

	static async create(
		sessionId: string,
		config: ProviderSessionConfig,
		persistence: ProviderPersistence | undefined,
		settingsHandle: SettingsHandle,
		emit: (event: ProviderEvent) => void,
	): Promise<PiRpcSession> {
		const state = await settingsHandle.read();
		const values = state.status === "ready" ? state.values : EMPTY_VALUES;
		const reuseExternalPi = values.reuseExternalPi === true;

		// 1. Per-session agent dir with the generated config. Per-session (not
		// shared) because MCP servers are per-session and pi 1.0.0 reads them
		// from mcp.json in the agent dir — no --mcp-config flag exists.
		const agentDir = sessionAgentDir(sessionId);
		const configResult = await writeAgentConfig(agentDir, values, {
			mcpServers: config.mcpServers,
			requestModel: config.model,
		});

		// 2. Spawn the bundled pi in RPC mode. The runner adds --mode rpc; the
		// explicit PI_CODING_AGENT_DIR override keeps any inherited value from
		// leaking in and is deliberately applied after config.env.
		mkdirSync(sessionsDir(), { recursive: true });
		const appendPrompts: string[] = [];
		if (config.systemPrompt?.trim()) appendPrompts.push(config.systemPrompt.trim());
		if (values.customInstructions.trim()) appendPrompts.push(values.customInstructions.trim());
		const requestedThinking =
			normalizeThinking(config.thinkingOption) ??
			normalizeThinking(values.defaultThinkingLevel) ??
			"medium";
		const storedFile = readStoredSessionFile(persistence);
		const baseArgs = ["--no-approve", "--session-dir", sessionsDir()];
		for (const prompt of appendPrompts) baseArgs.push("--append-system-prompt", prompt);
		if (storedFile) baseArgs.push("--session", storedFile);
		// Model and thinking at launch (like the built-in provider), so the
		// session boots with the right state. pi exits when a launch model
		// pattern doesn't resolve — the handshake fallback below covers that.
		const launchArgs: string[] = [];
		if (config.model) {
			const [provider, modelId] = config.model.split("/", 2);
			if (provider && modelId) {
				launchArgs.push("--provider", provider, "--model", modelId);
			} else {
				launchArgs.push("--model", config.model);
			}
		}
		launchArgs.push("--thinking", requestedThinking);

		const spawnChild = (extraArgs: string[]): RpcProcess =>
			new RpcProcess({
				command: process.execPath,
				args: [runnerScriptPath(), ...baseArgs, ...extraArgs],
				cwd: config.cwd,
				env: { ...config.env, PI_CODING_AGENT_DIR: agentDir },
			});

		const handshake = async (target: RpcProcess): Promise<void> => {
			// get_state answers once the session is up — the de-facto handshake.
			await target.request<PiSessionState>({ type: "get_state" }, HANDSHAKE_TIMEOUT_MS);
			await target.request({ type: "set_thinking_level", level: requestedThinking });
		};

		let proc = spawnChild(launchArgs);
		try {
			await handshake(proc);
		} catch (firstError) {
			await proc.close().catch(() => {});
			// Stale-catalog fallback: pi exits(1) when the launch model pattern
			// no longer resolves in the child's view (external config changed
			// between catalog build and session open). Respawn without launch
			// model/thinking so the session still opens on pi's default; the
			// post-handshake RPCs reapply whatever resolves. A child that exits
			// early rejects fast, so this costs nothing in the healthy path.
			if (config.model) {
				proc = spawnChild([]);
				try {
					await handshake(proc);
				} catch (secondError) {
					await proc.close().catch(() => {});
					throw secondError;
				}
			} else {
				throw firstError;
			}
		}
		const piState = await proc.request<PiSessionState>({ type: "get_state" }, HANDSHAKE_TIMEOUT_MS);
		if (config.model) {
			const [provider, modelId] = config.model.split("/", 2);
			if (provider && modelId) {
				// No-op when the launch flag already applied it; the recovery
				// path for a fallback spawn where the model resolves via RPC.
				await proc.request({ type: "set_model", provider, modelId }).catch(() => {});
			}
		}

		// 3. Subscribe the timeline mapper and the child-death handler once the
		// surviving child is known. pi emits no timeline events before the
		// first prompt, so nothing is lost by subscribing post-handshake — and
		// a fallback respawn means the first child must not be subscribed at
		// all (its listeners would die with it, unused).
		const activeTurnRef: { current: string | null } = { current: null };
		const unsubscribeEvents = mapPiRpcEvents(sessionId, proc, emit, () => activeTurnRef.current);
		const detach = () => {
			unsubscribeEvents();
		};

		// 4. Snapshot the selectable models once; the composer's in-session
		// model switcher reads them from session.config. Memoized on the
		// catalog cache key — a session open right after a catalog fetch is free.
		const models = await currentProviderModels(settingsHandle);

		const session = new PiRpcSession(
			sessionId,
			proc,
			detach,
			activeTurnRef,
			models,
			piState,
			config.model,
			configResult.externalAuth,
			reuseExternalPi,
		);

		// Child death marks the session dead: the daemon reopens it from
		// persistence on the next prompt (session.runtime_failed contract).
		proc.onExit((error) => session.crash(error, emit));
		// Turn lifecycle rides the same event stream as the timeline mapper.
		proc.onEvent((event) => session.handleAgentEvent(event));

		return session;
	}

	/**
	 * Crash path. Beyond marking the session dead, a crashed child may still
	 * have completed an OAuth token rotation before dying — some providers
	 * invalidate the prior refresh token on rotation, so the write-back is
	 * not optional bookkeeping but the difference between external pi's
	 * stored credentials staying valid or breaking. The corrupt-file guard in
	 * syncAuthBackToExternal covers a crash mid-write.
	 */
	private crash(error: Error, emit: (event: ProviderEvent) => void): void {
		if (this.closed) return;
		this.closed = true;
		this.settleCurrentTurn({ state: "failed", error: error.message });
		emit({
			type: "session.runtime_failed",
			sessionId: this.sessionId,
			error: { message: error.message },
		});
		syncAuthBackToExternal(sessionAgentDir(this.sessionId), this.externalAuth, this.reuseExternalPi);
	}

	/** Paseo-side persistence handle: the pi session file path for restore. */
	getPersistence(): ProviderPersistence {
		return {
			version: 1,
			data: {
				sessionFile: this.sessionFile ?? null,
				nativeSessionId: this.sessionId,
			},
		};
	}

	/** Replayed timeline items for `session.open` with history "replay". */
	async replayHistory(): Promise<ProviderEvent[]> {
		try {
			const res = await this.proc.request<{ entries: PiSessionEntry[] }>({ type: "get_entries" });
			return mapReplayEntries(res.entries ?? []).map((item) => ({
				type: "timeline.item" as const,
				sessionId: this.sessionId,
				item,
			}));
		} catch {
			return [];
		}
	}

	/** Native pi slash commands (skills, prompt commands) for the composer. */
	async getCommands(): Promise<Array<{ name: string; description: string }>> {
		try {
			const res = await this.proc.request<{ commands: PiSlashCommand[] }>({ type: "get_commands" });
			return (res.commands ?? []).map((command) => ({
				name: command.name,
				description: command.description ?? command.name,
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
		// A closed session emits nothing — the daemon already saw session.closed.
		if (this.closed) return;

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
				await this.proc.request({
					type: "steer",
					message: text,
					...(images.length > 0 ? { images } : {}),
				});
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

		// The daemon serializes prompts per session; a second non-steer prompt
		// during an active turn would corrupt turn bookkeeping (one waiter per
		// turn), so it fails fast instead of hanging.
		if (this.turnWaiter) {
			emit({
				type: "session.prompt_result",
				sessionId: this.sessionId,
				clientMessageId,
				result: { type: "failed", error: { message: "A turn is already in progress" } },
			});
			return;
		}

		const turnId = `turn-${Date.now()}`;
		this.activeTurnRef.current = turnId;
		this.abortRequested = false;
		this.lastAgentEnd = null;

		// Registered before the request is written: pi may deliver the prompt
		// response and the first agent events in the same stdout chunk, and the
		// waiter must exist when the agent_end handler runs.
		const outcomePromise = new Promise<TurnOutcome>((resolve) => {
			this.turnWaiter = { resolve };
		});

		emitUserMessage();
		emit({
			type: "session.prompt_result",
			sessionId: this.sessionId,
			clientMessageId,
			result: { type: "turn", turnId },
		});
		emit({ type: "session.turn", sessionId: this.sessionId, turnId, state: "started" });

		try {
			const result = await this.proc.request<{ disposition: string }>({
				type: "prompt",
				message: text,
				...(images.length > 0 ? { images } : {}),
			});
			if (this.closed) return;

			if (result?.disposition === "handled") {
				// Slash command executed without an agent turn.
				this.settleCurrentTurn({ state: "completed" });
				return;
			}

			// "started" | "queued" — the agent settles via agent_end/agent_settled.
			const outcome = await outcomePromise;
			if (this.closed) return;
			void this.refreshState();
			emit({
				type: "session.turn",
				sessionId: this.sessionId,
				turnId,
				state: outcome.state,
				error: outcome.error ? { message: outcome.error } : undefined,
			});
		} catch (error) {
			if (this.closed) return;
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
			this.turnWaiter = null;
		}
	}

	/**
	 * Turn lifecycle over the raw event stream: agent_end with willRetry
	 * falsy completes the turn; willRetry true defers to agent_settled (the
	 * auto-retry loop is still working). Outcome derives from the last
	 * assistant message's stopReason/errorMessage, mirroring the built-in
	 * provider's mapping.
	 */
	private handleAgentEvent(event: Record<string, unknown>): void {
		if (event.type === "agent_end") {
			const messages = Array.isArray(event.messages) ? (event.messages as Array<Record<string, unknown>>) : [];
			const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
			this.lastAgentEnd = {
				aborted: lastAssistant?.stopReason === "aborted",
				errorMessage: typeof lastAssistant?.errorMessage === "string" ? lastAssistant.errorMessage : undefined,
			};
			if (event.willRetry === undefined || event.willRetry === false) {
				this.finishTurn();
			}
			return;
		}
		if (event.type === "agent_settled") {
			this.finishTurn();
		}
	}

	private finishTurn(): void {
		if (!this.turnWaiter) return;
		const end = this.lastAgentEnd;
		this.lastAgentEnd = null;
		if (end?.aborted || this.abortRequested) {
			this.settleCurrentTurn({ state: "canceled" });
		} else if (end?.errorMessage) {
			this.settleCurrentTurn({ state: "failed", error: end.errorMessage });
		} else {
			this.settleCurrentTurn({ state: "completed" });
		}
	}

	private settleCurrentTurn(outcome: TurnOutcome): void {
		const waiter = this.turnWaiter;
		this.turnWaiter = null;
		waiter?.resolve(outcome);
	}

	private async refreshState(): Promise<void> {
		try {
			const state = await this.proc.request<PiSessionState>({ type: "get_state" });
			if (this.closed) return;
			if (state.sessionFile) this.sessionFile = state.sessionFile;
			if (state.model) this.currentModel = `${state.model.provider}/${state.model.id}`;
			this.currentThinking = state.thinkingLevel;
		} catch {
			// A failed refresh only means stale metadata.
		}
	}

	/** Applies config changes. Returns a user-facing warning when nothing changed. */
	async configure(changes: ProviderConfigChanges): Promise<string | undefined> {
		// A dead session takes no configuration; callers still get their
		// session.config echo without an exception escaping into dispatch.
		if (this.closed) return undefined;
		let warning: string | undefined;
		if (changes.model !== undefined && changes.model !== null) {
			const [provider, modelId] = changes.model.split("/", 2);
			if (provider && modelId) {
				try {
					await this.proc.request({ type: "set_model", provider, modelId });
					this.currentModel = changes.model;
				} catch (error) {
					const cause = error instanceof Error ? error.message : String(error);
					warning = `Model ${changes.model} could not be applied: ${cause}`;
				}
			}
		}
		if (changes.thinkingOption !== undefined && changes.thinkingOption !== null) {
			const level = normalizeThinking(changes.thinkingOption);
			if (level) {
				try {
					await this.proc.request({ type: "set_thinking_level", level });
					this.currentThinking = level;
				} catch {
					// A failed effort change is silent — the next get_state
					// refresh reports what pi actually has.
				}
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
		await this.proc.request({ type: "abort" }, 10000);
	}

	async dispose(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.detach();
		// Unblock a pending prompt() if a turn is still open; it sees closed
		// and emits nothing for a session the daemon already closed.
		this.settleCurrentTurn({ state: "canceled" });
		// Best-effort unwind of an active turn before shutdown.
		if (this.activeTurnRef.current) {
			try {
				await Promise.race([
					this.proc.request({ type: "abort" }, 3000),
					new Promise((resolve) => setTimeout(resolve, 2000)),
				]);
			} catch {}
		}
		await this.proc.close();
		syncAuthBackToExternal(sessionAgentDir(this.sessionId), this.externalAuth, this.reuseExternalPi);
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
