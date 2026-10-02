import { useCallback, useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import type { SettingsState } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
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
import { useDebouncedSave } from "./use-debounced-save.js";

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
	theme,
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
		} catch (err) {
			setTestState({
				status: "error",
				message: err instanceof Error ? err.message : String(err),
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
				onChangeText={(name) => onUpdate({ ...entry, name })}
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
	// Local draft list: edits merge here and save debounced, so typing never
	// races the revision-based store and successive keystrokes never clobber
	// each other with a stale snapshot.
	const [draft, setDraft] = useState<ProviderEntry[]>(settings.values.providers);
	const saveDebounced = useDebouncedSave(settings);

	const prevRevision = useRef(settings.revision);
	useEffect(() => {
		if (prevRevision.current !== settings.revision) {
			prevRevision.current = settings.revision;
			setDraft(settings.values.providers);
		}
	}, [settings.revision, settings.values.providers]);

	const updateDraft = useCallback(
		(next: ProviderEntry[]) => {
			setDraft(next);
			saveDebounced({ ...settings.values, providers: next });
		},
		[saveDebounced, settings.values],
	);

	const updateProvider = useCallback(
		(index: number, updated: ProviderEntry) => {
			updateDraft(draft.map((e, i) => (i === index ? updated : e)));
		},
		[draft, updateDraft],
	);

	const addProvider = useCallback(() => {
		updateDraft([
			...draft,
			{
				id: generateId(),
				name: "Anthropic",
				type: "anthropic",
				apiKey: "",
				baseUrl: "",
				enabled: true,
			},
		]);
	}, [draft, updateDraft]);

	const removeProvider = useCallback(
		(index: number) => {
			updateDraft(draft.filter((_, i) => i !== index));
		},
		[draft, updateDraft],
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
			{draft.map((entry, index) => (
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
						draft.length === 0
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
