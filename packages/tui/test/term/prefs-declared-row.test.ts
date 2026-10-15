import { describe, expect, it } from "bun:test";
import { settingRow } from "@oh-my-pi/pi-tui/term/painters/prefs";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

const theme = loadThemeSync("dark");

function row(declared: boolean, changed: boolean): string {
	return settingRow(theme, {
		label: "temperature",
		value: "0.7",
		changed,
		declared,
		selected: false,
		labelWidth: 12,
		width: 60,
		dimmed: false,
		hovered: false,
	});
}

describe("settingRow declared styling", () => {
	const declaredLabel = theme.fg("statusLineGitClean", "temperature");
	const changedLabel = theme.fg("statusLineGitDirty", "temperature");

	it("paints a declared row in the declarative hue even when it is the user's edit", () => {
		const painted = row(true, true);
		expect(painted).toContain(declaredLabel);
		expect(painted).not.toContain(changedLabel);
	});

	it("paints a changed row in the changed hue", () => {
		const painted = row(false, true);
		expect(painted).toContain(changedLabel);
		expect(painted).not.toContain(declaredLabel);
	});

	it("leaves an untouched row unstyled", () => {
		const painted = row(false, false);
		expect(painted).not.toContain(declaredLabel);
		expect(painted).not.toContain(changedLabel);
	});
});
