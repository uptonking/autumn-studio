/**
 * Vendor entry: the exact pi SDK surface autumn-studio needs, and nothing more.
 *
 * Imported via direct dist file paths to bypass the package `exports` map,
 * whose "." entry re-exports the interactive TUI and CLI and would pull them
 * into the bundle. Everything reachable from here is core SDK code, plus the
 * MCP client used to bridge Paseo's injected MCP servers.
 *
 * Consumed only by scripts/build-vendor.mjs — excluded from tsconfig.
 */
export { createAgentSession } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js";
export { AgentSession } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js";
export { DefaultResourceLoader } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js";
export { ModelRuntime } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js";
export { SessionManager } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
export { SettingsManager } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js";
export { readStoredCredential } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
export { McpClient } from "./node_modules/@earendil-works/pi-mcp/dist/client.js";
export { StdioTransport } from "./node_modules/@earendil-works/pi-mcp/dist/transports/stdio.js";
export { StreamableHttpTransport } from "./node_modules/@earendil-works/pi-mcp/dist/transports/streamable-http.js";
export { InMemoryCodingAgentModelsStore } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/models-store.js";
