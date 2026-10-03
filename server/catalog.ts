import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import type {
	ProviderCatalog,
	ProviderModel,
	ProviderThinkingOption,
} from "@getpaseo/plugin/server/provider";
import type { PluginSettings, PluginSettingsState } from "@getpaseo/plugin/server";
import type { ProviderEntry, settings } from "../shared/settings.js";
import { writeAgentConfig } from "./config-writer.js";
import { configStamp, externalProviderLabels, hasExternalConfig, queryAvailableModelsFromDir } from "./external-pi.js";
import { agentDir } from "./paths.js";

export type SettingsHandle = PluginSettings<typeof settings.schema>;
export type ReadySettings = Extract<PluginSettingsState<typeof settings.schema>, { status: "ready" }>;

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
function toProviderModels(
	available: ReadonlyArray<{
		provider: string;
		id: string;
		name?: string;
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

// Bump when catalog-building behavior changes: a new key forces the daemon
// to re-fetch the catalog after a plugin upgrade, instead of serving a
// snapshot built by older code.
const CATALOG_KEY_VERSION = 4;

/** Stable cache key over settings content + the external config stamp. */
export function catalogCacheKey(state: ReadySettings): string {
	// The external config stamp makes edits to external pi's auth.json /
	// models.json refresh the catalog without a settings save.
	const external =
		state.values.reuseExternalPi === true ? `ext:${configStamp()}` : "ext:off";
	const hash = createHash("sha256")
		.update(`${CATALOG_KEY_VERSION}:${external}:${JSON.stringify(state.values)}`)
		.digest("hex")
		.slice(0, 16);
	return `providers:${hash}`;
}

// Memoized models list shared by the composer catalog and session config —
// a session open right after a catalog fetch pays no second probe spawn.
// The in-flight slot deduplicates overlapping calls (catalog request racing
// a session open at startup), so only one probe child spawns per key.
let memo: { key: string; models: ProviderModel[] } | null = null;
let inFlight: { key: string; promise: Promise<ProviderModel[]> } | null = null;

async function computeProviderModels(state: ReadySettings): Promise<ProviderModel[]> {
	const providers = activeProvidersFrom(state);
	const reuseExternalPi = state.values.reuseExternalPi === true;
	const hasExternal = reuseExternalPi && hasExternalConfig();

	if (providers.length === 0 && !hasExternal) return [];

	// Generate the merged config (manual + discovery + external) and let a
	// short-lived pi child enumerate it. --offline keeps the child from
	// writing anything; the probe dir is plugin-owned anyway.
	const probeDir = agentDir();
	mkdirSync(probeDir, { recursive: true });
	await writeAgentConfig(probeDir, state.values);
	const available = await queryAvailableModelsFromDir(probeDir);

	// Manual names win over external ones (manual entries override on merge).
	const externalLabels = reuseExternalPi ? await externalProviderLabels() : {};
	const labels = { ...externalLabels, ...providerDisplayNames(providers) };
	return toProviderModels(
		available,
		state.values.defaultThinkingLevel,
		labels,
		resolveAutoProviderIds(externalLabels, providers),
	);
}

/**
 * The mapped models list for the current settings. Memoized on the catalog
 * cache key; sessions reuse this for their config snapshot so the picker and
 * the in-session switcher always agree.
 */
export async function currentProviderModels(settingsHandle: SettingsHandle): Promise<ProviderModel[]> {
	const state = await settingsHandle.read();
	if (state.status !== "ready") return [];
	const key = catalogCacheKey(state);
	if (memo && memo.key === key) return memo.models;
	if (inFlight && inFlight.key === key) return inFlight.promise;

	const promise = computeProviderModels(state)
		.then((models) => {
			memo = { key, models };
			return models;
		})
		.finally(() => {
			if (inFlight?.key === key) inFlight = null;
		});
	inFlight = { key, promise };
	return promise;
}

/** Drops the memo and any in-flight computation — used by tests to force a fresh probe. */
export function resetCatalogMemo(): void {
	memo = null;
	inFlight = null;
}

/**
 * Builds the model catalog the daemon shows in the composer picker. A
 * short-lived pi RPC child enumerates the generated config: pi's built-in
 * catalogs (plus key-gated availability) plus every custom endpoint.
 * `getCatalogCacheKey` on the provider registration invalidates this
 * whenever settings change.
 */
export async function buildProviderCatalog(settingsHandle: SettingsHandle): Promise<ProviderCatalog> {
	const state = await settingsHandle.read();
	const modes = [{ id: "default", label: "Default" }];
	if (state.status !== "ready") return { models: [], modes };

	const models = await currentProviderModels(settingsHandle);
	return {
		models,
		modes,
		defaultModel: models[0]?.id,
		defaultMode: "default",
		defaultThinkingOption: state.values.defaultThinkingLevel,
	};
}
