import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { SettingsState } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import {
	SettingsAction,
	SettingsCard,
	SettingsInput,
	SettingsSelect,
	SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import type { ProviderEntry, settings } from "../shared/settings.js";
import { testProviderRpc } from "../shared/rpc.js";

type ReadySettings = Extract<
	SettingsState<typeof settings.schema>,
	{ status: "ready" }
>;

export const PROVIDER_TYPES = [
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

const KNOWN_TYPE_VALUES = new Set<string>(
	PROVIDER_TYPES.map((t) => t.value).filter((v) => v !== "custom"),
);

export function isCustomType(type: string): boolean {
	return type === "custom" || !KNOWN_TYPE_VALUES.has(type);
}

export function providerTypeLabel(type: string): string {
	return PROVIDER_TYPES.find((t) => t.value === type)?.label ?? "Custom (OpenAI-compatible)";
}

export function providerDisplayName(entry: ProviderEntry): string {
	return entry.name.trim() || providerTypeLabel(entry.type);
}

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
			return "Custom endpoint URL (leave blank for default)";
	}
}

/**
 * Full-page create/edit form for one LLM provider entry. Opened from the
 * provider list; the back control at the top-left returns without saving —
 * only "Save" writes, and it writes the whole settings document against the
 * revision currently displayed.
 */
