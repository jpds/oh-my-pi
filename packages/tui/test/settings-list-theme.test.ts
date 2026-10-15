import { beforeAll, beforeEach, afterEach, describe, expect, it } from "bun:test";
import { DECLARED_SETTING_COLOR, type SettingItem, SettingsList } from "@oh-my-pi/pi-tui/components/settings-list";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui/keybindings";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { getSettingsListTheme, initTheme, theme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

describe("getSettingsListTheme", () => {
	it("keeps modified labels and values dirty even when selected", () => {
		const settingsTheme = getSettingsListTheme();

		const selectedChangedLabel = settingsTheme.label("Changed", true, true);
		const selectedChangedValue = settingsTheme.value("changed", true, true);
		const unselectedChangedValue = settingsTheme.value("changed", false, true);
		const selectedDefaultValue = settingsTheme.value("default", true, false);

		expect(selectedChangedLabel).toBe(theme.fg("statusLineGitDirty", "Changed"));
		expect(selectedChangedValue).toBe(theme.fg("statusLineGitDirty", "changed"));
		expect(unselectedChangedValue).toBe(theme.fg("statusLineGitDirty", "changed"));
		expect(selectedDefaultValue).toBe(theme.fg("accent", "default"));
	});
});

describe("declared settings rows", () => {
	const cx: DescribeContext = { cols: 80, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
	/** Non-default and untouched by the user: exactly the pair the panel must tell apart. */
	const declaredItem: SettingItem = {
		id: "temperature",
		label: "Temperature",
		currentValue: "0.9",
		changed: true,
		declared: true,
	};

	beforeEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	afterEach(() => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
	});

	const renderList = (items: SettingItem[]) =>
		new SettingsList(
			items,
			5,
			getSettingsListTheme(),
			() => {},
			() => {},
		);

	it("styles declared rows in the declared hue, not the changed hue", () => {
		expect(getSettingsListTheme().declared!("0.9")).toBe(theme.fg(DECLARED_SETTING_COLOR, "0.9"));

		const row = renderList([declaredItem]).render(60).join("\n");
		expect(row).toContain(theme.fg(DECLARED_SETTING_COLOR, "Temperature"));
		expect(row).toContain(theme.fg(DECLARED_SETTING_COLOR, "0.9"));
		// The row is the selection and differs from its default, so both competing hues would
		// otherwise paint it.
		expect(row).not.toContain(theme.fg("accent", "0.9"));
		expect(row).not.toContain(theme.fg("statusLineGitDirty", "0.9"));
	});

	it("marks declared rows with the declared token in the native settings page", () => {
		const described = JSON.stringify(renderList([declaredItem]).describe(cx));

		expect(described).toContain(`"s":"${DECLARED_SETTING_COLOR}"`);
		expect(described).toContain("Temperature");
	});

	it("leaves rows no layer declares on the ordinary styling", () => {
		const row = renderList([{ ...declaredItem, declared: undefined }])
			.render(60)
			.join("\n");

		expect(row).not.toContain(theme.fg(DECLARED_SETTING_COLOR, "0.9"));
		expect(row).toContain(theme.fg("statusLineGitDirty", "0.9"));
	});
});
