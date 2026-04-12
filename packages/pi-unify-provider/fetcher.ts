import { setTimeout as sleep } from "node:timers/promises";
import { withModelMetadata } from "./model-database.ts";
import type {
	ProviderConfigRecord,
	ResolvedAuth,
	UnifyModelConfig,
	WellKnownProviderPreset,
} from "./types.ts";

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

function toHeaders(provider: ProviderConfigRecord, auth?: ResolvedAuth): Record<string, string> {
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

	const parseId = (value: unknown): string | undefined => {
		if (typeof value === "string" && value.trim()) return value.trim();
		if (!value || typeof value !== "object") return undefined;
		const row = value as Record<string, unknown>;
		const id = row.id ?? row.model ?? row.model_id ?? row.name;
		return typeof id === "string" && id.trim() ? id.trim() : undefined;
	};

	const maybeArray = [
		(payload as { data?: unknown }).data,
		(payload as { models?: unknown }).models,
		(payload as { results?: unknown }).results,
		Array.isArray(payload) ? payload : undefined,
	].find((candidate) => Array.isArray(candidate));

	const out: UnifyModelConfig[] = [];
	if (Array.isArray(maybeArray)) {
		for (const row of maybeArray) {
			const id = parseId(row);
			if (id) out.push({ id });
		}
	}

	const modelsObject = (payload as { models?: unknown }).models;
	if (modelsObject && typeof modelsObject === "object" && !Array.isArray(modelsObject)) {
		for (const key of Object.keys(modelsObject as Record<string, unknown>)) {
			if (key.trim()) out.push({ id: key.trim() });
		}
	}

	if (out.length > 0) return out;

	const fallbackId = parseId(payload);
	if (fallbackId) return [{ id: fallbackId }];

	return [];
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
	// Precedence: hardcoded defaults < official fetched < manual overrides.
	const ordered = [...hardcoded, ...official, ...manual].map(withModelMetadata);
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
