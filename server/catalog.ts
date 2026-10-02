import type { ProviderCatalog, ProviderModel } from "@getpaseo/plugin/server/provider";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { settings, ProviderEntry } from "../shared/settings.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

type SettingsHandle = PluginSettings<typeof settings.schema>;

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

/**
 * Attempts to discover available models from an OpenAI-compatible /v1/models endpoint.
 */
async function probeRemoteModels(
  baseUrl: string,
  apiKey?: string,
): Promise<string[]> {
  try {
    const base = baseUrl.replace(/\/+$/, "");
    const url = base.endsWith("/models") ? base : `${base}/models`;
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) return [];
    const data = (await res.json()) as any;
    if (Array.isArray(data?.data)) {
      return data.data
        .map((m: any) => (typeof m?.id === "string" ? m.id : null))
        .filter((id): id is string => Boolean(id));
    }
  } catch {
    // Network or parse error: fall back gracefully
  }
  return [];
}

export async function buildCatalog(
  settingsHandle: SettingsHandle,
): Promise<ProviderCatalog> {
  const state = await settingsHandle.read();
  if (state.status !== "ready") {
    return { models: [], modes: [{ id: "default", label: "Default" }] };
  }

  const activeProviders = state.values.providers.filter(
    (p: ProviderEntry) =>
      p.enabled && (p.apiKey.trim().length > 0 || (p.type === "custom" && p.baseUrl.trim().length > 0)),
  );

  if (activeProviders.length === 0) {
    return {
      models: [],
      modes: [{ id: "default", label: "Default" }],
    };
  }

  // Create an isolated ModelRuntime
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  for (const entry of activeProviders) {
    const isCustom = entry.type === "custom" || !KNOWN_TYPES.has(entry.type);

    if (isCustom && entry.baseUrl) {
      const discoveredModelIds = await probeRemoteModels(entry.baseUrl, entry.apiKey);
      const modelDefinitions =
        discoveredModelIds.length > 0
          ? discoveredModelIds.map((id) => ({
              id,
              name: id,
              contextWindow: 65536,
              maxTokens: 8192,
              reasoning: false,
              input: ["text" as const],
            }))
          : [
              {
                id: "default",
                name: `${entry.name || "Custom"} Default Model`,
                contextWindow: 65536,
                maxTokens: 8192,
                reasoning: false,
                input: ["text" as const],
              },
            ];

      runtime.registerProvider(entry.id, {
        name: entry.name || entry.id,
        baseUrl: entry.baseUrl,
        api: "openai-completions",
        models: modelDefinitions,
      });
      await runtime.setRuntimeApiKey(entry.id, entry.apiKey || "dummy-key");
    } else if (KNOWN_TYPES.has(entry.type)) {
      if (entry.baseUrl) {
        runtime.registerProvider(entry.type, {
          baseUrl: entry.baseUrl,
        });
      }
      await runtime.setRuntimeApiKey(entry.type, entry.apiKey);
    }
  }

  // Get available models based on configured keys
  const available = await runtime.getAvailable();

  const defaultThinkingOptionId = state.values.defaultThinkingLevel || "medium";

  const models: ProviderModel[] = available.map((m: any) => ({
    id: `${m.provider}/${m.id}`,
    label: m.name || m.id,
    description: `${m.provider} · ${m.contextWindow ? m.contextWindow.toLocaleString() : "?"} tokens`,
    contextWindowMaxTokens: m.contextWindow,
    thinkingOptions: m.reasoning
      ? [
          { id: "off", label: "Off", isDefault: defaultThinkingOptionId === "off" },
          { id: "low", label: "Low", isDefault: defaultThinkingOptionId === "low" },
          { id: "medium", label: "Medium", isDefault: defaultThinkingOptionId === "medium" },
          { id: "high", label: "High", isDefault: defaultThinkingOptionId === "high" },
        ]
      : undefined,
    defaultThinkingOptionId: m.reasoning ? defaultThinkingOptionId : undefined,
  }));

  return {
    models,
    modes: [{ id: "default", label: "Default" }],
    defaultModel: models[0]?.id,
    defaultMode: "default",
    defaultThinkingOption: defaultThinkingOptionId,
  };
}
