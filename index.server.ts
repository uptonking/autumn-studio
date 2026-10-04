import type { PluginServerContext } from '@getpaseo/plugin/server';
import { settings } from './shared/settings.js';
import { testProviderRpc, externalProvidersRpc } from './shared/rpc.js';
import { createAutumnProvider } from './server/provider.js';
import { testProviderConnection } from './server/test-provider.js';
import { detectExternalProviders } from './server/external-pi.js';

export default function contribute(server: PluginServerContext) {
  const settingsHandle = server.registerSettings(settings);
  server.registerProvider(createAutumnProvider(settingsHandle));

  // RPC to test provider API credentials and endpoints from the settings UI
  server.handle(testProviderRpc, async (input) => {
    return await testProviderConnection(input);
  });

  // RPC to enumerate the external pi installation's LLM providers for the
  // settings page. Honors the reuse toggle; read-only detection.
  server.handle(externalProvidersRpc, async () => {
    const state = await settingsHandle.read();
    const reuseExternalPi =
      state.status === 'ready' ? state.values.reuseExternalPi : false;
    if (!reuseExternalPi) {
      return { agentDir: '', providers: [] };
    }
    return await detectExternalProviders();
  });

  return () => {};
}
