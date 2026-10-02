import { ModelRuntime } from "./pi-sdk.cjs";
import type { ProviderModel, ProviderThinkingOption } from "@getpaseo/plugin/server/provider";
import type { PluginSettings, PluginSettingsState } from "@getpaseo/plugin/server";
import type { ProviderEntry, settings } from "../shared/settings.js";

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
const PROBE_TIMEOUT_MS = 3000;

/** Cache of /v1/models probes, keyed by `baseUrl|key` — one request per endpoint per process. */
const discoveryCache = new Map<string, string[]>();

/**
 * Discover model ids from an OpenAI-compatible `/v1/models` endpoint.
 * Returns [] on any failure; callers fall back to a static model.
 */
async function probeOpenAiModels(baseUrl: string, apiKey: string | undefined): Promise<string[]> {
	const cacheKey = `${baseUrl}|${apiKey ?? ""}`;
	const cached = discoveryCache.get(cacheKey);
	if (cached) return cached;

	try {
		const base = baseUrl.replace(/\/+$/, "");
		const url = base.endsWith("/models") ? base : `${base}/models`;
		const headers: Record<string, string> = {};
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
		const res = await fetch(url, { headers, signal: controller.signal });
		clearTimeout(timeout);

		if (!res.ok) return [];
		const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
		const ids = Array.isArray(data?.data)
			? data.data
					.map((m) => (typeof m?.id === "string" && m.id.length > 0 ? m.id : null))
					.filter((id): id is string => id !== null)
					.slice(0, MAX_DISCOVERED_MODELS)
			: [];
		if (ids.length > 0) discoveryCache.set(cacheKey, ids);
		return ids;
	} catch {
		return [];
	}
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
 * Custom (OpenAI-compatible) endpoints are registered with the models their
 * `/v1/models` endpoint reports, falling back to a static default model; the
 * model a session open requested is always included so `getModel` resolves.
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
			const modelIds = [...discovered];
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
