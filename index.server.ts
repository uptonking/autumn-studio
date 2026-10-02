import type { PluginServerContext } from "@getpaseo/plugin/server";
import { settings } from "./shared/settings.js";
import { testProviderRpc } from "./shared/rpc.js";
import { createAutumnProvider } from "./server/provider.js";
import { testProviderConnection } from "./server/test-provider.js";

export default function contribute(server: PluginServerContext) {
  const settingsHandle = server.registerSettings(settings);
  server.registerProvider(createAutumnProvider(settingsHandle));

  // RPC to test provider API credentials and endpoints from the settings UI
  server.handle(testProviderRpc, async (input) => {
    return await testProviderConnection(input);
  });

  return () => {};
}
