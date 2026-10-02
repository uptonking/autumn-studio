# Autumn Studio — Paseo Plugin

AI coding agent bundled as a standalone Paseo plugin. Powered by an embedded [Pi](https://github.com/earendil-works/pi) agent running in-process — no external agent binaries required. Install the plugin, add an LLM API key, and the standard Paseo chat UX works out of the box.

## Features

- **Embedded Pi Coding Agent**: Pi runs inside the daemon's plugin subprocess via a
  vendored SDK bundle ( `server/pi-sdk.cjs` ) — no `pi` binary on PATH, no CLI.
- **Multiple LLM Providers**: Configure Anthropic, OpenAI, Google Gemini, DeepSeek, 
  OpenRouter, Groq, Mistral, xAI, Together AI, Fireworks, or any custom
  OpenAI-compatible endpoint (Ollama, vLLM, LM Studio). Models from all enabled
  providers appear in the model picker.
- **Seamless Chat Integration**: Streaming responses, tool cards, thinking blocks, 
  steering, interrupt (reported as canceled), model/thinking switching mid-session, 
  prompt image passthrough, usage, and session restore after daemon restart.
- **Custom endpoint discovery**: OpenAI-compatible endpoints are probed at
`/v1/models` , so their model lists appear in the picker without manual entry.
- **Paseo tool wiring**: Paseo's injected MCP servers are bridged into the embedded
  agent as `mcp__<server>__<tool>` custom tools.
- **Dedicated Sidebar Menu**: The **Autumn Studio** sidebar item (below Schedules)
  opens the settings screen; the same screen is mounted under Settings → Plugins.
- **Isolated configuration**: The embedded agent uses its own agent dir under
`$PASEO_HOME/plugin-data/autumn-studio/` — the user's external `~/.pi/agent` setup is
  never read or written.

## Installation

```bash
# Enable plugins in your Paseo daemon
paseo daemon config set pluginsEnabled true

# Install the Autumn Studio plugin from its directory
paseo plugin install /path/to/autumn-studio
```

## Configuration

1. In Paseo's sidebar, click **Autumn Studio** (below Schedules).
2. Under **General**, verify that **Enable Autumn Studio** is turned on.
3. Under **LLM API Providers**, click **Add provider**:
   - Select your provider type (e.g., Anthropic, OpenAI).
   - Enter your API Key; use **Test connection** to verify it.
   - (Optional) Customize the display name or specify a custom base URL.
4. When creating a new conversation in Paseo, select **Autumn Studio** in the provider
   picker. Models discovered from your configured keys appear in the model list.

## Development

```bash
npm install
npm run typecheck         # tsc --noEmit (needs ../paseo sources)
npm run build:vendor      # rebuild server/pi-sdk.cjs after changing vendor-entry.ts or pi
npm run smoke-test        # evaluate the vendor bundle in the daemon's eval context
npm run integration-test  # real compiler + full provider flow vs a mock LLM (see below)
node scripts/test-compile.mjs <path-to-paseo-repo>   # real Paseo compiler pass
```

The integration test requires the paseo repo to have `npm install` +
`npm run build:client` + `npm run build:server` done. It compiles the plugin with the
real Paseo compiler, serves a mock OpenAI-compatible LLM locally, and drives the
contributed provider through catalog discovery, session open, a real bash-tool turn, 
reasoning + read-tool mapping, interrupt (canceled), usage, persistence, a mid-session
model switch, and history replay after reopen — all under a temp `PASEO_HOME` .

The vendored bundle ( `server/pi-sdk.cjs` ) is checked in. Rebuild it when bumping
`@earendil-works/pi-*` versions. Keep `server/pi-sdk.d.cts` free of external imports —
the Paseo plugin compiler walks type-declaration graphs and pi's published types do not
resolve outside their own tree.

## Directory Structure

```text
autumn-studio/
├── paseo-plugin.json        # Manifest: plugin ID and version requirements (>=0.11.0)
├── package.json             # Dependencies and dev scripts
├── tsconfig.json            # Typecheck config
├── icon.svg                 # Provider picker icon
├── index.server.ts          # Server entry: provider & settings registration
├── index.client.tsx         # Client entry: sidebar navigation & settings screen
├── vendor-entry.ts          # SDK surface list for the vendor build
├── server/
│   ├── pi-sdk.cjs           # Vendored pi SDK + pi-mcp (prebuilt, checked in)
│   ├── pi-sdk.d.cts         # Self-contained structural types for the bundle
│   ├── provider.ts          # ProviderRegistration with embedded capabilities
│   ├── connection.ts        # ProviderConnection protocol implementation
│   ├── catalog.ts           # Dynamic model discovery from configured API keys
│   ├── model-runtime.ts     # Shared ModelRuntime builder from settings entries
│   ├── session.ts           # Embedded pi AgentSession wrapper (MCP, persistence)
│   ├── event-mapper.ts      # Pi stream events → Paseo timeline items (+ replay)
│   ├── mcp-bridge.ts        # Paseo mcpServers → pi custom tools
│   ├── paths.ts             # Plugin data directory helpers
│   └── test-provider.ts     # Settings "Test connection" RPC implementation
├── shared/
│   ├── settings.ts          # Zod settings schema
│   └── rpc.ts               # test-provider RPC contract
├── client/
│   ├── sidebar-item.tsx     # SidebarRow component
│   ├── settings-screen.tsx  # Full-page settings screen
│   ├── general-settings.tsx # Enable toggle, thinking budget, instructions
│   ├── provider-settings.tsx# LLM provider configuration list
│   └── use-debounced-save.ts# Debounced settings saves
└── scripts/
    ├── build-vendor.mjs     # esbuild build of the vendored SDK bundle
    ├── smoke-test-vendor.mjs# Daemon-context evaluation + session smoke test
    └── test-compile.mjs     # Real Paseo compiler end-to-end test
```
