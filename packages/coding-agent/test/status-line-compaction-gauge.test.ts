/**
 * Contract for `tui.scaleGaugeToCompaction`.
 *
 * Toggled on, the context gauge measures toward the auto-compaction cutoff
 * instead of the full model window: percentages read against the cutoff and
 * the embedded window label shows the cutoff, so the bar reaches 100% just
 * before compaction fires. Toggled off (default), the gauge is unchanged:
 * raw percent of the model window and the window label.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { StatusLineTestComponents } from "./helpers/status-line";

const statusLines = new StatusLineTestComponents();
beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	statusLines.dispose();
	resetSettingsForTest();
});

function makeSession(opts: { usage: { tokens: number; contextWindow: number; percent: number }; settings?: unknown }) {
	const model = { id: "test-model", contextWindow: opts.usage.contextWindow, input: ["text"] };
	const messages = [
		{ role: "user", content: "hi" },
		{ role: "assistant", content: [{ type: "text", text: "done" }] },
	];
	const session = {
		messages,
		systemPrompt: ["You are a helpful assistant."],
		agent: { state: { tools: [] }, tokenizer: undefined },
		skills: [],
		model,
		modelRegistry: { isUsingOAuth: () => false },
		state: { messages, model },
		settings: opts.settings,
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
			getSessionName: () => "test",
		},
		getAsyncJobSnapshot: () => ({ running: [] }),
		isFastModeActive: () => false,
		getContextUsage: () => opts.usage,
	} as unknown as AgentSession;
	return { session };
}

function gaugeText(comp: StatusLineComponent): string {
	return comp.getTopBorder(80).content.replaceAll(/\x1b\[[0-9;]*m/g, "");
}

// 10k of a 100k window, threshold fixed at 40k: raw 10%, cutoff-scaled 25%.
const usage = { tokens: 10_000, contextWindow: 100_000, percent: 10 };

describe("tui.scaleGaugeToCompaction", () => {
	it("labels the gauge with the compaction cutoff in cutoff units", () => {
		const { session } = makeSession({
			usage,
			settings: Settings.isolated({ "compaction.thresholdTokens": 40_000 }),
		});
		const comp = statusLines.track(new StatusLineComponent(session, statusLineHost));
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi", "context_pct"],
			rightSegments: ["session_name"],
			separator: "none",
			sessionAccent: false,
			contextLine: "embedded",
			scaleGaugeToCompaction: true,
		});
		const plain = gaugeText(comp);
		expect(plain).toContain("25%");
		expect(plain).toContain("40K");
		// The full-window label is gone: the bar's right end is the cutoff.
		expect(plain).not.toContain("100K");
	});

	it("off keeps the raw window scale", () => {
		const { session } = makeSession({
			usage,
			settings: Settings.isolated({ "compaction.thresholdTokens": 40_000 }),
		});
		const comp = statusLines.track(new StatusLineComponent(session, statusLineHost));
		comp.updateSettings({
			preset: "custom",
			leftSegments: ["pi", "context_pct"],
			rightSegments: ["session_name"],
			separator: "none",
			sessionAccent: false,
			contextLine: "embedded",
		});
		const plain = gaugeText(comp);
		expect(plain).toContain("10%");
		expect(plain).toContain("100K");
		expect(plain).not.toContain("40K");
	});
});
