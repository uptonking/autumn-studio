import {
  negotiateProviderCapabilities,
  type ProviderRegistration,
} from '@getpaseo/plugin/server/provider';
import type { PluginSettings } from '@getpaseo/plugin/server';
import type { settings } from '../shared/settings.js';
import { catalogCacheKey } from './catalog.js';
import { createAutumnConnection } from './connection.js';
import { detectExternalProviders } from './external-pi.js';

export type SettingsHandle = PluginSettings<typeof settings.schema>;

const CAPABILITIES = [
  'prompt.message',
  'prompt.command',
  'prompt.image',
  'prompt.steer',
  'session.configure',
  'session.persistence',
] as const;

export function createAutumnProvider(
  settingsHandle: SettingsHandle,
): ProviderRegistration {
  return {
    id: 'autumn-studio',
    label: 'Autumn Studio',
    description: 'Bundled Pi coding agent with your own API keys',
    icon: 'icon.svg',
    // No `command`: the daemon resolves it against PATH and would report the
    // provider unavailable (pi lives in the plugin's node_modules). Spawning
    // happens inside connect() via server/pi-runner.ts instead.

    async getCatalogCacheKey() {
      const state = await settingsHandle.read();
      if (state.status !== 'ready') return 'unconfigured';
      return catalogCacheKey(state);
    },

    async status() {
      const state = await settingsHandle.read();
      if (state.status !== 'ready') {
        return { available: false, diagnostic: 'Settings failed to load.' };
      }
      if (!state.values.enabled) {
        return {
          available: false,
          diagnostic:
            'Autumn Studio is disabled. Enable it in the plugin settings.',
        };
      }
      const hasConfigured = state.values.providers.some(
        (p) =>
          p.enabled &&
          (p.apiKey.trim().length > 0 ||
            (p.type === 'custom' && p.baseUrl.trim().length > 0)),
      );
      if (hasConfigured) {
        return { available: true };
      }
      // No manual entries: external pi providers count as configured too,
      // otherwise the picker would hide a provider whose models exist.
      if (state.values.reuseExternalPi) {
        const external = await detectExternalProviders();
        if (external.providers.length > 0) {
          return { available: true };
        }
        return {
          available: false,
          diagnostic:
            'No LLM providers configured. Add an API key in the Autumn Studio settings, or configure a provider in external Pi (~/.pi/agent).',
        };
      }
      return {
        available: false,
        diagnostic:
          'No LLM providers configured. Add an API key or custom endpoint in the Autumn Studio settings.',
      };
    },

    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new Error('Provider protocol version 1 required');
      }
      const capabilities = negotiateProviderCapabilities(
        request.capabilities,
        CAPABILITIES,
      );
      return createAutumnConnection(capabilities, settingsHandle);
    },
  };
}
