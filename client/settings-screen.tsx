import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsSection, SettingsCard, SettingsAction } from "@getpaseo/plugin/client/ui";
import { settings } from "../shared/settings.js";
import { GeneralSettings } from "./general-settings.js";
import { ProviderSettings } from "./provider-settings.js";

export function AutumnSettingsScreen({ theme, layout }: PluginScreenProps) {
  const state = useSettings(settings);

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
        <ProviderSettings settings={state} theme={theme} />
      </View>
    </ScrollView>
  );
}
