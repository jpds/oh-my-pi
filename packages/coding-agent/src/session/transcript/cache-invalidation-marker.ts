import type { Usage } from "@oh-my-pi/pi-ai";

/**
 * Minimum prefix the previous turn must have READ back from cache before a
 * collapse on the current turn counts as an invalidation. Filters out tiny
 * contexts and providers below the cacheable-prefix floor, where a zero
 * `cacheRead` is expected rather than a reset.
 */
const MIN_CACHE_FOOTPRINT = 2048;

/** A prompt-cache invalidation detected from a turn's usage. */
export interface CacheInvalidation {
	/** Prompt tokens the cold turn had to (re)process instead of reading from cache. */
	reprocessedTokens: number;
}

/**
 * Decide whether `current` turn lost a *working* prompt cache that `prev` was
 * reusing.
 *
 * The provider reports a warm prefix as `cacheRead`; a model/thinking/tool/
 * system-prompt change, a history rewrite or an expired entry breaks the
 * prefix, so the next request re-pays for the prompt past the break. We flag
 * only the transition where a demonstrably warm cache goes cold: the previous
 * turn must have actually READ a meaningful prefix back, and this turn read
 * back less than half of it while it still reprocessed a non-trivial prompt.
 *
 * A collapse need not reach zero: the leading system/tool block is shared with
 * every concurrent session on the same prompt, which keeps it warm while this
 * session's history expires, so a cold turn still reads that block (~15k
 * tokens) back while re-writing hundreds of thousands behind it.
 *
 * Requiring a prior warm read is deliberate. A turn that merely WROTE the prefix
 * (`cacheRead` 0) has not proven the cache is live — that is the session's first
 * request, or a re-write after expiry — so a following cold turn there is
 * expected, not an invalidation the user caused (e.g. a long-running first tool
 * call outliving the provider's 5-minute cache TTL surfaced a spurious "cache
 * miss" right under the opening message). It also collapses a run of consecutive
 * cold turns to the single marker at the moment the cache actually broke, instead
 * of repeating the banner on every turn while it re-warms. Measuring the loss
 * against what the predecessor READ (not what it wrote) keeps both guarantees
 * when only the shared block was warm: nothing proven live was lost.
 *
 * Returns `undefined` (no marker) for the first turn, turns whose predecessor
 * never read a warm prefix, tiny contexts, and turns that read back at least
 * half of the predecessor's warm prefix.
 *
 * A `cacheWrite` is deliberately not required. Explicit, prefix-controlled
 * caches (Anthropic / Bedrock `cache_control`) report it, but implicit
 * best-effort caches (Google / OpenAI / Fireworks, and the aggregators that
 * proxy them) report only `cacheRead`, so every cold turn there carries
 * `cacheWrite: 0` — requiring a write suppressed 100% of the observed misses
 * (0 of 628 warm→cold collapses across 52k requests). Since an unreported
 * split cannot prove a collapse is *not* a miss, the demonstrably warm → cold
 * transition decides on its own: the provider bills such a turn's whole prompt
 * as `input`, so `reprocessedTokens` still reports the uncached figure.
 */
export function detectCacheInvalidation(prev: Usage | undefined, current: Usage): CacheInvalidation | undefined {
	if (!prev) return undefined;
	// Only flag a warm→cold transition: the previous turn must have actually read
	// a meaningful prefix from cache. A write-only predecessor (first request, or
	// a re-write after expiry) has not proven the cache is live, so a cold turn
	// behind it is expected — not an invalidation worth surfacing.
	if (prev.cacheRead < MIN_CACHE_FOOTPRINT) return undefined;
	// The prefix survived when this turn read back at least half of what the
	// previous one did; normal turns read all of it plus the previous write.
	if (current.cacheRead * 2 >= prev.cacheRead) return undefined;
	// Explicit caches report the re-created prefix as `cacheWrite`; implicit
	// best-effort caches never report one, so a cold turn there bills the prompt
	// as `input`. Summing both keeps the reprocessed figure correct either way.
	const reprocessedTokens = current.cacheWrite + current.input;
	if (reprocessedTokens < MIN_CACHE_FOOTPRINT) return undefined;
	return { reprocessedTokens };
}
