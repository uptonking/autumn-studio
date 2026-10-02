# Autumn Studio — Paseo Plugin

Autonomous AI coding agent bundled as a standalone Paseo plugin. Powered by an embedded [Pi](https://github.com/earendil-works/pi) agent running in-process — no external agent binaries required.

## Features

- **Embedded Pi Coding Agent**: Runs directly inside Paseo with zero setup of external agent CLI tools.
- **Multiple LLM Providers**: Configure Anthropic, OpenAI, Google Gemini, DeepSeek, OpenRouter, Groq, Mistral, xAI, Together AI, Fireworks, or any custom OpenAI-compatible endpoint (Ollama, vLLM, LM Studio).
- **Seamless Chat Integration**: Uses Paseo's built-in chat UI — streaming responses with paced reveal, syntax-highlighted diffs, tool execution cards, thinking blocks, and session management.
- **Dedicated Sidebar Menu**: Quick access via the **Autumn Studio** navigation item in Paseo's sidebar.
- **Host-Scoped Persistence**: Provider credentials and settings persist securely via Paseo's native plugin settings store.

## Installation

```bash
# Enable plugins in your Paseo daemon
paseo daemon config set pluginsEnabled true

# Install the Autumn Studio plugin from its directory
paseo plugin install /path/to/autumn-studio

# Reload the daemon
paseo reload
```

## Configuration

1. In Paseo's sidebar, click **Autumn Studio** (below Schedules).
2. Under **General**, verify that **Enable Autumn Studio** is turned on.
3. Under **LLM API Providers**, click **Add provider**:
   - Select your provider type (e.g., Anthropic, OpenAI).
   - Enter your API Key.
   - (Optional) Customize the display name or specify a custom base URL.
4. When creating a new conversation in Paseo, select **Autumn Studio** in the provider picker. Models discovered from your configured keys will appear in the model list.

## Directory Structure

```text
autumn-studio/
├── paseo-plugin.json      # Manifest: plugin ID and version requirements
├── package.json           # Dependencies
├── tsconfig.json          # TypeScript compilation config
├── icon.svg               # Provider picker icon
├── index.server.ts        # Server entry: provider & settings registration
├── index.client.tsx       # Client entry: sidebar navigation & settings screen
├── shared/
│   └── settings.ts        # Zod settings schema
├── server/
│   ├── provider.ts        # ProviderRegistration with embedded capabilities
│   ├── connection.ts      # ProviderConnection protocol implementation
│   ├── catalog.ts         # Dynamic model discovery from configured API keys
│   ├── session.ts         # In-memory Pi AgentSession wrapper
│   └── event-mapper.ts    # Translates Pi stream events into Paseo timeline items
└── client/
    ├── sidebar-item.tsx   # SidebarRow component
    ├── settings-screen.tsx# Full-page settings screen
    ├── general-settings.tsx # Enable/disable master toggle
    └── provider-settings.tsx# LLM provider configuration list
```