export function ProviderEditor({
	settings,
	theme,
	layout,
	entry,
	onClose,
}: {
	settings: ReadySettings;
	theme: PluginTheme;
	layout: { compact: boolean };
	/** Existing entry to edit, or null to create one. */
	entry: ProviderEntry | null;
	onClose(): void;
}) {
	const [draft, setDraft] = useState<ProviderEntry>(
		() =>
			entry ?? {
				id: "",
				name: "",
				type: "anthropic",
				apiKey: "",
				baseUrl: "",
				reasoning: false,
				enabled: true,
			},
	);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const [testState, setTestState] = useState<{
		status: "idle" | "testing" | "success" | "error";
		message?: string;
	}>({ status: "idle" });

	// Auto-reset delete confirmation after 4 seconds
	useEffect(() => {
		if (!confirmDelete) return;
		const timer = setTimeout(() => setConfirmDelete(false), 4000);
		return () => clearTimeout(timer);
	}, [confirmDelete]);

	// Auto-reset discard confirmation after 4 seconds
	useEffect(() => {
		if (!confirmDiscard) return;
		const timer = setTimeout(() => setConfirmDiscard(false), 4000);
		return () => clearTimeout(timer);
	}, [confirmDiscard]);

	const patch = useCallback((partial: Partial<ProviderEntry>) => {
		setDraft((prev) => ({ ...prev, ...partial }));
	}, []);

	const isCustom = isCustomType(draft.type);
	const needsBaseUrl = isCustom;
	const missingKey = !isCustom && draft.apiKey.trim().length === 0;
	const missingBaseUrl = needsBaseUrl && draft.baseUrl.trim().length === 0;
	const canSave = !missingKey && !missingBaseUrl;

	const isDirty = useMemo(() => {
		if (!entry) {
			return (
				draft.name.trim().length > 0 ||
				draft.type !== "anthropic" ||
				draft.apiKey.trim().length > 0 ||
				draft.baseUrl.trim().length > 0 ||
				draft.reasoning !== false ||
				!draft.enabled
			);
		}
		return (
			draft.name !== entry.name ||
			draft.type !== entry.type ||
			draft.apiKey !== entry.apiKey ||
			draft.baseUrl !== entry.baseUrl ||
			draft.reasoning !== (entry.reasoning ?? false) ||
			draft.enabled !== entry.enabled
		);
	}, [draft, entry]);

	const handleBack = useCallback(() => {
		if (isDirty && !confirmDiscard) {
			setConfirmDiscard(true);
			return;
		}
		onClose();
	}, [confirmDiscard, isDirty, onClose]);

	const callTest = useRpc(testProviderRpc);
	const handleTest = useCallback(async () => {
		setTestState({ status: "testing" });
		try {
			const res = await callTest({
				type: draft.type,
				apiKey: draft.apiKey.trim(),
				baseUrl: draft.baseUrl.trim() || undefined,
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
	}, [callTest, draft.type, draft.apiKey, draft.baseUrl]);

	const handleSave = useCallback(async () => {
		if (!canSave || settings.saving) return;
		const clean: ProviderEntry = {
			id: draft.id || generateId(),
			name: draft.name.trim(),
			type: draft.type,
			apiKey: draft.apiKey.trim(),
			baseUrl: draft.baseUrl.trim(),
			reasoning: isCustom ? draft.reasoning : false,
			enabled: draft.enabled,
		};
		const providers = entry
			? settings.values.providers.map((p) => (p.id === entry.id ? clean : p))
			: [...settings.values.providers, clean];
		const ok = await settings.save({ ...settings.values, providers }, settings.revision);
		if (ok) onClose();
	}, [canSave, draft, entry, isCustom, onClose, settings]);

	const handleDelete = useCallback(async () => {
		if (!entry || settings.saving) return;
		if (!confirmDelete) {
			setConfirmDelete(true);
			return;
		}
		const providers = settings.values.providers.filter((p) => p.id !== entry.id);
		const ok = await settings.save({ ...settings.values, providers }, settings.revision);
		if (ok) onClose();
	}, [confirmDelete, entry, onClose, settings]);

	const testLabel =
		testState.status === "testing"
			? "Testing connection..."
			: testState.status === "success"
				? `✓ ${testState.message}`
				: testState.status === "error"
					? `✗ ${testState.message}`
					: "Verify API key & endpoint";

	const contentGap = layout.compact ? 12 : 16;

	return (
		<ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
			<View style={{ padding: layout.compact ? 16 : 24, gap: contentGap, maxWidth: 640, alignSelf: "center", width: "100%" }}>
				<Pressable
					onPress={handleBack}
					accessibilityLabel="Back to providers"
					hitSlop={8}
					style={({ pressed }) => ({
						flexDirection: "row",
						alignItems: "center",
						alignSelf: "flex-start",
						opacity: pressed ? 0.6 : 1,
					})}
				>
					<Text style={{ color: theme.colors.foreground, fontSize: 26, lineHeight: 30, marginRight: 6 }}>
						‹
					</Text>
					<Text
						style={{
							color: confirmDiscard ? theme.colors.statusWarning : theme.colors.foregroundMuted,
							fontSize: 14,
							fontWeight: confirmDiscard ? "600" : "normal",
						}}
					>
						{confirmDiscard ? "Discard changes?" : "All providers"}
					</Text>
					{isDirty && !confirmDiscard ? (
						<Text
							style={{
								color: theme.colors.accent,
								fontSize: 16,
								marginLeft: 6,
								lineHeight: 16,
							}}
							accessibilityLabel="Unsaved changes"
						>
							•
						</Text>
					) : null}
				</Pressable>

				<View>
					<Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "700" }}>
						{entry ? providerDisplayName(entry) : "Add provider"}
					</Text>
					<Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, marginTop: 2 }}>
						{entry ? "Edit this LLM provider configuration" : "Configure a new LLM API provider"}
					</Text>
				</View>

				<SettingsCard>
					<SettingsSelect
						label="Provider type"
						value={draft.type}
						options={[...PROVIDER_TYPES]}
						onValueChange={(type) => {
							patch({
								type,
								name: draft.name || "",
							});
							setTestState({ status: "idle" });
						}}
					/>
					<SettingsInput
						label="Display name"
						initialValue={draft.name}
						placeholder={providerTypeLabel(draft.type)}
						onChangeText={(name) => patch({ name })}
					/>
					<SettingsInput
						label="API Key"
						initialValue={draft.apiKey}
						placeholder={isCustom ? "Optional for local servers" : "Enter API key"}
						secureTextEntry
						onChangeText={(apiKey) => {
							patch({ apiKey: apiKey.trim() });
							setTestState({ status: "idle" });
						}}
					/>
					<SettingsInput
						label={isCustom ? "Base URL" : "Base URL (optional override)"}
						initialValue={draft.baseUrl}
						placeholder={getBaseUrlPlaceholder(draft.type)}
						onChangeText={(baseUrl) => {
							patch({ baseUrl: baseUrl.trim() });
							setTestState({ status: "idle" });
						}}
					/>
					{isCustom ? (
						<SettingsSwitch
							label="Supports reasoning"
							hint="Show reasoning-effort options in the chatbox model picker and send reasoning_effort to this endpoint"
							value={draft.reasoning}
							onValueChange={(reasoning) => patch({ reasoning })}
						/>
					) : null}
					<SettingsSwitch
						label="Enabled"
						hint="Disabled entries are hidden from the model picker"
						value={draft.enabled}
						onValueChange={(enabled) => patch({ enabled })}
					/>
				</SettingsCard>

				<SettingsCard>
					<SettingsAction
						label={testLabel}
						actionLabel={testState.status === "testing" ? "Testing..." : "Test connection"}
						disabled={
							testState.status === "testing" ||
							(!draft.apiKey.trim() && !isCustom) ||
							(isCustom && !draft.baseUrl.trim())
						}
						onPress={handleTest}
					/>
				</SettingsCard>

				<SettingsCard>
					<SettingsAction
						label={
							missingKey
								? "Enter an API key to save"
								: missingBaseUrl
									? "Enter a base URL to save"
									: settings.saveError
										? `Save failed: ${settings.saveError}`
										: settings.saving
											? "Saving..."
											: isDirty
												? "You have unsaved changes"
												: "Provider is up to date"
						}
						actionLabel="Save"
						disabled={!canSave || settings.saving || (!isDirty && entry !== null)}
						onPress={handleSave}
					/>
				</SettingsCard>

				{entry ? (
					<SettingsCard>
						<SettingsAction
							label={
								confirmDelete
									? `Tap again to permanently delete ${providerDisplayName(entry)}`
									: `Delete ${providerDisplayName(entry)}`
							}
							actionLabel={confirmDelete ? "Confirm delete" : "Delete"}
							disabled={settings.saving}
							onPress={handleDelete}
						/>
					</SettingsCard>
				) : null}
			</View>
		</ScrollView>
	);
}
