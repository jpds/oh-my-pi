import { afterEach, describe, expect, test, vi } from "bun:test";
import { resolveOpenAIRequestSetup } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry/registry";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const ORIGINAL_MUNITO_BASE_URL = Bun.env.MUNITO_BASE_URL;

function restoreMunitoBaseUrl(): void {
	if (ORIGINAL_MUNITO_BASE_URL === undefined) {
		delete Bun.env.MUNITO_BASE_URL;
		return;
	}
	Bun.env.MUNITO_BASE_URL = ORIGINAL_MUNITO_BASE_URL;
}

afterEach(() => {
	restoreMunitoBaseUrl();
});

describe("Munito regional base URL redirect", () => {
	// Mirrors the bundled catalog rows, which hardcode the global host.
	const munitoModel = {
		provider: "munito",
		id: "qwen/qwen3.8-27b",
		api: "openai-completions",
		reasoning: true,
		baseUrl: "https://api.munito.ai/inference/v1",
	} as const;

	test("redirects bundled munito models to MUNITO_BASE_URL when set", () => {
		Bun.env.MUNITO_BASE_URL = "https://api.eu.munito.ai/inference/v1";
		const setup = resolveOpenAIRequestSetup(munitoModel, { apiKey: "munito-key", messages: [] });
		expect(setup.baseUrl).toBe("https://api.eu.munito.ai/inference/v1");
	});

	test("normalizes a bare regional host to the inference path", () => {
		Bun.env.MUNITO_BASE_URL = "api.us.munito.ai";
		const setup = resolveOpenAIRequestSetup(munitoModel, { apiKey: "munito-key", messages: [] });
		expect(setup.baseUrl).toBe("https://api.us.munito.ai/inference/v1");
	});

	test("keeps the bundled global endpoint when MUNITO_BASE_URL is unset", () => {
		delete Bun.env.MUNITO_BASE_URL;
		const setup = resolveOpenAIRequestSetup(munitoModel, { apiKey: "munito-key", messages: [] });
		expect(setup.baseUrl).toBe("https://api.munito.ai/inference/v1");
	});

	test("does not second-guess a model resolved to a regional endpoint", () => {
		// Discovery resolved a model to the US host via models.yml; a global
		// shell MUNITO_BASE_URL must not pull inference back to the EU.
		Bun.env.MUNITO_BASE_URL = "https://api.eu.munito.ai/inference/v1";
		const setup = resolveOpenAIRequestSetup(
			{ ...munitoModel, baseUrl: "https://api.us.munito.ai/inference/v1" },
			{ apiKey: "munito-key", messages: [] },
		);
		expect(setup.baseUrl).toBe("https://api.us.munito.ai/inference/v1");
	});

	test("does not redirect other openai-completions providers", () => {
		Bun.env.MUNITO_BASE_URL = "https://api.eu.munito.ai/inference/v1";
		const setup = resolveOpenAIRequestSetup(
			{
				provider: "openai",
				id: "gpt-5.5",
				api: "openai-completions",
				reasoning: false,
				baseUrl: "https://api.openai.com/v1",
			},
			{ apiKey: "sk-openai", messages: [] },
		);
		expect(setup.baseUrl).toBe("https://api.openai.com/v1");
	});
});

describe("Munito login probe", () => {
	const loginMunito = getProviderDefinition("munito")?.login;
	if (!loginMunito) throw new Error("Munito login is not registered");

	test("a login probe always validates against the global host", async () => {
		// One Munito key serves every host, so validation never consults the
		// regional override; `omp login munito` probes the declared global URL.
		Bun.env.MUNITO_BASE_URL = "api.us.munito.ai";
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			expect(url).toBe("https://api.munito.ai/inference/v1/models");
			return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
		});

		const apiKey = await loginMunito({ onPrompt: async () => " munitoai_test ", fetch: fetchMock });
		expect(apiKey).toBe("munitoai_test");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
