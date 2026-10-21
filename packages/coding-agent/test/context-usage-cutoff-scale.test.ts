/**
 * Contract for `tui.scaleGaugeToCompaction` on /context report.
 *
 * computeSessionContextBreakdown mirrors the setting into the breakdown: on
 * with a known cutoff → `scaledToCutoff` (the /context headline then reads
 * current/cutoff/total and past-cutoff cells gray out); off (default) → false.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { computeSessionContextBreakdown } from "@oh-my-pi/pi-coding-agent/session/context-usage-runtime";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const contextWindow = 200_000;

function makeSession(settings: unknown, contextTokens = 18_612): AgentSession {
	return {
		settings,
		model: { contextWindow },
		agent: { tokenizer: {} },
		getContextBreakdown: () => ({
			messagesTokens: contextTokens,
			skillsTokens: 0,
			systemToolsTokens: 0,
			systemContextTokens: 0,
			systemPromptTokens: 0,
			usedTokens: contextTokens,
		}),
	} as never as AgentSession;
}

describe("/context scaleGaugeToCompaction", () => {
	beforeAll(() => {
		resetSettingsForTest();
		Settings.init({ inMemory: true });
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("flags the breakdown as cutoff-scaled when the setting is on", () => {
		const settings = Settings.isolated({
			"compaction.thresholdTokens": 50_000,
			"tui.scaleGaugeToCompaction": true,
		});
		const breakdown = computeSessionContextBreakdown(makeSession(settings));
		expect(breakdown.thresholdTokens).toBe(50_000);
		expect(breakdown.scaledToCutoff).toBe(true);
		expect(breakdown.contextWindow).toBe(contextWindow);
	});

	it("leaves the breakdown unscaled by default", () => {
		const settings = Settings.isolated({ "compaction.thresholdTokens": 50_000 });
		const breakdown = computeSessionContextBreakdown(makeSession(settings));
		expect(breakdown.thresholdTokens).toBe(50_000);
		expect(breakdown.scaledToCutoff).toBe(false);
	});
});
