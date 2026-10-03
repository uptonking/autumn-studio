import type { ProviderCatalog } from "@getpaseo/plugin/server/provider";
import type { settings } from "../shared/settings.js";
import {
	buildModelRuntime,
	activeProvidersFrom,
	providerDisplayNames,
	resolveAutoProviderIds,
	toProviderModels,
	type SettingsHandle,
} from "./model-runtime.js";
import { externalProviderLabels, hasExternalConfig } from "./external-pi.js";

/**
 * Builds the model catalog the daemon shows in the composer picker: spin up a
 * throwaway ModelRuntime from the configured provider entries, let pi's
 * built-in catalogs (plus key-gated availability) enumerate the models those
 * keys can access. `getCatalogCacheKey` on the provider registration
 * invalidates this whenever settings change.
 */
export async function buildCatalog(settingsHandle: SettingsHandle): Promise<ProviderCatalog> {
	const state = await settingsHandle.read();
	const providers = activeProvidersFrom(state);

	const modes = [{ id: "default", label: "Default" }];
	const defaultThinkingOptionId =
		state.status === "ready" ? state.values.defaultThinkingLevel : "medium";

	const reuseExternalPi = state.status === "ready" ? state.values.reuseExternalPi === true : false;
	const hasExternal = reuseExternalPi && hasExternalConfig();

	if (providers.length === 0 && !hasExternal) {
		return { models: [], modes };
	}

	const runtime = await buildModelRuntime(providers, { reuseExternalPi });
	let available: Parameters<typeof toProviderModels>[0] = [];
	try {
		available = (await runtime.getAvailable()).slice();
	} catch {
		available = [];
	}
	// Manual names win over external ones (manual entries override on merge).
	const externalLabels = reuseExternalPi ? await externalProviderLabels() : {};
	const labels = { ...externalLabels, ...providerDisplayNames(providers) };
	const models = toProviderModels(
		available,
		defaultThinkingOptionId,
		labels,
		resolveAutoProviderIds(externalLabels, providers),
	);

	return {
		models,
		modes,
		defaultModel: models[0]?.id,
		defaultMode: "default",
		defaultThinkingOption: defaultThinkingOptionId,
	};
}
