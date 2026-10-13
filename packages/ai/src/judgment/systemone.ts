/**
 * TypeSafe System One dialects. The request body (`{ model, state, questions }`)
 * and answer map are TypeSafe's own, forwarded verbatim:
 *
 * - `typesafe`: `POST {baseUrl}/v1/systemone` — TypeSafe and every System One
 *   server (OpenJEV, Kev, self-hosted Clef, OpenCode Zen, Command Code).
 * - `openrouter-decisions`: `POST {baseUrl}/decisions` under OpenRouter's
 *   `/api/alpha`; usage adds the billed `cost` in USD.
 * - `workers-ai-systemone`: Cloudflare Workers AI's `POST {baseUrl}/{model}`
 *   (`/client/v4/accounts/<account>/ai/run/@cf/cloudflare/clef`). The body
 *   names the model by its last path segment (`clef`), the response arrives in
 *   Cloudflare's `{ result, success, errors }` envelope, and the credential is
 *   a Cloudflare API token plus the account id the URL needs.
 */
import type { JudgmentConfig } from "@oh-my-pi/pi-catalog/types";
import { parseCloudflareCredential } from "@oh-my-pi/pi-catalog/wire/cloudflare";
import { $env, isRecord } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { type Questions, tokenUsage } from "./types";
import { type DecodedJudgment, finiteNumber, type JudgmentWire } from "./wire";

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
		encode: (request, model) => ({ state: request.state, model, questions: encodeQuestions(request, judgment) }),
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

/** TypeSafe's own route, shared by every System One server. */
export const typesafeWire = systemOneWire("/v1/systemone");

/** OpenRouter Decisions: the System One body under `/api/alpha`. */
export const openrouterDecisionsWire = systemOneWire("/decisions");

/** Cloudflare Workers AI decision models (Clef) through the account-scoped `ai/run` route. */
export const workersAiWire: JudgmentWire = {
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
	}),
	decode: (payload, questions) =>
		isRecord(payload) ? decodeSystemOne(payload.result, questions ?? {}, undefined) : undefined,
};
