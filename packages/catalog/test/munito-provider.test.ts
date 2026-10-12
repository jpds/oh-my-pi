import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModelReferenceIndex } from "@oh-my-pi/pi-catalog/identity/bundled";
import { resolveModelReference } from "@oh-my-pi/pi-catalog/identity/reference";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import {
	isMunitoChatModelId,
	munitoModelManagerOptions,
	resolveMunitoBaseUrl,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const ORIGINAL_MUNITO_BASE_URL = Bun.env.MUNITO_BASE_URL;

function restoreMunitoBaseUrl(): void {
	if (ORIGINAL_MUNITO_BASE_URL === undefined) {
		delete Bun.env.MUNITO_BASE_URL;
		return;
	}
	Bun.env.MUNITO_BASE_URL = ORIGINAL_MUNITO_BASE_URL;
}

afterEach(() => {
	vi.restoreAllMocks();
	restoreMunitoBaseUrl();
});

/** Munito's public chat roster as probed on 2026-10-12 (OCR ids interleaved). */
const LIVE_PUBLIC_ROSTER = [
	{ id: "lightonai/lightonocr-2-1b" },
	{ id: "qwen/qwen3.8-27b" },
	{ id: "zai-org/glm-5.3-flash" },
	{ id: "aleph-alpha/kolibri-1" },
	{ id: "deepseek-ai/deepseek-v4-flash" },
	{ id: "google/gemma-4-12b" },
	{ id: "mistralai/mistral-small-4-119b-2603" },
	{ id: "qwen/qwen3.6-35b-a3b" },
	{ id: "munito/ocr-auto" },
	{ id: "munito/ocr-fast" },
];

const OCR_IDS = ["munito/ocr-auto", "munito/ocr-fast", "lightonai/lightonocr-2-1b"];

const CHAT_IDS = LIVE_PUBLIC_ROSTER.map(entry => entry.id)
	.filter(id => !OCR_IDS.includes(id))
	.sort();

function munitoModelsFetch(seen?: { url?: string; authorization?: string }): FetchImpl {
	return vi.fn(async (input: string | URL | Request, init?: { headers?: Record<string, string> }) => {
		if (seen) {
			seen.url = typeof input === "string" ? input : String(input);
			seen.authorization = init?.headers?.Authorization;
		}
		return new Response(
			JSON.stringify({
				object: "list",
				data: LIVE_PUBLIC_ROSTER.map(entry => ({ owned_by: "munito", object: "model", created: 0, ...entry })),
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as unknown as FetchImpl;
}

describe("Munito provider support", () => {
	test("discovery snapshots the chat roster and drops the interleaved OCR SKUs", async () => {
		const seen: { url?: string; authorization?: string } = {};
		const models = await munitoModelManagerOptions({
			apiKey: "munito-key",
			fetch: munitoModelsFetch(seen),
		}).fetchDynamicModels?.();

		// Chat ids only, sorted: the OCR ids never materialize.
		expect(models?.map(model => model.id)).toEqual(CHAT_IDS);

		const first = models?.[0];
		expect(first?.provider).toBe("munito");
		expect(first?.api).toBe("openai-completions");
		// Discovery probes the configured endpoint with the key.
		expect(seen.url).toBe("https://api.munito.ai/inference/v1/models");
		expect(seen.authorization).toBe("Bearer munito-key");
	});

	test("an id bundled nowhere recovers canonical params and clamps maxTokens", async () => {
		// Select a bundled upstream reasoning model munito does not seed, so the
		// assertion survives catalog shifts instead of a hardcoded id.
		const index = getBundledModelReferenceIndex();
		const upstream = [...index.exact.values()].find(
			model =>
				model.provider !== "munito" &&
				model.id.includes("/") &&
				model.reasoning === true &&
				(model.contextWindow ?? 0) > 0 &&
				model.thinking?.mode === "effort",
		);
		expect(upstream).toBeDefined();
		if (!upstream) throw new Error("no upstream reasoning model available");

		const fetch = (async () =>
			new Response(JSON.stringify({ object: "list", data: [{ id: upstream.id, owned_by: "munito" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as FetchImpl;
		const models = (await munitoModelManagerOptions({ apiKey: "k", fetch }).fetchDynamicModels?.()) ?? [];
		expect(models.map(model => model.id)).toEqual([upstream.id]);
		const recovered = models[0];
		const canonical = resolveModelReference(upstream.id, index);

		// Intrinsic capabilities survive; pricing never crosses providers.
		expect(recovered.reasoning).toBe(true);
		expect(recovered.thinking?.mode).toBe("effort");
		expect(recovered.contextWindow).toBe(canonical?.contextWindow ?? null);
		expect(recovered.maxTokens ?? Infinity).toBeLessThanOrEqual(recovered.contextWindow ?? Infinity);
		if (canonical?.maxTokens != null) {
			expect(recovered.maxTokens).toBe(Math.min(canonical.maxTokens, canonical.contextWindow ?? Infinity));
		}
		expect(recovered.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	test("a discovered id bundled nowhere recovers nothing and stays neutral", async () => {
		const futureFetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ object: "list", data: [{ id: "munito/test-chat-1", owned_by: "munito" }] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		) as unknown as FetchImpl;

		const models = await munitoModelManagerOptions({
			apiKey: "munito-key",
			fetch: futureFetch,
		}).fetchDynamicModels?.();
		const future = models?.find(model => model.id === "munito/test-chat-1");
		expect(future?.reasoning).toBe(false);
		expect(future?.thinking).toBeUndefined();
		expect(future?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(future?.input).toEqual(["text"]);
		expect(future?.contextWindow).toBeNull();
	});

	test("a retired model is pruned through the manager options, not just the descriptor", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-munito-prune-"));
		const dbPath = path.join(tempDir, "models.db");
		// Discovery is authoritative: a bundled-only id must disappear even when
		// the live roster serves its neighbors. Synthesized seed rows keep the
		// assertion independent of catalog regen.
		const bundled: ModelSpec<"openai-completions">[] = ["qwen/qwen3.8-27b", "munito/retired-chat-1"].map(id => ({
			id,
			name: id,
			api: "openai-completions",
			provider: "munito",
			baseUrl: "https://api.munito.ai/inference/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: null,
			maxTokens: null,
		}));
		const retired = "munito/retired-chat-1";
		const liveRoster = bundled.filter(model => model.id !== retired);
		const options = {
			...munitoModelManagerOptions({
				apiKey: "munito-key",
				fetch: (async () =>
					new Response(
						JSON.stringify({
							object: "list",
							data: liveRoster.map(model => ({ id: model.id, owned_by: "munito" })),
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					)) as unknown as FetchImpl,
			}),
			staticModels: bundled,
			cacheDbPath: dbPath,
		};

		try {
			expect(options.dynamicModelsAuthoritative).toBe(true);

			const result = await resolveProviderModels(options, "online");

			expect(result.models.map(model => model.id)).not.toContain(retired);
			expect(result.models.map(model => model.id)).toContain("qwen/qwen3.8-27b");
			expect(result.stale).toBe(false);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("MUNITO_BASE_URL redirects discovery to the regional endpoint", async () => {
		Bun.env.MUNITO_BASE_URL = "https://api.eu.munito.ai/inference/v1";
		const seen: { url?: string } = {};
		await munitoModelManagerOptions({
			apiKey: "munito-key",
			fetch: munitoModelsFetch(seen),
		}).fetchDynamicModels?.();
		expect(seen.url).toBe("https://api.eu.munito.ai/inference/v1/models");
	});

	test("a bare regional host normalizes to the inference path", async () => {
		Bun.env.MUNITO_BASE_URL = "api.us.munito.ai";
		const seen: { url?: string } = {};
		await munitoModelManagerOptions({
			apiKey: "munito-key",
			fetch: munitoModelsFetch(seen),
		}).fetchDynamicModels?.();
		expect(seen.url).toBe("https://api.us.munito.ai/inference/v1/models");
		expect(resolveMunitoBaseUrl()).toBe("https://api.us.munito.ai/inference/v1");
	});

	test("explicit config.baseUrl wins over the environment variable", () => {
		Bun.env.MUNITO_BASE_URL = "https://api.eu.munito.ai/inference/v1";
		expect(resolveMunitoBaseUrl({ baseUrl: "https://api.us.munito.ai/inference/v1" })).toBe(
			"https://api.us.munito.ai/inference/v1",
		);
		expect(resolveMunitoBaseUrl()).toBe("https://api.eu.munito.ai/inference/v1");
	});

	test("an unsuffixed config.baseUrl still probes the regional /inference/v1/models path", async () => {
		Bun.env.MUNITO_BASE_URL = "https://api.eu.munito.ai/inference/v1";
		const seen: { url?: string } = {};
		await munitoModelManagerOptions({
			apiKey: "munito-key",
			baseUrl: "api.us.munito.ai",
			fetch: munitoModelsFetch(seen),
		}).fetchDynamicModels?.();
		expect(seen.url).toBe("https://api.us.munito.ai/inference/v1/models");
	});

	test("an unset variable falls back to the global host", () => {
		delete Bun.env.MUNITO_BASE_URL;
		const seen: { url?: string } = {};
		return munitoModelManagerOptions({
			apiKey: "munito-key",
			fetch: munitoModelsFetch(seen),
		})
			.fetchDynamicModels?.()
			.then(() => {
				expect(seen.url).toBe("https://api.munito.ai/inference/v1/models");
			});
	});

	test("a warm cache is not served after the region changes", async () => {
		// EU-cached rows carry the EU baseUrl; serving them to the US host
		// would pin inference there for the TTL.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-munito-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		try {
			Bun.env.MUNITO_BASE_URL = "https://api.eu.munito.ai/inference/v1";
			const euOptions = {
				...munitoModelManagerOptions({ apiKey: "k", fetch: munitoModelsFetch() }),
				cacheDbPath: dbPath,
			};
			const eu = await resolveProviderModels(euOptions, "online");
			expect(eu.models.every(model => model.baseUrl === "https://api.eu.munito.ai/inference/v1")).toBe(true);

			Bun.env.MUNITO_BASE_URL = "https://api.us.munito.ai/inference/v1";
			const usOptions = {
				...munitoModelManagerOptions({ apiKey: "k", fetch: munitoModelsFetch() }),
				cacheDbPath: dbPath,
			};
			const us = await resolveProviderModels(usOptions, "online-if-uncached");
			expect(us.source).toBe("provider");
			expect(us.models.every(model => model.baseUrl === "https://api.us.munito.ai/inference/v1")).toBe(true);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("discovered rows carry the regional endpoint, not the bundled global host", async () => {
		Bun.env.MUNITO_BASE_URL = "https://api.us.munito.ai/inference/v1";
		const models = await munitoModelManagerOptions({
			apiKey: "munito-key",
			fetch: munitoModelsFetch(),
		}).fetchDynamicModels?.();
		expect(models?.length).toBeGreaterThan(0);
		for (const model of models ?? []) {
			expect(model.baseUrl).toBe("https://api.us.munito.ai/inference/v1");
		}
	});

	test("roster exclusion classifies Munito's OCR SKUs without touching chat ids", () => {
		expect(isMunitoChatModelId("qwen/qwen3.8-27b")).toBe(true);
		expect(isMunitoChatModelId("munito/ocr-auto")).toBe(false);
		expect(isMunitoChatModelId("   ")).toBe(false);
	});
});
