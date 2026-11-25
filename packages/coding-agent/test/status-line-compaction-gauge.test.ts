/**
 * Contract for `tui.scaleGaugeToCompaction`.
 *
 * Toggled on, the context gauge measures toward the auto-compaction cutoff
 * instead of the full model window: percentages read against the cutoff and
 * the embedded window label shows the cutoff, so the bar reaches 100% just
 * before compaction fires. Toggled off (default), the gauge is unchanged:
 * raw percent of the model window and the window label.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createRoot } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import type { SessionStatusLine } from "../src/modes/interactive/status-line";
import type { StatusLineSettings } from "../src/modes/view-model/status-line/types";
import type { AgentViewSession } from "../src/session/agent-session-handle";
import { createStatusLine } from "../src/ui/status/status-line";
import "../src/ui/styles/status";
import { initTheme } from "../src/ui/theme/service";
import { disposeStatusLines, statusLine, statusSession } from "./helpers/session-status-line";

// 10k of a 100k window, threshold fixed at 40k: raw 10%, cutoff-scaled 25%.
const usage = { tokens: 10_000, contextWindow: 100_000, percent: 10 };

const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "nerd" }));

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	disposeStatusLines();
});

function makeSession(settings: Settings): AgentViewSession {
	return statusSession({
		model: { id: "test-model", contextWindow: 100_000, input: ["text"], thinking: false },
		settings,
		getContextUsage: () => usage,
	});
}

/** The composer's top border (the gauge row) as plain text. */
function gaugeText(line: SessionStatusLine, width = 80): string {
	const settings = line.settings();
	const facts = line.facts();
	return createRoot(dispose => {
		const { preview } = createStatusLine({
			settings: () => settings,
			facts: () => facts,
			placement: () => ({ bar: "none", gap: false, autocomplete: false }),
		});
		try {
			return paintNode(env, preview("top-border"), width)
				.rows.map(row => Bun.stripANSI(row))
				.join("\n");
		} finally {
			dispose();
		}
	});
}

const baseSettings: Partial<StatusLineSettings> = {
	preset: "custom",
	leftSegments: ["pi", "context_pct"],
	rightSegments: ["session_name"],
	separator: "none",
	sessionAccent: false,
	contextLine: "embedded",
};

describe("tui.scaleGaugeToCompaction", () => {
	it("labels the gauge with the compaction cutoff in cutoff units", () => {
		const line = statusLine(makeSession(Settings.isolated({ "compaction.thresholdTokens": 40_000 })), {
			...baseSettings,
			scaleGaugeToCompaction: true,
		});
		const plain = gaugeText(line);
		expect(plain).toContain("25%");
		expect(plain).toContain("40K");
		// The full-window label is gone: the bar's right end is the cutoff.
		expect(plain).not.toContain("100K");
	});

	it("off keeps the raw window scale", () => {
		const line = statusLine(makeSession(Settings.isolated({ "compaction.thresholdTokens": 40_000 })), {
			...baseSettings,
			scaleGaugeToCompaction: false,
		});
		const plain = gaugeText(line);
		expect(plain).toContain("10%");
		expect(plain).toContain("100K");
		expect(plain).not.toContain("40K");
	});
});
