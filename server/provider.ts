import { createHash } from "node:crypto";
import {
  negotiateProviderCapabilities,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { settings } from "../shared/settings.js";
import { createAutumnConnection } from "./connection.js";

export type SettingsHandle = PluginSettings<typeof settings.schema>;

const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.steer",
  "session.configure",
  "session.persistence",
] as const;

export function createAutumnProvider(
  settingsHandle: SettingsHandle,
): ProviderRegistration {
  return {
    id: "autumn-studio",
    label: "Autumn Studio",
    description: "Embedded Pi coding agent with your own API keys",
    icon: "icon.svg",
    // No `command` — fully embedded, no external binary needed.

    async getCatalogCacheKey() {
      const state = await settingsHandle.read();
      if (state.status !== "ready") return "unconfigured";
      // Bump when catalog-building behavior changes: a new key forces the
      // daemon to re-fetch the catalog after a plugin upgrade, instead of
      // serving a snapshot built by older code.
      const CATALOG_KEY_VERSION = 2;
      const hash = createHash("sha256")
        .update(`${CATALOG_KEY_VERSION}:${JSON.stringify(state.values)}`)
        .digest("hex")
        .slice(0, 16);
      return `providers:${hash}`;
    },

    async status() {
      const state = await settingsHandle.read();
      if (state.status !== "ready") {
        return { available: false, diagnostic: "Settings failed to load." };
      }
      if (!state.values.enabled) {
        return {
          available: false,
          diagnostic:
            "Autumn Studio is disabled. Enable it in the plugin settings.",
        };
      }
      const hasConfigured = state.values.providers.some(
        (p) =>
          p.enabled &&
          (p.apiKey.trim().length > 0 ||
            (p.type === "custom" && p.baseUrl.trim().length > 0)),
      );
      if (!hasConfigured) {
        return {
          available: false,
          diagnostic:
            "No LLM providers configured. Add an API key or custom endpoint in the Autumn Studio settings.",
        };
      }
      return { available: true };
    },

    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new Error("Provider protocol version 1 required");
      }
      const capabilities = negotiateProviderCapabilities(
        request.capabilities,
        CAPABILITIES,
      );
      return createAutumnConnection(capabilities, settingsHandle);
    },
  };
}
