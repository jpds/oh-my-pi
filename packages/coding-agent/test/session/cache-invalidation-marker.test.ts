import { describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai/types";
import { detectCacheInvalidation } from "../../src/session/transcript/cache-invalidation-marker";

function usage(parts: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number }): Usage {
	const input = parts.input ?? 0;
	const output = parts.output ?? 0;
	const cacheRead = parts.cacheRead ?? 0;
	const cacheWrite = parts.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("detectCacheInvalidation", () => {
	it("does not flag the first turn (no prior cache footprint)", () => {
		expect(detectCacheInvalidation(undefined, usage({ cacheWrite: 50_000, input: 2 }))).toBeUndefined();
	});

	it("flags a cacheRead collapse after a warm turn and reports reprocessed tokens", () => {
		// Mirrors the observed session: warm turn reads ~50k, next request reads
		// nothing and re-creates the whole prefix.
		const prev = usage({ cacheRead: 49_837, cacheWrite: 980, output: 79 });
		const current = usage({ cacheRead: 0, cacheWrite: 50_900, input: 99, output: 99 });
		expect(detectCacheInvalidation(prev, current)).toEqual({ reprocessedTokens: 50_999 });
	});

	it("does not flag a cold turn whose predecessor only wrote the cache (never read it)", () => {
		// The session's opening request writes the prefix (cacheRead 0); a long
		// first tool call then outlives the provider's cache TTL, so the follow-up
		// re-writes cold. The cache was never proven live, so this is expected
		// warming/expiry — not a user-caused invalidation worth a marker right
		// under the opening message.
		const prev = usage({ cacheRead: 0, cacheWrite: 50_900, input: 99 });
		const current = usage({ cacheRead: 0, cacheWrite: 51_113, input: 16 });
		expect(detectCacheInvalidation(prev, current)).toBeUndefined();
	});

	it("does not flag a turn that read back the warm prefix", () => {
		const prev = usage({ cacheRead: 50_900, cacheWrite: 980 });
		const current = usage({ cacheRead: 50_900, cacheWrite: 3_459, input: 2 });
		expect(detectCacheInvalidation(prev, current)).toBeUndefined();
	});

	it("flags a collapse that still reads the system block other sessions keep warm", () => {
		// Observed after an idle gap: concurrent sessions on the same system prompt
		// kept its ~15k-token block warm, so the request read that back while
		// re-writing the expired 364k-token history behind it.
		const prev = usage({ cacheRead: 369_518, cacheWrite: 1_983, input: 1 });
		const current = usage({ cacheRead: 15_282, cacheWrite: 364_343, input: 3 });
		expect(detectCacheInvalidation(prev, current)).toEqual({ reprocessedTokens: 364_346 });
	});

	it("does not flag expiry behind a predecessor that read only the shared system block", () => {
		// The opening request reads the system block warm from other sessions and
		// writes its own history; that history was never read back, so losing it to
		// the TTL is expected warming, like the write-only predecessor above.
		const prev = usage({ cacheRead: 15_282, cacheWrite: 35_000, input: 4 });
		const current = usage({ cacheRead: 15_282, cacheWrite: 36_100, input: 2 });
		expect(detectCacheInvalidation(prev, current)).toBeUndefined();
	});

	it("flags implicit best-effort caches that report no cacheWrite", () => {
		// Google/Fireworks-style providers report only `cacheRead`: a cold turn
		// bills the whole prompt as `input` and never reports `cacheWrite`, so
		// requiring one hid every real miss. The warm→cold transition decides.
		// Mirrors the observed gemini-3.5-flash turn (warm 40.8k read, then a cold
		// 43.1k reprocess with zero cacheWrite).
		const prev = usage({ cacheRead: 40_789, input: 1_069, output: 353 });
		const current = usage({ cacheRead: 0, cacheWrite: 0, input: 43_102, output: 58 });
		expect(detectCacheInvalidation(prev, current)).toEqual({ reprocessedTokens: 43_102 });
	});

	it("ignores collapses when the prior footprint was below the cacheable floor", () => {
		// No meaningful cache existed to invalidate (e.g. provider without prompt
		// caching, or a tiny early context).
		const prev = usage({ input: 500 });
		expect(detectCacheInvalidation(prev, usage({ input: 600 }))).toBeUndefined();
	});

	it("ignores a cold turn that reprocessed only a trivial prompt", () => {
		const prev = usage({ cacheRead: 40_000, cacheWrite: 1_000 });
		expect(detectCacheInvalidation(prev, usage({ cacheRead: 0, input: 12 }))).toBeUndefined();
	});
});
