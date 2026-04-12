import { setTimeout as sleep } from "node:timers/promises";
import { withModelMetadata } from "./model-database.js";
import type {
	ProviderConfigRecord,
	ResolvedAuth,
	UnifyModelConfig,
	WellKnownProviderPreset,
} from "./types.js";

export interface FetcherOptions {
	retries?: number;
	baseDelayMs?: number;
	timeoutMs?: number;
}

export interface FetchProviderInput {
	provider: ProviderConfigRecord;
	preset?: WellKnownProviderPreset;
	resolvedAuth?: ResolvedAuth;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_TIMEOUT_MS = 20_000;

const JSON_CONTENT_TYPE = "application/json";

function withTimeoutSignal(timeoutMs: number): AbortSignal {
	return AbortSignal.timeout(timeoutMs);
}

function ensureAbsoluteUrl(baseUrl: string, endpoint: string): string {
	if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
		return endpoint;
	}
	const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
	return `${base}${path}`;
}

function toHeaders(provider: ProviderConfigRecord, auth?: ResolvedAuth): HeadersInit {
	return {
		accept: JSON_CONTENT_TYPE,
		"content-type": JSON_CONTENT_TYPE,
		...(provider.extraHeaders ?? {}),
		...(auth?.headers ?? {}),
	};
}

function toUrl(provider: ProviderConfigRecord, endpoint: string, auth?: ResolvedAuth): string {
	const url = new URL(ensureAbsoluteUrl(provider.baseUrl, endpoint));
	for (const [key, value] of Object.entries(provider.extraQuery ?? {})) {
		url.searchParams.set(key, value);
	}
	for (const [key, value] of Object.entries(auth?.query ?? {})) {
		url.searchParams.set(key, value);
	}
	return url.toString();
}

function parseOpenAIModelList(payload: unknown): UnifyModelConfig[] {
	if (!payload || typeof payload !== "object") return [];
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data)) return [];
	const out: UnifyModelConfig[] = [];
	for (const row of data) {
		if (!row || typeof row !== "object") continue;
		const id = (row as { id?: unknown }).id;
		if (typeof id !== "string" || id.length === 0) continue;
		out.push({ id });
	}
	return out;
}

function dedupeById(models: UnifyModelConfig[]): UnifyModelConfig[] {
	const byId = new Map<string, UnifyModelConfig>();
	for (const model of models) {
		byId.set(model.id, model);
	}
	return [...byId.values()];
}

function mergeModels(
	manual: UnifyModelConfig[],
	official: UnifyModelConfig[],
	hardcoded: UnifyModelConfig[],
): UnifyModelConfig[] {
	const ordered = [...manual, ...official, ...hardcoded].map(withModelMetadata);
	return dedupeById(ordered);
}

async function fetchJsonWithRetry(
	url: string,
	init: RequestInit,
	options: Required<FetcherOptions>,
): Promise<unknown> {
	let lastError: unknown;
	for (let attempt = 0; attempt < options.retries; attempt++) {
		try {
			const response = await fetch(url, { ...init, signal: withTimeoutSignal(options.timeoutMs) });
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} from ${url}`);
			}
			return await response.json();
		} catch (error) {
			lastError = error;
			if (attempt === options.retries - 1) break;
			await sleep(options.baseDelayMs * 2 ** attempt);
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function defaultPerplexityModels(): UnifyModelConfig[] {
	return [
		{ id: "sonar" },
		{ id: "sonar-pro" },
		{ id: "sonar-reasoning" },
		{ id: "sonar-reasoning-pro" },
	];
}

function fallbackModelsForProvider(providerType: ProviderConfigRecord["type"]): UnifyModelConfig[] {
	switch (providerType) {
		case "perplexity":
			return defaultPerplexityModels();
		default:
			return [];
	}
}

export class OfficialModelsFetcher {
	private readonly options: Required<FetcherOptions>;

	constructor(options: FetcherOptions = {}) {
		this.options = {
			retries: options.retries ?? DEFAULT_RETRIES,
			baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
			timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		};
	}

	async fetchProviderModels(input: FetchProviderInput): Promise<UnifyModelConfig[]> {
		const { provider, preset, resolvedAuth } = input;
		const endpoint = preset?.officialModelsEndpoint;
		const hardcoded = preset?.hardcodedModels ?? fallbackModelsForProvider(provider.type);

		if (!endpoint) {
			return mergeModels(provider.models, [], hardcoded);
		}

		const url = toUrl(provider, endpoint, resolvedAuth);
		const payload = await fetchJsonWithRetry(
			url,
			{ method: "GET", headers: toHeaders(provider, resolvedAuth) },
			this.options,
		);
		const fetched = parseOpenAIModelList(payload);
		return mergeModels(provider.models, fetched, hardcoded);
	}
}

export { mergeModels };
