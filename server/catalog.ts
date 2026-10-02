import type { ProviderCatalog } from "@getpaseo/plugin/server/provider";
import type { settings } from "../shared/settings.js";
import {
	buildModelRuntime,
	activeProvidersFrom,
	providerDisplayNames,
	toProviderModels,
	type SettingsHandle,
} from "./model-runtime.js";

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

	if (providers.length === 0) {
		return { models: [], modes };
	}

	const runtime = await buildModelRuntime(providers);
	let available: Parameters<typeof toProviderModels>[0] = [];
	try {
		available = (await runtime.getAvailable()).slice();
	} catch {
		available = [];
	}
	const models = toProviderModels(
		available,
		defaultThinkingOptionId,
		providerDisplayNames(providers),
	);

	return {
		models,
		modes,
		defaultModel: models[0]?.id,
		defaultMode: "default",
		defaultThinkingOption: defaultThinkingOptionId,
	};
}
