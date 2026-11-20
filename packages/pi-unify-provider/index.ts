import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	applyResolvedAuthToPayload,
	resolveProviderAuth,
} from "./auth.ts";
import { registerCommands } from "./commands.ts";
import { ConfigStore } from "./config-store.ts";
import { verboseLog } from "./debug.ts";
import { OfficialModelsFetcher } from "./fetcher.ts";
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	type ProviderConfigRecord,
	type ResolvedAuth,
	type UnifyModelConfig,
	type WellKnownProviderPreset,
} from "./types.ts";
import { ALL_AUTH_METHODS, getProviderPreset } from "./well-known.ts";

const DYNAMIC_API_KEY_PLACEHOLDER = "unify_dynamic_auth";

interface ProviderAuthBinding {
	name: string;
	origin: string;
	pathPrefix: string;
	modelIds: Set<string>;
	auth: ResolvedAuth;
}

function withQuery(baseUrl: string, query?: Record<string, string>): string {
	if (!query || Object.keys(query).length === 0) return baseUrl;
	const url = new URL(baseUrl);
	for (const [key, value] of Object.entries(query)) {
		url.searchParams.set(key, value);
	}
	return url.toString();
}

function createAuthBinding(
	provider: ProviderConfigRecord,
	auth: ResolvedAuth,
): ProviderAuthBinding {
	const parsed = new URL(provider.baseUrl);
	return {
		name: provider.name,
		origin: parsed.origin,
		pathPrefix: parsed.pathname || "/",
		modelIds: new Set(provider.models.map((model) => model.id)),
		auth,
	};
}

function findBindingForPayload(
	payload: unknown,
	bindings: ProviderAuthBinding[],
): ProviderAuthBinding | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const modelId =
		typeof (payload as { model?: unknown }).model === "string"
			? ((payload as { model: string }).model)
			: undefined;
	const urlString =
		typeof (payload as { url?: unknown }).url === "string"
			? ((payload as { url: string }).url)
			: undefined;
	if (urlString) {
		const parsed = new URL(urlString);
		const matchedByUrl = bindings.find((binding) => {
			if (binding.origin !== parsed.origin) return false;
			return parsed.pathname.startsWith(binding.pathPrefix);
		});
		if (matchedByUrl) return matchedByUrl;
	}
	if (!modelId) return undefined;
	const modelMatches = bindings.filter((binding) => binding.modelIds.has(modelId));
	return modelMatches.length === 1 ? modelMatches[0] : undefined;
}

function toProviderModelConfig(
	provider: ProviderConfigRecord,
	model: UnifyModelConfig,
): ProviderModelConfig {
	return {
		id: model.id,
		name: model.name || model.id,
		api: model.api ?? provider.api,
		reasoning: !!model.capabilities?.reasoning,
		input: model.capabilities?.imageInput ? ["text", "image"] : ["text"],
		cost: {
			input: model.cost?.input ?? 0,
			output: model.cost?.output ?? 0,
			cacheRead: model.cost?.cacheRead ?? 0,
			cacheWrite: model.cost?.cacheWrite ?? 0,
		},
		contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
	};
}

function toRuntimeProviderConfig(
	provider: ProviderConfigRecord,
	auth: ResolvedAuth,
): ProviderConfig {
	return {
		baseUrl: withQuery(provider.baseUrl, auth.query),
		apiKey: DYNAMIC_API_KEY_PLACEHOLDER,
		api: provider.api,
		authHeader: false,
		headers: auth.headers,
		models: provider.models
			.filter((m) => m.enabled !== false)
			.map((m) => toProviderModelConfig(provider, m)),
	};
}

async function registerConfiguredProviders(
	pi: ExtensionAPI,
	store: ConfigStore,
 	fetcher: OfficialModelsFetcher,
 	bindings: ProviderAuthBinding[],
): Promise<void> {
	bindings.length = 0;
	const providers = [...store.getProviders()];
	const startTime = Date.now();
	verboseLog("runtime", "registerConfiguredProviders start", { providerCount: providers.length });
	for (const provider of providers) {
		const auth = await resolveProviderAuth(provider);

		pi.registerProvider(provider.name, toRuntimeProviderConfig(provider, auth));
		bindings.push(createAuthBinding(provider, auth));
		verboseLog("runtime", "provider registered", {
			name: provider.name,
			type: provider.type,
			modelCount: provider.models.length,
			baseUrl: provider.baseUrl,
		});
	}
	verboseLog("runtime", "registerConfiguredProviders done", { registeredCount: providers.length, timeTakenMs: Date.now() - startTime });
}

export default function registerExtension(pi: ExtensionAPI): void {
	const store = new ConfigStore();
	const fetcher = new OfficialModelsFetcher();
	const bindings: ProviderAuthBinding[] = [];
	const refreshProviders = async () => registerConfiguredProviders(pi, store, fetcher, bindings);
	const fetchOfficialModels = async (providerName: string): Promise<UnifyModelConfig[]> => {
		verboseLog("runtime", "fetchOfficialModels request", { providerName });
		const provider = store.getProvider(providerName);
		if (!provider) return [];
		const preset = getProviderPreset(provider.type);
		const basePath = (() => {
			try {
				return new URL(provider.baseUrl).pathname;
			} catch {
				return "/";
			}
		})();
		const effectivePreset: WellKnownProviderPreset =
			preset ?? {
				id: "custom",
				name: provider.name,
				category: "Custom",
				description: provider.description ?? "Fallback official model discovery",
				baseUrl: provider.baseUrl,
				api: provider.api,
				supportedAuth: ALL_AUTH_METHODS,
				defaultAuth: provider.auth.method,
				officialModelsEndpoint: provider.officialModelsEndpoint ?? (basePath === "/" ? "/v1/models" : "/models"),
			};
		const auth = await resolveProviderAuth(provider);
		const models = await fetcher.fetchProviderModels({
			provider: { ...provider, models: [] },
			preset: effectivePreset,
			resolvedAuth: auth,
		});
		verboseLog("runtime", "fetchOfficialModels done", {
			providerName,
			modelCount: models.length,
		});
		return models;
	};

	// Register providers on extension load
	refreshProviders();

	// Register commands
	registerCommands({
		pi,
		store,
		refreshProviders,
		fetchOfficialModels,
	});

	// Apply auth to outgoing provider requests
	pi.on("before_provider_request", async (event) => {
		const binding = findBindingForPayload(event.payload, bindings);
		if (!binding) return;
		verboseLog("runtime", "before_provider_request", {
			provider: binding.name,
			payloadKeys: event.payload && typeof event.payload === "object"
				? Object.keys(event.payload as Record<string, unknown>)
				: [],
		});
		return applyResolvedAuthToPayload(event.payload, binding.auth);
	});

	// pi.on("session_start", async (_event, ctx) => {
	// 	await refreshProviders();
	// });
}
