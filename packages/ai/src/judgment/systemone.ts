/**
 * TypeSafe and OpenRouter use the `{ model, state, questions }` body. Images
 * join `state` without replacing it (see {@link stateWithImages}): TypeSafe as
 * references to a top-level `assets` map, OpenRouter as `image_url` data URL
 * parts. Cloudflare optionally accepts image data URLs in its envelope.
 *
 * - `typesafe`: `POST {baseUrl}/v1/systemone` — TypeSafe and every System One
 *   server (OpenJEV, Kev, self-hosted Clef, OpenCode Zen, Command Code).
 * - `openrouter-decisions`: `POST {baseUrl}/decisions` under OpenRouter's
 *   `/api/alpha`; usage adds the billed `cost` in USD.
 * - `workers-ai-systemone`: Cloudflare Workers AI's `POST {baseUrl}/{model}`
 *   (`/client/v4/accounts/<account>/ai/run/@cf/cloudflare/clef`). The body
 *   names the model by its last path segment (`clef`), adds a top-level array
 *   of base64 data URLs when images are supplied, and returns Cloudflare's
 *   `{ result, success, errors }` envelope. The credential is a Cloudflare
 *   API token plus the account id the URL needs.
 */
import type { JudgmentConfig } from "@oh-my-pi/pi-catalog/types";
import { parseCloudflareCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare";
import { $env, isRecord } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { embeddedImageDataUrl } from "../images/shared";
import type { ImageContent } from "../types";
import { type JsonValue, type JudgmentRequest, type Questions, tokenUsage } from "./types";
import {
	type DecodedJudgment,
	finiteNumber,
	JEV_IMAGE_INPUT,
	type JudgmentImageAssets,
	type JudgmentWire,
} from "./wire";

/**
 * Canonical route of each System One dialect, appended to the base URL when a
 * model's `judgment` override names no `route`.
 */
const SYSTEM_ONE_PATHS = {
	typesafe: "/v1/systemone",
	"openrouter-decisions": "/decisions",
} as const;

/**
 * The answers of `payload` for `questions`, or `undefined` when the payload is
 * not a System One response.
 *
 * Without a `judgment` override the answers are forwarded verbatim ({@link NativeJudge}
 * checks each against its question's type). With one, the discriminator is read
 * from `typeField` and compared against the question's canonical type through
 * `typeMap`, then normalized back to the canonical shape: the answer always
 * carries `type`, and canonical value keys are recovered from their wire keys
 * (`valueMap`), the consumed wire key deleted so callers never see both spellings.
 */
function decodeSystemOne(
	payload: unknown,
	questions: Questions,
	judgment: JudgmentConfig | undefined,
): DecodedJudgment | undefined {
	if (!isRecord(payload) || !isRecord(payload.answers)) return undefined;
	const usage = isRecord(payload.usage) ? payload.usage : {};
	const decodedUsage = tokenUsage(
		finiteNumber(usage[judgment?.usageMap?.input ?? "input_tokens"]),
		finiteNumber(usage[judgment?.usageMap?.output ?? "output_tokens"]),
		finiteNumber(usage[judgment?.usageMap?.cost ?? "cost"]),
	);
	const base = {
		model: typeof payload.model === "string" ? payload.model : undefined,
		refused: [],
		usage: decodedUsage,
	};
	if (judgment === undefined) return { ...base, answers: payload.answers };

	const typeField = judgment.typeField ?? "type";
	const typeMap = judgment.typeMap;
	const valueMap = judgment.valueMap;
	const answers: Record<string, unknown> = {};
	for (const id in questions) {
		const raw = payload.answers[id];
		const canonical = questions[id].type;
		if (!isRecord(raw) || raw[typeField] !== (typeMap?.[canonical] ?? canonical)) continue;
		const answer: Record<string, unknown> = { ...raw, type: canonical };
		if (typeField !== "type") delete answer[typeField];
		if (valueMap !== undefined) {
			for (const canonicalKey of Object.keys(valueMap) as ("choice" | "noul" | "score")[]) {
				const wireKey = valueMap[canonicalKey];
				if (answer[canonicalKey] === undefined && wireKey !== undefined && answer[wireKey] !== undefined) {
					answer[canonicalKey] = answer[wireKey];
					delete answer[wireKey];
				}
			}
		}
		answers[id] = answer;
	}
	return { ...base, answers };
}

/** The `questions` of `request` in `judgment`'s wire shape: the discriminator renamed and type-mapped when configured. */
function encodeQuestions(
	request: { questions: Questions },
	judgment: JudgmentConfig | undefined,
): Record<string, Record<string, unknown>> {
	const typeField = judgment?.typeField ?? "type";
	const typeMap = judgment?.typeMap;
	const questions: Record<string, Record<string, unknown>> = Object.create(null) as Record<
		string,
		Record<string, unknown>
	>;
	for (const id in request.questions) {
		if (!Object.hasOwn(request.questions, id)) continue;
		const question = request.questions[id];
		const wire: Record<string, unknown> = { ...question, [typeField]: typeMap?.[question.type] ?? question.type };
		if (typeField !== "type") delete wire.type;
		questions[id] = wire;
	}
	return questions;
}

/** A System One dialect posting the request to `path` under the base URL with the key as bearer, in `judgment`'s shape. */
function systemOneWire(path: string, judgment?: JudgmentConfig): JudgmentWire {
	return {
		target: (baseUrl, _model, key) => ({ url: `${baseUrl}${path}`, token: key }),
		encode: (request: JudgmentRequest<Questions>, model) => ({
			state: request.state,
			model,
			questions: encodeQuestions(request, judgment),
		}),
		decode: (payload, questions) => decodeSystemOne(payload, questions ?? {}, judgment),
	};
}

/**
 * The System One dialect of `api` with `model.judgment`'s overrides applied:
 * its own route unless `judgment.route` names another, and its encode/decode
 * rewritten by the type/value/usage maps.
 *
 * @throws ConfigurationError when the API does not speak a System One dialect,
 * so an override can be neither applied nor silently ignored.
 */
export function systemOneWireFor(api: string, judgment: JudgmentConfig): JudgmentWire {
	const path = judgment.route ?? SYSTEM_ONE_PATHS[api as keyof typeof SYSTEM_ONE_PATHS];
	if (path === undefined) {
		throw new AIError.ConfigurationError(
			`judgment overrides are not supported for api "${api}"; only System One dialects (${Object.keys(SYSTEM_ONE_PATHS).join(", ")}) accept them`,
		);
	}
	return systemOneWire(path, judgment);
}

/**
 * `state` with `items` added and every original value kept: arrays gain them at the end, objects
 * under the first free `__omp_judgment_images[_N]` key, and a string root becomes `[state, ...items]`.
 */
function stateWithImages(state: JudgmentRequest["state"], items: readonly JsonValue[]): JudgmentRequest["state"] {
	if (Array.isArray(state)) return [...state, ...items];
	if (!isRecord(state)) return [state, ...items];
	const baseKey = "__omp_judgment_images";
	let key = baseKey;
	for (let suffix = 1; Object.hasOwn(state, key); suffix++) key = `${baseKey}_${suffix}`;
	return { ...state, [key]: items };
}

function* jsonStrings(value: unknown): Generator<string> {
	if (typeof value === "string") yield value;
	else if (Array.isArray(value)) for (const item of value) yield* jsonStrings(item);
	else if (isRecord(value)) for (const key in value) yield* jsonStrings(value[key]);
}

/**
 * The subset of `assets` that `request` references. TypeSafe substitutes a reference wherever it
 * occurs as text in a string of `state`, a question's `instructions`, or its `criteria` (never in
 * object keys) and rejects a request carrying an unreferenced asset.
 */
export function referencedImageAssets(request: JudgmentRequest, assets: JudgmentImageAssets): JudgmentImageAssets {
	const pending = new Set(Object.keys(assets));
	const visit = (value: unknown): void => {
		for (const text of jsonStrings(value)) {
			if (pending.size === 0) return;
			for (const reference of pending) if (text.includes(reference)) pending.delete(reference);
		}
	};
	visit(request.state);
	for (const id in request.questions) {
		const question = request.questions[id];
		visit(question.instructions);
		visit(question.criteria);
	}
	// `fromEntries` defines own properties, so a `__proto__` reference stays an ordinary key.
	return Object.fromEntries(Object.entries(assets).filter(([reference]) => !pending.has(reference)));
}

interface SystemOneImageAsset {
	type: "image";
	format: "png" | "jpeg";
	data_base64: string;
}

function encodeSystemOneImage(image: ImageContent): SystemOneImageAsset {
	const mimeType = image.mimeType.toLowerCase();
	return {
		type: "image",
		format: mimeType === "image/png" ? "png" : "jpeg",
		data_base64: Buffer.from(image.data, "base64").toString("base64"),
	};
}

/** TypeSafe's own route, shared by every System One server. */
export const typesafeWire: JudgmentWire = {
	...systemOneWire("/v1/systemone"),
	images: JEV_IMAGE_INPUT,
	supportsImageAssets: true,
	imagesRequireOptIn: true,
	imageHeaders: { "TypeSafe-Danger-Zone-Images": "true" },
	encode(request, model, imageAssets) {
		const suppliedAssets = Object.entries(imageAssets ?? {});
		const images = request.images ?? [];
		if (suppliedAssets.length === 0 && images.length === 0) {
			return { state: request.state, model, questions: request.questions };
		}

		const assets: Record<string, SystemOneImageAsset> = Object.fromEntries(
			suppliedAssets.map(([reference, image]) => [reference, encodeSystemOneImage(image)]),
		);
		const references: string[] = [];
		for (const image of images) {
			let reference = crypto.randomUUID();
			while (Object.hasOwn(assets, reference)) reference = crypto.randomUUID();
			assets[reference] = encodeSystemOneImage(image);
			references.push(reference);
		}

		return {
			state: references.length ? stateWithImages(request.state, references) : request.state,
			model,
			questions: request.questions,
			assets,
		};
	},
};

/** OpenRouter Decisions: System One body under `/api/alpha`, with image parts preserved in state. */
export const openrouterDecisionsWire: JudgmentWire = {
	...systemOneWire("/decisions"),
	images: JEV_IMAGE_INPUT,
	imagesRequireOptIn: true,
	encode(request, model) {
		const imageParts: JsonValue[] = (request.images ?? []).map(image => ({
			type: "image_url",
			image_url: {
				url: embeddedImageDataUrl(image),
				...(image.detail !== undefined ? { detail: image.detail === "original" ? "auto" : image.detail } : {}),
			},
		}));
		return {
			state: imageParts.length ? stateWithImages(request.state, imageParts) : request.state,
			model,
			questions: request.questions,
		};
	},
};

/** Cloudflare Workers AI decision models (Clef) through the account-scoped `ai/run` route. */
export const workersAiWire: JudgmentWire = {
	// Clef's `images` extension: https://developers.cloudflare.com/workers-ai/models/clef/
	images: {
		mimeTypes: ["image/png", "image/jpeg", "image/webp"],
		maxCount: 4,
		maxBytes: 4 * 1024 * 1024,
		maxTotalBytes: 8 * 1024 * 1024,
		maxPixels: 16_000_000,
	},
	target(baseUrl, model, key) {
		const credential = parseCloudflareCredential(key);
		const accountId = credential?.accountId ?? $env.CLOUDFLARE_ACCOUNT_ID?.trim();
		if (!accountId) {
			throw new AIError.ConfigurationError(
				"Cloudflare account ID is required: log in to Cloudflare Workers AI again or set CLOUDFLARE_ACCOUNT_ID",
			);
		}
		return { url: `${baseUrl.replace("<account>", accountId)}/${model}`, token: credential?.token ?? key };
	},
	encode: (request, model) => ({
		state: request.state,
		model: model.slice(model.lastIndexOf("/") + 1),
		questions: request.questions,
		...(request.images?.length ? { images: request.images.map(embeddedImageDataUrl) } : {}),
	}),
	decode: (payload, questions) =>
		isRecord(payload) ? decodeSystemOne(payload.result, questions ?? {}, undefined) : undefined,
};
