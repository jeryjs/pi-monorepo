import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import {
	applyResolvedAuthToPayload,
	resolveProviderAuth,
} from "./auth.js";
import { registerCommands } from "./commands.js";
import { ConfigStore } from "./config-store.js";
import { OfficialModelsFetcher } from "./fetcher.js";
import { SecretStore } from "./secret-store.js";
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	type ProviderConfigRecord,
	type ResolvedAuth,
	type UnifyModelConfig,
} from "./types.js";
import { getProviderPreset } from "./well-known.js";

interface ProviderAuthBinding {
	name: string;
	origin: string;
	pathPrefix: string;
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
		auth,
	};
}

function findBindingForPayload(
	payload: unknown,
	bindings: ProviderAuthBinding[],
): ProviderAuthBinding | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const urlString =
		typeof (payload as { url?: unknown }).url === "string"
			? ((payload as { url: string }).url)
			: undefined;
	if (!urlString) return undefined;
	const parsed = new URL(urlString);
	return bindings.find((binding) => {
		if (binding.origin !== parsed.origin) return false;
		return parsed.pathname.startsWith(binding.pathPrefix);
	});
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
		api: provider.api,
		authHeader: false,
		headers: auth.headers,
		models: provider.models.map((m) => toProviderModelConfig(provider, m)),
	};
}

async function registerConfiguredProviders(
	pi: ExtensionAPI,
	store: ConfigStore,
 	secrets: SecretStore,
 	fetcher: OfficialModelsFetcher,
 	bindings: ProviderAuthBinding[],
): Promise<void> {
	bindings.length = 0;
	const providers = [...store.getProviders()];
	for (const provider of providers) {
		const preset = getProviderPreset(provider.type);
		const auth = await resolveProviderAuth(provider, secrets);

		if (provider.autoFetchOfficialModels && preset) {
			try {
				const nextModels = await fetcher.fetchProviderModels({
					provider,
					preset,
					resolvedAuth: auth,
				});
				if (nextModels.length > 0) {
					provider.models = nextModels;
					store.upsertProvider({ ...provider, updatedAt: Date.now() });
				}
			} catch (error) {
				console.error(`[unify] failed to fetch official models for ${provider.name}:`, error);
			}
		}

		pi.registerProvider(provider.name, toRuntimeProviderConfig(provider, auth));
		bindings.push(createAuthBinding(provider, auth));
	}
}

export default function registerExtension(pi: ExtensionAPI): void {
	const store = new ConfigStore();
	const secrets = new SecretStore();
	const fetcher = new OfficialModelsFetcher();
	const bindings: ProviderAuthBinding[] = [];
	const refreshProviders = async () =>
		registerConfiguredProviders(pi, store, secrets, fetcher, bindings);

	registerCommands({
		pi,
		store,
		refreshProviders,
	});

	pi.on("before_provider_request", async (event) => {
		const binding = findBindingForPayload(event.payload, bindings);
		if (!binding) return;
		return applyResolvedAuthToPayload(event.payload, binding.auth);
	});

	pi.on("session_start", async (_event, _ctx) => {
		await refreshProviders();
	});
}
