import { useCallback, useState } from "react";
import { Text } from "react-native";
import type { SettingsState, PluginTheme } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import {
  SettingsSection,
  SettingsCard,
  SettingsInput,
  SettingsSelect,
  SettingsSwitch,
  SettingsAction,
  SettingsRow,
} from "@getpaseo/plugin/client/ui";
import type { settings, ProviderEntry } from "../shared/settings.js";
import { testProviderRpc } from "../shared/rpc.js";

type ReadySettings = Extract<
  SettingsState<typeof settings.schema>,
  { status: "ready" }
>;

const PROVIDER_TYPES = [
  { label: "Anthropic", value: "anthropic" },
  { label: "OpenAI", value: "openai" },
  { label: "Google (Gemini)", value: "google" },
  { label: "DeepSeek", value: "deepseek" },
  { label: "OpenRouter", value: "openrouter" },
  { label: "Groq", value: "groq" },
  { label: "Mistral", value: "mistral" },
  { label: "xAI (Grok)", value: "xai" },
  { label: "Together AI", value: "together" },
  { label: "Fireworks AI", value: "fireworks" },
  { label: "Custom (OpenAI-compatible)", value: "custom" },
] as const;

function generateId(): string {
  return `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getBaseUrlPlaceholder(type: string): string {
  switch (type) {
    case "custom":
      return "http://localhost:11434/v1 (Ollama) or proxy URL";
    case "openai":
      return "https://api.openai.com/v1 (leave blank for default)";
    case "anthropic":
      return "https://api.anthropic.com/v1 (leave blank for default)";
    case "google":
      return "https://generativelanguage.googleapis.com (leave blank for default)";
    default:
      return "Custom endpoint URL (optional)";
  }
}

function ProviderEntryEditor({
  entry,
  onUpdate,
  onRemove,
  disabled,
}: {
  entry: ProviderEntry;
  onUpdate: (updated: ProviderEntry) => void;
  onRemove: () => void;
  disabled: boolean;
  theme: PluginTheme;
}) {
  const showBaseUrl = entry.type === "custom" || entry.baseUrl !== "";
  const providerLabel =
    PROVIDER_TYPES.find((t) => t.value === entry.type)?.label ?? "Custom";

  const callTest = useRpc(testProviderRpc);
  const [testState, setTestState] = useState<{
    status: "idle" | "testing" | "success" | "error";
    message?: string;
  }>({ status: "idle" });

  const handleTest = useCallback(async () => {
    setTestState({ status: "testing" });
    try {
      const res = await callTest({
        type: entry.type,
        apiKey: entry.apiKey,
        baseUrl: entry.baseUrl || undefined,
      });
      setTestState({
        status: res.success ? "success" : "error",
        message: res.message,
      });
    } catch (err: any) {
      setTestState({
        status: "error",
        message: err?.message || String(err),
      });
    }
  }, [callTest, entry.type, entry.apiKey, entry.baseUrl]);

  return (
    <SettingsCard>
      <SettingsSelect
        label="Provider type"
        value={entry.type}
        options={[...PROVIDER_TYPES]}
        disabled={disabled}
        onValueChange={(type) => {
          onUpdate({
            ...entry,
            type,
            name: entry.name || (PROVIDER_TYPES.find((t) => t.value === type)?.label ?? ""),
          });
          setTestState({ status: "idle" });
        }}
      />
      <SettingsInput
        label="Display name"
        initialValue={entry.name}
        placeholder={providerLabel}
        disabled={disabled}
        onChangeText={(name) => onUpdate({ ...entry, name: name.trim() })}
      />
      <SettingsInput
        label="API Key"
        initialValue={entry.apiKey}
        placeholder={entry.type === "custom" ? "Optional for local servers" : "Enter API key"}
        secureTextEntry
        disabled={disabled}
        onChangeText={(apiKey) => {
          onUpdate({ ...entry, apiKey: apiKey.trim() });
          setTestState({ status: "idle" });
        }}
      />
      {showBaseUrl ? (
        <SettingsInput
          label="Base URL"
          initialValue={entry.baseUrl}
          placeholder={getBaseUrlPlaceholder(entry.type)}
          disabled={disabled}
          onChangeText={(baseUrl) => {
            onUpdate({ ...entry, baseUrl: baseUrl.trim() });
            setTestState({ status: "idle" });
          }}
        />
      ) : null}
      <SettingsSwitch
        label="Enabled"
        value={entry.enabled}
        disabled={disabled}
        onValueChange={(enabled) => onUpdate({ ...entry, enabled })}
      />
      <SettingsAction
        label={
          testState.status === "testing"
            ? "Testing connection..."
            : testState.status === "success"
            ? `✓ ${testState.message}`
            : testState.status === "error"
            ? `✗ ${testState.message}`
            : "Verify API key & endpoint"
        }
        actionLabel={testState.status === "testing" ? "Testing..." : "Test connection"}
        disabled={disabled || testState.status === "testing" || (!entry.apiKey && entry.type !== "custom")}
        onPress={handleTest}
      />
      <SettingsAction
        label={`Delete ${entry.name || providerLabel}`}
        actionLabel="Remove"
        disabled={disabled}
        onPress={onRemove}
      />
    </SettingsCard>
  );
}

export function ProviderSettings({
  settings,
  theme,
}: {
  settings: ReadySettings;
  theme: PluginTheme;
}) {
  const providers = settings.values.providers;

  const save = useCallback(
    (updated: ProviderEntry[]) => {
      void settings.save(
        { ...settings.values, providers: updated },
        settings.revision,
      );
    },
    [settings],
  );

  const addProvider = useCallback(() => {
    save([
      ...providers,
      {
        id: generateId(),
        name: "Anthropic",
        type: "anthropic",
        apiKey: "",
        baseUrl: "",
        enabled: true,
      },
    ]);
  }, [providers, save]);

  const updateProvider = useCallback(
    (index: number, updated: ProviderEntry) => {
      const next = [...providers];
      next[index] = updated;
      save(next);
    },
    [providers, save],
  );

  const removeProvider = useCallback(
    (index: number) => {
      save(providers.filter((_, i) => i !== index));
    },
    [providers, save],
  );

  return (
    <SettingsSection
      title="LLM API Providers"
      info={
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
          Add your LLM provider API keys. Models from enabled providers
          will appear in the model picker when using Autumn Studio.
        </Text>
      }
    >
      {providers.map((entry, index) => (
        <ProviderEntryEditor
          key={entry.id}
          entry={entry}
          onUpdate={(updated) => updateProvider(index, updated)}
          onRemove={() => removeProvider(index)}
          disabled={settings.saving}
          theme={theme}
        />
      ))}
      <SettingsCard>
        <SettingsAction
          label={
            providers.length === 0
              ? "Add your first LLM provider"
              : "Add another provider"
          }
          actionLabel="Add provider"
          disabled={settings.saving}
          onPress={addProvider}
        />
      </SettingsCard>
      {settings.saveError ? (
        <SettingsCard>
          <SettingsRow label="Save error">
            <Text style={{ color: theme.colors.statusDanger }}>
              {settings.saveError}
            </Text>
          </SettingsRow>
        </SettingsCard>
      ) : null}
    </SettingsSection>
  );
}
