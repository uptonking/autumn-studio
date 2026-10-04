# Autumn Studio — Paseo Plugin

AI coding agent bundled as a standalone Paseo plugin. Powered by [Pi](https://github.com/earendil-works/pi) — no external agent binaries required. Install the plugin, add an LLM API key, and the familiar Paseo chat UX works out of the box.

## Features

- **Multiple LLM Providers**: Configure Anthropic, OpenAI, Google Gemini, DeepSeek,
  OpenRouter, Groq, Mistral, xAI, Together AI, Fireworks, or any custom
  OpenAI-compatible endpoint (Ollama, vLLM, LM Studio). Models from all enabled
  providers appear in the model picker.
- **Chat integration**: streaming responses, tool cards, thinking blocks,
  steering, interrupt (reported as canceled), model/thinking switching mid-session,
  prompt image passthrough, usage, and session restore after daemon restart.
  Native pi slash commands/skills surface via `session.commands` .
- **Reasoning effort control**: The "Default reasoning effort" setting pre-selects the
  reasoning effort in the chatbox model picker; users can pick another effort per chat.
  Custom endpoints opt in per provider with the "Supports reasoning" toggle — pi then
  sends OpenAI-style `reasoning_effort` to the endpoint.
- **Custom endpoint discovery**: OpenAI-compatible endpoints are probed at
  `/v1/models` , so their model lists appear in the picker without manual entry.
  Successful discoveries are cached to disk and accumulated (a flaky network
  path returning a truncated catalog can never shrink the list), so a slow or
  broken endpoint degrades to the last-known-good list; you can also list models
  manually per entry ("Models" field in the editor) — manual entries always reach
  the picker.
- **Provider CRUD pages**: The settings page shows the provider list; tapping a row
  (or "Add provider") opens a dedicated editor page with a back control — type, name,
  key, base URL, reasoning toggle, enable switch, test connection, save, and delete
  live there.
- **External Pi reuse**: LLM providers already configured for an external pi
  installation ( `~/.pi/agent` `auth.json` + `models.json` ) are auto-detected — their
  models appear in the chatbox picker with zero setup, marked with an eye marker.
- **Dedicated Sidebar Menu**: The **Autumn Studio** sidebar item (below Schedules)
  opens the settings screen; the same screen is mounted under Settings → Plugins.

## Installation

```bash
# Enable plugins in your Paseo daemon
paseo daemon config set pluginsEnabled true

# Install the Autumn Studio plugin from its directory
paseo plugin install /path/to/autumn-studio
```

The manifest build step runs `npm install` (which brings the bundled pi into the
plugin's `node_modules` ) and writes the plugin-root anchor the server uses to
locate its runner script. The anchor is also self-healed at runtime: if it is
missing (e.g. an app-side "reload", which recompiles without running the build
step), the plugin resolves its directory from the daemon's plugin registry in
`$PASEO_HOME/config.json` and rewrites the anchor itself.

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
npm install                        # also installs the git hooks (see below)
npm run typecheck                  # tsc --noEmit
npm run lint                       # oxlint, type-aware
npm run lint:fix                   # oxlint --fix
npm run format                     # oxfmt .
npm run format:check               # oxfmt --check .
npm run integration-test           # real compiler + full provider flow vs a mock LLM (see below)
node scripts/test-compile.ts <path-to-paseo-repo>   # real Paseo compiler pass
```

`typecheck` runs the TypeScript 7 native compiler directly against installed dependencies.
Nothing else depends on `tsc`: Paseo bundles the plugin with esbuild at install/runtime,
and the daemon resolves imports with its own TypeScript.

`oxlint` runs type-aware rules through `oxlint-tsgolint`, which is built on
typescript-go — the same compiler as TypeScript 7. Findings that the current code
deliberately does not satisfy (boundary `any`s, nested ternaries, inline RN styles)
are configured as warnings; `npm run lint` fails only on errors. `LICENSE.md` and
`package-lock.json` are exempt from `oxfmt`.

`npm install` runs `scripts/install-git-hooks.ts`, which installs lefthook's
`pre-commit` hook: `oxfmt --check` and `oxlint` over the staged files, plus a full
`typecheck`. `npm run hooks:install` installs them by hand. The script only touches
this plugin's own checkout and always exits 0 — Paseo runs a plugin's manifest build
steps inside directories it manages and treats a non-zero exit as a failed install,
so hook installation must never be able to fail one.

The integration test requires the paseo repo to have `npm install` +
`npm run build:client` + `npm run build:server` done. It compiles the plugin with the
real Paseo compiler, evaluates the bundle in the daemon-style eval context, serves a
mock OpenAI-compatible LLM locally, and drives the contributed provider through catalog
discovery (real probe children), session opens with real pi children, a bash-tool turn
that proves the session env reaches the child, reasoning + read-tool mapping, interrupt
(canceled), `reasoning_effort` wire checks, usage, persistence, a mid-session model
switch, history replay after reopen, a mid-turn close (silence + no orphans), and
external-reuse end-to-end (external models streaming, external dir untouched) — all
under a temp `PASEO_HOME` .

## How it works

Pi ships inside the plugin as an npm dependency ( `@earendil-works/pi-coding-agent` ). Sessions spawn it as a child process in RPC mode — `node server/pi-runner.ts` (executed natively via Node 22.18+ / 24+ type stripping) resolves pi's bundled RPC entry and speaks newline-delimited JSON over stdio. The same RPC protocol Paseo's built-in Pi provider exercises, so protocol compatibility is pi's problem; upgrading pi is a version bump. There is no `pi` binary on PATH and no CLI: to the user it is 100% Autumn Studio.

- **Sessions**: one pi child per Paseo session. Spawned at `session.open` with the
  session cwd and env, the requested model and thinking level as launch flags
  ( `--provider/--model/--thinking` ), and configured via a per-session agent dir,
  torn down on close (stdin end → SIGTERM → SIGKILL). A launch model the child
  cannot resolve never kills the session: pi 1.0.0 substitutes a synthetic
  model id with a warning, and stricter pi versions exit at launch — the plugin
  detects the failed handshake and respawns without the flags. An orphaned
  child cannot survive: pi's RPC mode exits when its stdin closes, so a dead
  plugin process takes its children with it.
- **Per-session config**: `server/config-writer.ts` generates `auth.json` (credentials), `models.json` (custom endpoints + models), and `mcp.json` (Paseo's injected MCP servers — pi reads them from the agent dir) into `agent-dirs/<sessionId>/` under the plugin data tree. Files are 0600.
- **Catalog**: the merged config (manual entries ∪ `/v1/models` discovery ∪ external reuse) is written to a shared probe dir and enumerated by a short-lived pi child (`get_available_models`), memoized on the catalog cache key.
- **Zero external writes by construction**: external detection probes a throwaway copy of `~/.pi/agent` — pi persists provider-catalog state (`models-store.json`) into its agent dir even offline, so the real dir is never pointed at. The one sanctioned write-back is OAuth token refresh: sessions work on a private copy and `syncAuthBackToExternal` propagates rotations on a clean close (external pi wins if it wrote the file meanwhile).
- **Isolation from project leakage**: children run with `--no-approve`, so project-local `.pi` extensions/resources never load; agent-dir config (our generated files) is unaffected.

## License

[AGPL-3.0](./LICENSE.md)
