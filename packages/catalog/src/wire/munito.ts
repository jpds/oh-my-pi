/**
 * Munito gateway endpoint. Discovery, inference, and the model-cache
 * namespace all resolve through here, so one spelling of the override cannot
 * send them to different hosts.
 */
export const MUNITO_GLOBAL_BASE_URL = "https://api.munito.ai/inference/v1";

/**
 * Resolve a configured Munito base URL onto the gateway's `/inference/v1`
 * surface. Accepts the full URL, a schemeless host (`api.eu.munito.ai`),
 * trailing slashes, or an already-suffixed URL; blank resolves to the global
 * host.
 */
export function normalizeMunitoBaseUrl(value: string | undefined): string {
	const trimmed = value?.trim().replace(/\/+$/, "");
	if (!trimmed) return MUNITO_GLOBAL_BASE_URL;
	return withMunitoSurface(trimmed);
}

/** {@link normalizeMunitoBaseUrl}, but blank resolves to `undefined` so callers keep their own fallback. */
export function configuredMunitoBaseUrl(value: string | undefined): string | undefined {
	const trimmed = value?.trim().replace(/\/+$/, "");
	if (!trimmed) return undefined;
	return withMunitoSurface(trimmed);
}

function withMunitoSurface(trimmed: string): string {
	const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	return withScheme.endsWith("/inference/v1") ? withScheme : `${withScheme}/inference/v1`;
}
