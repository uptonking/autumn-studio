import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "./pi-sdk.cjs";
import type { ProviderModel, ProviderThinkingOption } from "@getpaseo/plugin/server/provider";
import type { PluginSettings, PluginSettingsState } from "@getpaseo/plugin/server";
import type { ProviderEntry, settings } from "../shared/settings.js";
import { pluginDataDir } from "./paths.js";

export type SettingsHandle = PluginSettings<typeof settings.schema>;

const KNOWN_TYPES = new Set([
	"amazon-bedrock",
	"anthropic",
	"azure-openai-responses",
	"cerebras",
	"cloudflare-ai-gateway",
	"deepseek",
	"fireworks",
	"google",
	"groq",
	"mistral",
	"moonshotai",
	"openai",
	"openrouter",
	"together",
	"xai",
	"zai",
]);

export function isKnownProviderType(type: string): boolean {
	return KNOWN_TYPES.has(type);
}

/** Zero rates: custom endpoints have unknown pricing; pi computes cost 0. */
const UNKNOWN_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const DEFAULT_CUSTOM_MODEL_ID = "default";
const MAX_DISCOVERED_MODELS = 200;
const PROBE_TIMEOUT_MS = 6000;

/** In-process cache of successful /v1/models probes, keyed by baseUrl. */
const discoveryCache = new Map<string, string[]>();

/** Last-known-good discovery results, keyed by baseUrl, persisted in the plugin data dir. */
const DISCOVERY_CACHE_FILE = "discovery-cache.json";

function readPersistedDiscovery(baseUrl: string): string[] {
	try {
		const file = join(pluginDataDir(), DISCOVERY_CACHE_FILE);
		const doc = JSON.parse(readFileSync(file, "utf8")) as { endpoints?: Record<string, string[]> };
		return doc.endpoints?.[baseUrl] ?? [];
	} catch {
		return [];
	}
}

const MAX_PERSISTED_MODELS = 500;

/**
 * Merge discovered ids into the persisted known-good set. Merging (not
 * replacing) means a flaky network path that returns a truncated catalog
 * can never wipe models that previously discovered fine; genuinely removed
 * upstream models linger but fail with a clear API error when used.
 */
function writePersistedDiscovery(baseUrl: string, modelIds: string[]): void {
	try {
		const dir = pluginDataDir();
		mkdirSync(dir, { recursive: true });
		const file = join(dir, DISCOVERY_CACHE_FILE);
		let doc: { endpoints?: Record<string, string[]> } = {};
		try {
			doc = JSON.parse(readFileSync(file, "utf8"));
		} catch {}
		doc.endpoints ??= {};
		doc.endpoints[baseUrl] = [...new Set([...(doc.endpoints[baseUrl] ?? []), ...modelIds])].slice(
			0,
			MAX_PERSISTED_MODELS,
		);
		writeFileSync(file, JSON.stringify(doc, null, 1));
	} catch {
		// The cache is an optimization; failures are invisible.
	}
}

/**
 * Discover model ids from an OpenAI-compatible `/v1/models` endpoint.
 *
 * Ordering on failure: in-process cache → persisted last-known-good list →
 * []. Callers layer the entry's manual models on top, so a broken or hanging
 * discovery endpoint degrades to the user's manual list instead of wiping it.
 */
async function probeOpenAiModels(baseUrl: string, apiKey: string | undefined): Promise<string[]> {
	const cached = discoveryCache.get(baseUrl);
	if (cached) return cached;

	const base = baseUrl.replace(/\/+$/, "");
	const url = base.endsWith("/models") ? base : `${base}/models`;
	const headers: Record<string, string> = {};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

	// Two attempts: flaky local network paths (VPN/TUN fake-IP setups) reset
	// connections sporadically, and a second attempt usually gets through.
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
			const res = await fetch(url, { headers, signal: controller.signal });
			clearTimeout(timeout);

			if (!res.ok) break;
			const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
			const ids = Array.isArray(data?.data)
				? data.data
						.map((m) => (typeof m?.id === "string" && m.id.length > 0 ? m.id : null))
						.filter((id): id is string => id !== null)
						.slice(0, MAX_DISCOVERED_MODELS)
				: [];
			if (ids.length > 0) {
				// The effective known-good set accumulates: a flaky network
				// path returning a truncated catalog can never shrink it.
				const merged = [...new Set([...ids, ...readPersistedDiscovery(baseUrl)])].slice(
					0,
					MAX_DISCOVERED_MODELS,
				);
				discoveryCache.set(baseUrl, merged);
				writePersistedDiscovery(baseUrl, merged);
				return merged;
			}
			break;
		} catch {
			// Retry once, then fall through to the persisted known-good list.
		}
	}
	return readPersistedDiscovery(baseUrl);
}

