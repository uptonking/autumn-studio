import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import type { SettingsState } from "@getpaseo/plugin/client";
import { SettingsSection, SettingsCard, SettingsAction } from "@getpaseo/plugin/client/ui";
import type { ProviderEntry, settings } from "../shared/settings.js";
import type { ExternalProviderInfo } from "../shared/rpc.js";
import { isCustomType, providerDisplayName, providerTypeLabel } from "./provider-editor.js";

type ReadySettings = Extract<
	SettingsState<typeof settings.schema>,
	{ status: "ready" }
>;

/** Row caption: type, endpoint host for custom entries, then state markers. */
function providerRowCaption(entry: ProviderEntry): string {
	const parts = [providerTypeLabel(entry.type)];
	if (isCustomType(entry.type) && entry.baseUrl.trim()) {
		try {
			parts.push(new URL(entry.baseUrl.trim()).host);
		} catch {
			parts.push(entry.baseUrl.trim());
		}
	}
	const manualCount = (entry.models ?? []).length;
	if (manualCount > 0) parts.push(`${manualCount} model${manualCount === 1 ? "" : "s"}`);
	if (entry.reasoning && isCustomType(entry.type)) parts.push("Reasoning");
	if (!entry.enabled) parts.push("Disabled");
	return parts.join(" · ");
}

function ProviderRow({
	entry,
	theme,
	onEdit,
}: {
	entry: ProviderEntry;
	theme: PluginTheme;
	onEdit(): void;
}) {
	return (
		<Pressable
			onPress={onEdit}
			accessibilityLabel={`Edit ${providerDisplayName(entry)}`}
			style={({ pressed }) => ({
				flexDirection: "row",
				alignItems: "center",
				justifyContent: "space-between",
				paddingVertical: 14,
				paddingHorizontal: 16,
				opacity: pressed ? 0.6 : 1,
			})}
		>
			<View style={{ flex: 1, marginRight: 12 }}>
				<Text
					style={{
						color: entry.enabled ? theme.colors.foreground : theme.colors.foregroundMuted,
						fontSize: 15,
						fontWeight: "600",
					}}
				>
					{providerDisplayName(entry)}
				</Text>
				<Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, marginTop: 2 }}>
					{providerRowCaption(entry)}
				</Text>
			</View>
			<View
				style={{
					width: 8,
					height: 8,
					borderRadius: 4,
					marginRight: 12,
					backgroundColor: entry.enabled
						? theme.colors.statusSuccess
						: theme.colors.foregroundMuted,
					opacity: entry.enabled ? 1 : 0.4,
				}}
			/>
			<Text style={{ color: theme.colors.foregroundMuted, fontSize: 18 }}>›</Text>
		</Pressable>
	);
}

/**
 * Read-only list of configured LLM provider entries. Tapping a row (or the
 * add action) opens the editor page; editing happens there, never inline.
 */
export function ProviderList({
	settings,
	theme,
	onEdit,
}: {
	settings: ReadySettings;
	theme: PluginTheme;
	/** Receives the entry id to edit, or "new" to create one. */
	onEdit(id: string | "new"): void;
}) {
	const providers = settings.values.providers;

	return (
		<SettingsSection
			title="LLM API Providers"
			info={
				<Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
					Tap a provider to edit it, or add a new one. Models from enabled
					providers appear in the chatbox model picker under Autumn Studio.
				</Text>
			}
		>
			{providers.length === 0 ? (
				<SettingsCard>
					<SettingsAction
						label="No providers configured yet"
						hint="Add an LLM API provider to start using the embedded agent"
						actionLabel="Add provider"
						onPress={() => onEdit("new")}
					/>
				</SettingsCard>
			) : (
				<SettingsCard>
					{providers.map((entry) => (
						<ProviderRow
							key={entry.id}
							entry={entry}
							theme={theme}
							onEdit={() => onEdit(entry.id)}
						/>
					))}
					<SettingsAction
						label="Add another provider"
						actionLabel="Add provider"
						onPress={() => onEdit("new")}
					/>
				</SettingsCard>
			)}
		</SettingsSection>
	);
}

/**
 * Same auto-detected marker the chatbox picker uses in model descriptions
 * (server constant in server/model-runtime.ts), kept in sync by convention.
 */
const AUTO_MARKER = "\u{1F441}\uFE0E";

/** Human label for a detection auth source. */
export function authSourceLabel(source: string): string {
	switch (source) {
		case "oauth":
			return "OAuth";
		case "stored":
			return "API key (auth.json)";
		case "models_json_key":
			return "API key (models.json)";
		case "models_json_command":
			return "API key command (models.json)";
		case "environment":
			return "Environment variable";
		case "runtime":
			return "Runtime key";
		default:
			return source;
	}
}

function ExternalProviderRow({
	provider,
	theme,
	onView,
}: {
	provider: ExternalProviderInfo;
	theme: PluginTheme;
	onView(): void;
}) {
	return (
		<Pressable
			onPress={onView}
			accessibilityLabel={`View ${provider.name}`}
			style={({ pressed }) => ({
				flexDirection: "row",
				alignItems: "center",
				justifyContent: "space-between",
				paddingVertical: 14,
				paddingHorizontal: 16,
				opacity: pressed ? 0.6 : 1,
			})}
		>
			<View style={{ flex: 1, marginRight: 12 }}>
				<View style={{ flexDirection: "row", alignItems: "center" }}>
					<Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>
						{`${AUTO_MARKER} ${provider.name}`}
					</Text>
				</View>
				<Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, marginTop: 2 }}>
					{[
						authSourceLabel(provider.authSource),
						`${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`,
					].join(" · ")}
				</Text>
			</View>
			<View
				style={{
					width: 8,
					height: 8,
					borderRadius: 4,
					marginRight: 12,
					backgroundColor: theme.colors.statusSuccess,
				}}
			/>
			<Text style={{ color: theme.colors.foregroundMuted, fontSize: 18 }}>›</Text>
		</Pressable>
	);
}

/**
 * Read-only list of LLM providers detected in the user's external pi
 * installation. Tapping a row opens the read-only viewer page.
 */
export function ExternalProviderList({
	providers,
	theme,
	onView,
}: {
	providers: ExternalProviderInfo[];
	theme: PluginTheme;
	onView(provider: ExternalProviderInfo): void;
}) {
	if (providers.length === 0) return null;
	return (
		<SettingsSection
			title="Auto-Detected Models from External Agents"
			info={
				<Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
					Providers detected from external agents (currently external Pi).
					Their models appear in the chatbox model picker automatically;
					these entries are managed by the source agent and read-only here.
				</Text>
			}
		>
			<SettingsCard>
				{providers.map((provider) => (
					<ExternalProviderRow
						key={provider.id}
						provider={provider}
						theme={theme}
						onView={() => onView(provider)}
					/>
				))}
			</SettingsCard>
		</SettingsSection>
	);
}
