import type {
	ProviderModel,
	ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
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

/** Extracts active (enabled and configured) manual providers. */
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

/**
 * Provider ids whose models are auto-detected (not manually configured):
 * external sources' ids minus the ids/types manual entries registered, since
 * manual entries override external ones on id conflicts.
 */
export function resolveAutoProviderIds(
	externalLabels: Record<string, string>,
	providers: readonly ProviderEntry[],
): Set<string> {
	const manual = new Set<string>();
	for (const entry of providers) {
		manual.add(entry.id);
		manual.add(entry.type);
	}
	return new Set(Object.keys(externalLabels).filter((id) => !manual.has(id)));
}

/** Marks a picker description as auto-detected (text-style eye, renders everywhere). */
const AUTO_MARKER = "\u{1F441}\uFE0E";

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
	autoProviderIds?: ReadonlySet<string>,
): ProviderModel[] {
	return available.map((m) => {
		const providerLabel = providerLabels?.[m.provider] ?? m.provider;
		const auto = autoProviderIds?.has(m.provider) === true;
		return {
			id: `${m.provider}/${m.id}`,
			label: m.name || m.id,
			description: `${auto ? `${AUTO_MARKER} ` : ""}${providerLabel} · ${m.contextWindow ? m.contextWindow.toLocaleString() : "?"} tokens`,
			contextWindowMaxTokens: m.contextWindow,
			thinkingOptions: m.reasoning
				? (THINKING_LEVEL_IDS.map((level) => ({
						id: level,
						label: level.charAt(0).toUpperCase() + level.slice(1),
						isDefault: level === defaultThinkingOptionId,
					})) as ProviderThinkingOption[])
				: undefined,
			defaultThinkingOptionId: m.reasoning ? defaultThinkingOptionId : undefined,
		};
	});
}