function customModelDefinition(id: string, reasoning: boolean) {
	return {
		id,
		name: id,
		contextWindow: 65536,
		maxTokens: 8192,
		reasoning,
		// Claim image input: prompt images pass through as OpenAI-style image
		// parts, and endpoints that can't accept them fail with a clear error
		// the agent relays. Pretending text-only would hard-block capable ones.
		input: ["text", "image"] as ("text" | "image")[],
		cost: UNKNOWN_COST,
	};
}

export interface BuildModelRuntimeOptions {
	/** Full catalog id ("provider/model") of the model a session open requested, if any. */
	requestModel?: string;
}

/**
 * Build an isolated ModelRuntime from the plugin's configured provider
 * entries. Reads no user-owned pi configuration: no models.json, no auth
 * storage, no network catalog refresh. Keys come from plugin settings only.
 *
 * Custom (OpenAI-compatible) endpoints are registered with the union of the
 * entry's manual model list and whatever `/v1/models` discovery returns
 * (in-process cache, then persisted last-known-good on failure); the static
 * default model appears only when both are empty. The model a session open
 * requested is always included so `getModel` resolves.
 */
export async function buildModelRuntime(
	providers: readonly ProviderEntry[],
	options: BuildModelRuntimeOptions = {},
): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});

		for (const entry of providers) {
			const isCustom = entry.type === "custom" || !KNOWN_TYPES.has(entry.type);
			if (isCustom && entry.baseUrl) {
				const [requestProvider, requestModelId] = options.requestModel?.split("/", 2) ?? [];
				const requestedHere = requestProvider === entry.id && requestModelId;

				const discovered = await probeOpenAiModels(entry.baseUrl, entry.apiKey || undefined);
				// Manual entries beat discovery: a user-listed model is registered
				// even when the endpoint's /v1/models is broken, slow, or hangs.
				const modelIds = [...new Set([...(entry.models ?? []), ...discovered])];
				if (modelIds.length === 0) modelIds.push(DEFAULT_CUSTOM_MODEL_ID);
				if (requestedHere && !modelIds.includes(requestModelId)) {
					modelIds.push(requestModelId);
				}

				runtime.registerProvider(entry.id, {
					name: entry.name || entry.id,
					baseUrl: entry.baseUrl,
					api: "openai-completions",
					// reasoning: true makes pi's OpenAI-completions adapter send
					// reasoning_effort for low/medium/high and omit it for off.
					models: modelIds.map((id) => customModelDefinition(id, entry.reasoning === true)),
				});
				await runtime.setRuntimeApiKey(entry.id, entry.apiKey || "dummy-key");
			} else if (KNOWN_TYPES.has(entry.type)) {
			if (entry.baseUrl) {
				runtime.registerProvider(entry.type, { baseUrl: entry.baseUrl });
			}
			await runtime.setRuntimeApiKey(entry.type, entry.apiKey);
		}
	}

	return runtime;
}

/** Provider entries that can produce a usable model (enabled with key or URL). */
export function activeProvidersFrom(
	state: PluginSettingsState<typeof settings.schema>,
): ProviderEntry[] {
	if (state.status !== "ready") return [];
	return state.values.providers.filter(
		(p) =>
			p.enabled &&
			(p.apiKey.trim().length > 0 || (p.type === "custom" && p.baseUrl.trim().length > 0)),
	);
}

/** Entry-id → display name, so catalog rows say "aichorouter" not "provider-1728…". */
export function providerDisplayNames(
	providers: readonly ProviderEntry[],
): Record<string, string> {
	const labels: Record<string, string> = {};
	for (const entry of providers) {
		labels[entry.id] = entry.name || entry.id;
		labels[entry.type] = entry.name || entry.type;
	}
	return labels;
}

/** Pi's agent-level thinking levels a reasoning model can be set to. */
export const THINKING_LEVEL_IDS = ["off", "low", "medium", "high"] as const;

/** Shared catalog mapping for the composer picker and the in-session switcher. */
export function toProviderModels(
	available: ReadonlyArray<{
		provider: string;
		id: string;
		name: string;
		contextWindow?: number;
		reasoning?: boolean;
	}>,
	defaultThinkingOptionId?: string,
	providerLabels?: Record<string, string>,
): ProviderModel[] {
	return available.map((m) => ({
		id: `${m.provider}/${m.id}`,
		label: m.name || m.id,
		description: `${providerLabels?.[m.provider] ?? m.provider} · ${m.contextWindow ? m.contextWindow.toLocaleString() : "?"} tokens`,
		contextWindowMaxTokens: m.contextWindow,
		thinkingOptions: m.reasoning
			? (THINKING_LEVEL_IDS.map((level) => ({
					id: level,
					label: level.charAt(0).toUpperCase() + level.slice(1),
					isDefault: level === defaultThinkingOptionId,
				})) as ProviderThinkingOption[])
			: undefined,
		defaultThinkingOptionId: m.reasoning ? defaultThinkingOptionId : undefined,
	}));
}
