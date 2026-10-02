import type { SettingsState } from "@getpaseo/plugin/client";
import {
	SettingsSection,
	SettingsCard,
	SettingsSwitch,
	SettingsSelect,
	SettingsInput,
} from "@getpaseo/plugin/client/ui";
import type { settings } from "../shared/settings.js";
import { useDebouncedSave } from "./use-debounced-save.js";

type ReadySettings = Extract<
	SettingsState<typeof settings.schema>,
	{ status: "ready" }
>;

const THINKING_OPTIONS = [
	{ label: "Off (No reasoning budget)", value: "off" },
	{ label: "Low (Quick reasoning)", value: "low" },
	{ label: "Medium (Balanced reasoning)", value: "medium" },
	{ label: "High (Deep reasoning)", value: "high" },
] as const;

export function GeneralSettings({ settings }: { settings: ReadySettings }) {
	const saveDebounced = useDebouncedSave(settings);

	const toggleEnabled = (enabled: boolean) => {
		// Immediate, not debounced: availability changes should land now.
		void settings.save({ ...settings.values, enabled }, settings.revision);
	};

	const changeThinkingLevel = (defaultThinkingLevel: "off" | "low" | "medium" | "high") => {
		void settings.save({ ...settings.values, defaultThinkingLevel }, settings.revision);
	};

	const changeInstructions = (customInstructions: string) => {
		saveDebounced({ ...settings.values, customInstructions });
	};

	return (
		<SettingsSection title="General">
			<SettingsCard>
				<SettingsSwitch
					label="Enable Autumn Studio"
					hint="When disabled, Autumn Studio will not appear as an agent provider option"
					value={settings.values.enabled}
					disabled={settings.saving}
					onValueChange={toggleEnabled}
				/>
				<SettingsSelect
					label="Default reasoning effort"
					hint="Pre-selected effort for reasoning models; changeable per chat in the model picker"
					value={settings.values.defaultThinkingLevel}
					options={THINKING_OPTIONS}
					disabled={settings.saving}
					onValueChange={changeThinkingLevel}
				/>
				<SettingsInput
					label="Custom system instructions"
					placeholder="e.g. Always write code in TypeScript; keep explanations concise"
					initialValue={settings.values.customInstructions}
					disabled={settings.saving}
					onChangeText={changeInstructions}
				/>
			</SettingsCard>
		</SettingsSection>
	);
}
