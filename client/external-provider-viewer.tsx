import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { SettingsCard, SettingsRow } from "@getpaseo/plugin/client/ui";
import type { ExternalProviderInfo } from "../shared/rpc.js";
import { authSourceLabel } from "./provider-list.js";

/**
 * Read-only detail page for an external Pi provider. Shows the provider's
 * type, auth source, base URL, models list, and reasoning status — all
 * non-editable. No Save/Delete/Test actions.
 */
export function ExternalProviderViewer({
	provider,
	agentDir,
	theme,
	layout,
	onClose,
}: {
	provider: ExternalProviderInfo;
	agentDir: string;
	theme: PluginTheme;
	layout: { compact: boolean };
	onClose(): void;
}) {
	const reasoningModels = provider.models.filter((m) => m.reasoning === true);
	const contentGap = layout.compact ? 12 : 16;

	const modelRowStyle = useMemo(
		() => ({
			flexDirection: "row" as const,
			justifyContent: "space-between" as const,
			alignItems: "center" as const,
			paddingVertical: 10,
			paddingHorizontal: 16,
		}),
		[],
	);

	return (
		<ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
			<View style={{ padding: layout.compact ? 16 : 24, gap: contentGap, maxWidth: 640, alignSelf: "center", width: "100%" }}>
				<Pressable
					onPress={onClose}
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
					<Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>
						All providers
					</Text>
				</Pressable>

				<View>
					<Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "700" }}>
						{`\u{1F441}\uFE0E ${provider.name}`}
					</Text>
					<Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, marginTop: 2 }}>
						{`Auto-detected from ${provider.source === "external-pi" ? "external Pi" : provider.source} (${agentDir || "~/.pi/agent"}) · read-only`}
					</Text>
				</View>

				<SettingsCard>
					<SettingsRow label="Provider" hint={provider.id} />
					<SettingsRow label="Auth source" hint={authSourceLabel(provider.authSource)} />
					{provider.baseUrl ? (
						<SettingsRow label="Base URL" hint={provider.baseUrl} />
					) : null}
					{reasoningModels.length > 0 ? (
						<SettingsRow
							label="Reasoning"
							hint={`${reasoningModels.length} reasoning model${reasoningModels.length === 1 ? "" : "s"}`}
						/>
					) : null}
				</SettingsCard>

				{provider.models.length > 0 ? (
					<SettingsCard>
						<SettingsRow
							label="Models"
							hint={`${provider.models.length} model${provider.models.length === 1 ? "" : "s"} available`}
						/>
						{provider.models.map((model) => (
							<View key={model.id} style={modelRowStyle}>
								<View style={{ flex: 1, marginRight: 8 }}>
									<Text
										style={{ color: theme.colors.foreground, fontSize: 14 }}
										numberOfLines={1}
									>
										{model.name || model.id}
									</Text>
									{model.contextWindow ? (
										<Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
											{model.contextWindow.toLocaleString()} tokens
											{model.reasoning ? " · Reasoning" : ""}
										</Text>
									) : model.reasoning ? (
										<Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
											Reasoning
										</Text>
									) : null}
								</View>
							</View>
						))}
					</SettingsCard>
				) : null}
			</View>
		</ScrollView>
	);
}
