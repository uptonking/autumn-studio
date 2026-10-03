import { useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { PluginScreenParams, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsSection, SettingsCard, SettingsAction } from "@getpaseo/plugin/client/ui";
import { settings } from "../shared/settings.js";
import { externalProvidersRpc, type ExternalProviderInfo } from "../shared/rpc.js";
import { useRpc } from "@getpaseo/plugin/client";
import { GeneralSettings } from "./general-settings.js";
import { ProviderEditor } from "./provider-editor.js";
import { ExternalProviderList, ProviderList } from "./provider-list.js";
import { ExternalProviderViewer } from "./external-provider-viewer.js";

type AutumnScreenProps = PluginSurfaceProps & { params?: PluginScreenParams };

/**
 * Main Autumn Studio screen. Hosts the General section and the provider list;
 * the create/edit form is an internal view of this screen (plugin screens
 * cannot open other screens), so navigation is plain state plus a params
 * deep link: openScreen({ screenId: "settings", params: { edit: "<id>" } }).
 */
export function AutumnSettingsScreen({ theme, layout, params }: AutumnScreenProps) {
	const state = useSettings(settings);
	/** Entry id being edited, "new" for create, null for the list. */
	const [editing, setEditing] = useState<string | "new" | null>(() => {
		const requested = params?.edit;
		if (requested === "new") return "new";
		if (requested) return requested;
		return null;
	});

	useEffect(() => {
		if (params?.edit) {
			setEditing(params.edit === "new" ? "new" : params.edit);
		}
	}, [params?.edit]);

	/** External Pi provider currently being viewed read-only. */
	const [viewingExternal, setViewingExternal] = useState<ExternalProviderInfo | null>(null);
	const paramsRef = useRef(params);
	paramsRef.current = params;
	const [externalProviders, setExternalProviders] = useState<ExternalProviderInfo[]>([]);
	const [externalAgentDir, setExternalAgentDir] = useState("");
	const callExternal = useRpc(externalProvidersRpc);

	// Refetch on revision change so toggling "Reuse external Pi providers"
	// (and any settings save) refreshes the detected list.
	const settingsReady = state.status === "ready" ? state : null;
	const reuseExternal = settingsReady?.values.reuseExternalPi === true;
	const settingsRevision = settingsReady?.revision ?? null;
	useEffect(() => {
		if (!settingsReady || !reuseExternal) {
			setExternalProviders([]);
			return;
		}
		let cancelled = false;
		void callExternal({})
			.then((res) => {
				if (cancelled) return;
				setExternalProviders(res.providers);
				setExternalAgentDir(res.agentDir);
				// Deep link: openScreen({ screenId: "settings", params: { external: "<providerId>" } })
				const requested = paramsRef.current?.external;
				if (requested) {
					const match = res.providers.find((p) => p.id === requested);
					if (match) setViewingExternal(match);
				}
			})
			.catch(() => {
				if (!cancelled) setExternalProviders([]);
			});
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [callExternal, settingsRevision, reuseExternal]);

	const styles = useMemo(
		() => ({
			container: {
				flex: 1,
				backgroundColor: theme.colors.surface0,
			},
			content: {
				padding: layout.compact ? 16 : 24,
				gap: 24,
				maxWidth: 640,
				alignSelf: "center" as const,
				width: "100%" as const,
			},
			title: {
				color: theme.colors.foreground,
				fontSize: layout.compact ? 22 : 26,
				fontWeight: "700" as const,
			},
			subtitle: {
				color: theme.colors.foregroundMuted,
				fontSize: 14,
				marginTop: 4,
			},
			loading: {
				color: theme.colors.foregroundMuted,
				padding: 24,
			},
		}),
		[theme, layout.compact],
	);

	if (state.status === "loading") {
		return (
			<View style={styles.container}>
				<Text style={styles.loading}>Loading settings…</Text>
			</View>
		);
	}

	if (state.status !== "ready") {
		return (
			<ScrollView style={styles.container}>
				<View style={styles.content}>
					<SettingsSection title="Autumn Studio">
						<SettingsCard>
							<Text style={styles.loading}>{state.error}</Text>
							<SettingsAction
								label="Retry loading settings"
								actionLabel="Reload"
								onPress={state.reload}
							/>
							{state.status === "invalid" ? (
								<SettingsAction
									label="Restore defaults"
									actionLabel="Reset"
									onPress={state.reset}
								/>
							) : null}
						</SettingsCard>
					</SettingsSection>
				</View>
			</ScrollView>
		);
	}

	if (viewingExternal) {
		return (
			<ExternalProviderViewer
				provider={viewingExternal}
				agentDir={externalAgentDir}
				theme={theme}
				layout={{ compact: layout.compact }}
				onClose={() => setViewingExternal(null)}
			/>
		);
	}

	// Editing an id that no longer exists (deleted elsewhere) falls back to the list.
	const editingEntry =
		editing && editing !== "new"
			? state.values.providers.find((p) => p.id === editing)
			: undefined;

	if (editing && (editing === "new" || editingEntry)) {
		return (
			<ProviderEditor
				settings={state}
				theme={theme}
				layout={{ compact: layout.compact }}
				entry={editing === "new" ? null : (editingEntry ?? null)}
				onClose={() => setEditing(null)}
			/>
		);
	}

	return (
		<ScrollView style={styles.container}>
			<View style={styles.content}>
				<View>
					<Text style={styles.title}>Autumn Studio</Text>
					<Text style={styles.subtitle}>
						Embedded AI coding agent — configure your LLM providers below
					</Text>
				</View>
				<GeneralSettings settings={state} />
				<ProviderList
					settings={state}
					theme={theme}
					onEdit={(id) => setEditing(id)}
				/>
				<ExternalProviderList
					providers={externalProviders}
					theme={theme}
					onView={(provider) => setViewingExternal(provider)}
				/>
			</View>
		</ScrollView>
	);
}
