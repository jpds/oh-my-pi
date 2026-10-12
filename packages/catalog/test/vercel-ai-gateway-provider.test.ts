import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { vercelAiGatewayModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { TempDir } from "@oh-my-pi/pi-utils";

function mockModelsList(
	data: (Record<string, unknown> & { id: string })[],
): typeof fetch {
	return (async () => Response.json({ object: "list", data })) as unknown as typeof fetch;
}

function byId(models: { id: string }[] | null | undefined): Map<string, { id: string }> {
	return new Map((models ?? []).map(model => [model.id, model]));
}

describe("Vercel AI Gateway provider", () => {
	test("caps meta/muse-spark-1.2-contributor output allowance to 131072 while preserving context window", async () => {
		// Vercel currently reports both context_window and max_tokens as 1M for the
		// contributor model, which makes Anthropic messages requests fail with 400
		// when prompt + max_tokens exceeds the shared context window. The mapper
		// must cap the output allowance while leaving the context window intact.
		const contributorId = "meta/muse-spark-1.2-contributor";
		const controlId = "anthropic/claude-sonnet-4-5-20250929";
		const fetchMock = (async () =>
			Response.json({
				object: "list",
				data: [
					{
						id: contributorId,
						object: "model",
						owned_by: "meta",
						tags: ["tool-use", "reasoning", "vision"],
						context_window: 1_048_576,
						max_tokens: 1_048_576,
						pricing: { input: 0.0000001, output: 0.0000002 },
					},
					{
						id: controlId,
						object: "model",
						owned_by: "anthropic",
						tags: ["tool-use", "reasoning"],
						context_window: 200_000,
						max_tokens: 8192,
						pricing: { input: 0.000003, output: 0.000015 },
					},
				],
			})) as unknown as typeof fetch;

		const options = vercelAiGatewayModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const byId = new Map((models ?? []).map(model => [model.id, model]));

		const contributor = byId.get(contributorId);
		expect(contributor).toBeDefined();
		expect(contributor?.contextWindow).toBe(1_048_576);
		expect(contributor?.maxTokens).toBe(131_072);

		const control = byId.get(controlId);
		expect(control).toBeDefined();
		expect(control?.contextWindow).toBe(200_000);
		expect(control?.maxTokens).toBe(8192);
	});

	test("strips a trailing /v1 from custom eval base URLs so the route does not double-prefix", async () => {
		const fetchMock = (async () =>
			Response.json({ object: "list", data: [{ id: "typesafe-ai/jev", type: "evaluation" }] })) as unknown as typeof fetch;
		const options = vercelAiGatewayModelManagerOptions({ baseUrl: "https://proxy.example/v1", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		const jev = (models ?? []).find(mo => mo.id === "typesafe-ai/jev");
		expect(jev?.baseUrl).toBe("https://proxy.example");
		// The other three seeds are appended (not discovered) — they must rebase too,
		// or a proxied consumer would send credential + request to the public gateway.
		expect(byId(models).get("liquid/d1")?.baseUrl).toBe("https://proxy.example");
	});

	test("maps type:evaluation rows to api typesafe kind judge beside chat rows", async () => {
		const chatId = "anthropic/claude-sonnet-4-5-20250929";
		const jevId = "typesafe-ai/jev";
		const fetchMock = (async () =>
			Response.json({
				object: "list",
				data: [
					{
						id: chatId,
						name: "Claude Sonnet 4.5",
						object: "model",
						owned_by: "anthropic",
						tags: ["tool-use"],
						context_window: 200_000,
						max_tokens: 8192,
						pricing: { input: 0.000003, output: 0.000015 },
					},
					{
						id: jevId,
						name: "Jev",
						object: "model",
						owned_by: "typesafe-ai",
						type: "evaluation",
						context_window: 32_000,
						pricing: { input: 0.000000042, output: 0 },
					},
				],
			})) as unknown as typeof fetch;

		const options = vercelAiGatewayModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		expect(models).not.toBeNull();
		const byId = new Map((models ?? []).map(model => [model.id, model]));

		const chat = byId.get(chatId);
		expect(chat?.api).toBe("anthropic-messages");
		expect(chat?.kind ?? "chat").toBe("chat");

		const jev = byId.get(jevId);
		expect(jev).toBeDefined();
		expect(jev?.api).toBe("typesafe");
		expect(jev?.kind).toBe("judge");
		expect(jev?.name).toBe("Jev");
		expect(jev?.reasoning).toBe(false);
		expect(jev?.input).toEqual(["text"]);
		expect(jev?.supportsTools).toBe(false);
		expect(jev?.cost?.input).toBeCloseTo(0.042, 9);
		expect(jev?.cost?.output).toBe(0);
		expect(jev?.contextWindow).toBe(32_000);
		// The mapper carries no judgment: the vercel-ai-gateway KDL default
		// supplies the /v1/evaluate wire contract through buildModel.
		expect(jev).not.toHaveProperty("judgment");
		// The judgment defaults must survive discovery → buildModel so ChainJudge routes at /v1/evaluate.
		if (!jev) throw new Error("expected the jev evaluation row");
		expect(buildModel(jev).judgment).toEqual({
			route: "/v1/evaluate",
			typeMap: { noul: "boolean" },
			valueMap: { noul: "probability" },
			usageMap: { input: "inputTokens", output: "outputTokens" },
		});
		expect(buildModel(jev).judgment?.route).toBe("/v1/evaluate");
		// Spec (user modelOverrides merged pre-rebuild) wins key-wise over the catalog baseline.
		expect(buildModel({ ...jev, judgment: { route: "/v1/custom", typeMap: { score: "number" } } }).judgment).toEqual({
			route: "/v1/custom",
			typeMap: { noul: "boolean", score: "number" },
			valueMap: { noul: "probability" },
			usageMap: { input: "inputTokens", output: "outputTokens" },
		});
	});

	test("chat filter drops non-tool-use rows while keeping evaluation rows", async () => {
		const chatId = "anthropic/claude-sonnet-4-5-20250929";
		const droppedChatId = "anthropic/claude-haiku-4-5-20251001";
		const jevId = "typesafe-ai/jev";
		const fetchMock = (async () =>
			Response.json({
				object: "list",
				data: [
					{
						id: chatId,
						object: "model",
						owned_by: "anthropic",
						tags: ["tool-use"],
						context_window: 200_000,
						max_tokens: 8192,
						pricing: { input: 0.000003, output: 0.000015 },
					},
					{
						id: droppedChatId,
						object: "model",
						owned_by: "anthropic",
						tags: ["reasoning"],
						context_window: 200_000,
						max_tokens: 8192,
						pricing: { input: 0.000001, output: 0.000005 },
					},
					{
						id: jevId,
						object: "model",
						owned_by: "typesafe-ai",
						type: "evaluation",
						context_window: 32_000,
						pricing: { input: 0.000000042, output: 0 },
					},
				],
			})) as unknown as typeof fetch;

		const options = vercelAiGatewayModelManagerOptions({ fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		const map = byId(models);
		expect(map.get(chatId)).toBeDefined();
		expect(map.get(droppedChatId)).toBeUndefined();
		expect(map.get(jevId)).toBeDefined();
	});

	test("detects image capability on evaluation rows via modalities.input or vision tag", async () => {
		const options = vercelAiGatewayModelManagerOptions({
			fetch: mockModelsList([
				{
					id: "typesafe-ai/modal-jev",
					object: "model",
					type: "evaluation",
					modalities: { input: ["text", "image"] },
				},
				{
					id: "typesafe-ai/tagged-jev",
					object: "model",
					type: "evaluation",
					tags: ["vision"],
				},
				{
					id: "typesafe-ai/plain-jev",
					object: "model",
					type: "evaluation",
				},
			]),
		});

		const models = await options.fetchDynamicModels?.();
		const map = byId(models);
		expect(map.get("typesafe-ai/modal-jev")?.input).toEqual(["text", "image"]);
		expect(map.get("typesafe-ai/tagged-jev")?.input).toEqual(["text", "image"]);
		expect(map.get("typesafe-ai/plain-jev")?.input).toEqual(["text"]);
	});
	test.each(["typesafe-ai/jev", "microsoft/microsoft-decision-1", "liquid/d1", "openai/gpt-6-luna-decisions"])(
		"forces refetch of stale cached eval row %s on static fingerprint mismatch",
		async id => {
			await using tempDir = await TempDir.create("@pi-catalog-vercel-cache-");
			const cacheDbPath = tempDir.join("models.db");
			const staleRow = {
				...buildModel({
					id,
					name: `${id} (stale)`,
					provider: "vercel-ai-gateway",
					api: "anthropic-messages",
					baseUrl: "https://ai-gateway.vercel.sh",
					reasoning: false,
					input: ["text"],
					cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32_768,
					maxTokens: 2_048,
				}),
				kind: "chat" as const,
				judgment: undefined,
			};

			writeModelCache(
				"vercel-ai-gateway",
				Date.now(),
				[staleRow],
				true,
				"mismatched-static-fingerprint",
				cacheDbPath,
			);

			let fetches = 0;
			const fetchMock = mockModelsList([
				{
					id,
					name: `${id} (Discovered)`,
					object: "model",
					type: "evaluation",
					context_window: 64_000,
				},
			]);

			const result = await resolveProviderModels(
				{
					...vercelAiGatewayModelManagerOptions({
						fetch: (async (input, init) => {
							fetches++;
							return fetchMock(input, init);
						}) as unknown as typeof fetch,
					}),
					cacheDbPath,
				},
				"online-if-uncached",
			);

			// The stale cached id is listed in dropCachedModelIdsOnStaticMismatch,
			// so the fingerprint mismatch forces a refetch instead of serving stale cache.
			expect(fetches).toBe(1);
			expect(result.source).toBe("provider");

			const row = result.models.find(model => model.id === id);
			expect(row).toBeDefined();
			expect(row?.kind).toBe("judge");
			expect(row?.api).toBe("typesafe");

			const updatedCache = readModelCache("vercel-ai-gateway", Number.POSITIVE_INFINITY, Date.now, cacheDbPath);
			const cachedRow = updatedCache?.models.find(model => model.id === id);
			expect(cachedRow?.kind).toBe("judge");
			expect(updatedCache?.models.some(model => model.id === id && model.kind === "chat")).toBe(false);
		},
	);

	test("bundled seed resolves with kind judge and KDL judgment contract", () => {
		const seededIds = [
			"typesafe-ai/jev",
			"microsoft/microsoft-decision-1",
			"liquid/d1",
			"openai/gpt-6-luna-decisions",
		];
		const seeds = seedModels("vercel-ai-gateway");
		expect(seeds.length).toBeGreaterThanOrEqual(seededIds.length);
		for (const id of seededIds) {
			const seed = seeds.find(model => model.id === id);
			expect(seed).toBeDefined();
			if (!seed) continue;
			const built = buildModel(seed);
			expect(built.kind).toBe("judge");
			expect(built.api).toBe("typesafe");
			expect(built.supportsTools).toBe(false);
			expect(built.judgment).toEqual({
				route: "/v1/evaluate",
				typeMap: { noul: "boolean" },
				valueMap: { noul: "probability" },
				usageMap: { input: "inputTokens", output: "outputTokens" },
			});
		}
	});

	test("seeded id is replaced cleanly by live discovery row (explicitKindModels replace, not dup)", async () => {
		const seeds = seedModels("vercel-ai-gateway").map(seed => buildModel(seed));
		const jevSeed = seeds.find(model => model.id === "typesafe-ai/jev");
		expect(jevSeed).toBeDefined();

		const options = vercelAiGatewayModelManagerOptions({
			fetch: mockModelsList([
				{
					id: "typesafe-ai/jev",
					name: "Jev (Discovered)",
					object: "model",
					owned_by: "typesafe-ai",
					type: "evaluation",
					context_window: 64_000,
					pricing: { input: 0.00000005, output: 0 },
				},
			]),
		});

		const result = await resolveProviderModels(
			{
				...options,
				staticModels: seeds,
				cacheDbPath: ":memory:",
			},
			"online",
		);

		const jevRows = result.models.filter(model => model.id === "typesafe-ai/jev");
		expect(jevRows).toHaveLength(1);
		const jev = jevRows[0];
		expect(jev?.name).toBe("Jev (Discovered)");
		expect(jev?.kind).toBe("judge");
		expect(jev?.contextWindow).toBe(64_000);
		expect(jev?.cost?.input).toBeCloseTo(0.05, 9);
		expect(jev?.judgment).toEqual({
			route: "/v1/evaluate",
			typeMap: { noul: "boolean" },
			valueMap: { noul: "probability" },
			usageMap: { input: "inputTokens", output: "outputTokens" },
		});
	});
});
