# Autumn Studio — Paseo Plugin

AI coding agent bundled as a standalone Paseo plugin. Powered by an embedded [Pi](https://github.com/earendil-works/pi) agent — no external agent binaries required. Install the plugin, add an LLM API key, and the standard Paseo chat UX works out of the box.

## Features

- **Embedded Pi Coding Agent**: Pi runs inside the daemon's plugin subprocess via a vendored SDK bundle ( `server/pi-sdk.cjs` ) — no `pi` binary on PATH, no CLI.
- **Multiple LLM Providers**: Configure Anthropic, OpenAI, Google Gemini, DeepSeek, 
  OpenRouter, Groq, Mistral, xAI, Together AI, Fireworks, or any custom
  OpenAI-compatible endpoint (Ollama, vLLM, LM Studio). Models from all enabled
  providers appear in the model picker.
- **Seamless Chat Integration**: Streaming responses, tool cards, thinking blocks, 
  steering, interrupt (reported as canceled), model/thinking switching mid-session, 
  prompt image passthrough, usage, and session restore after daemon restart.
- **Reasoning effort control**: The "Default reasoning budget" setting pre-selects the
  reasoning effort in the chatbox model picker; users can pick another effort per chat.
  Custom endpoints opt in per provider with the "Supports reasoning" toggle — pi then
  sends OpenAI-style `reasoning_effort` to the endpoint.
- **Custom endpoint discovery**: OpenAI-compatible endpoints are probed at
`/v1/models` , so their model lists appear in the picker without manual entry.
- **Provider CRUD pages**: The settings page shows the provider list; tapping a row
  (or "Add provider") opens a dedicated editor page with a back control — type, name, 
  key, base URL, reasoning toggle, enable switch, test connection, save, and delete
  live there.
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
3. Under **LLM API Providers**, tap **Add provider** (or tap an existing provider to
   edit it) — this opens the provider editor page:
   - Select your provider type (e.g., Anthropic, OpenAI).
   - Enter your API Key; use **Test connection** to verify it.
   - (Optional) Customize the display name or specify a custom base URL.
   - For custom OpenAI-compatible endpoints, toggle **Supports reasoning** to expose

     reasoning-effort options in the chatbox model picker.

   - Tap **Save** (or **Delete** with confirm) and you return to the list.
4. When creating a new conversation in Paseo, select **Autumn Studio** in the provider
   picker. Models discovered from your configured keys appear in the model list, with
   your configured default reasoning effort pre-selected.

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
model switch, and history replay after reopen — all under a temp `PASEO_HOME` . It also
asserts the reasoning-effort chain end-to-end: the catalog carries the configured
default effort, the session opens at that default, `reasoning_effort` reaches the
endpoint, and a mid-session effort switch takes effect on the next turn. It also
closes a session mid-turn and verifies the close unwinds cleanly, emits nothing for
the dead session, and leaves the connection usable.

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
│   ├── settings-screen.tsx  # General section + provider list; hosts the editor view
│   ├── general-settings.tsx # Enable toggle, thinking budget, instructions
│   ├── provider-list.tsx    # Read-only provider list; rows open the editor
│   ├── provider-editor.tsx  # Full-page create/edit form (back control, save, delete)
│   └── use-debounced-save.ts# Debounced settings saves
└── scripts/
    ├── build-vendor.mjs     # esbuild build of the vendored SDK bundle
    ├── smoke-test-vendor.mjs# Daemon-context evaluation + session smoke test
    └── test-compile.mjs     # Real Paseo compiler end-to-end test
```

## License

[AGPL-3.0](./LICENSE.md)
