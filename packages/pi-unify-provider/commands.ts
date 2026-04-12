import type { Api } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { ConfigStore } from "./config-store.js";
import {
	type AuthConfig,
	type AuthMethod,
	type ProviderConfigRecord,
	type UnifyModelConfig,
} from "./types.js";
import { WELL_KNOWN_PROVIDERS, type ALL_AUTH_METHODS } from "./well-known.js";
import { UnifyDashboardComponent, type DashboardAction } from "./ui.js";

interface RegisterCommandsInput {
	pi: ExtensionAPI;
	store: ConfigStore;
	refreshProviders: () => Promise<void>;
}

const API_OPTIONS: Api[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
	"mistral-conversations",
];

function dedupeModels(models: UnifyModelConfig[]): UnifyModelConfig[] {
	const byId = new Map<string, UnifyModelConfig>();
	for (const model of models) byId.set(model.id, model);
	return [...byId.values()];
}

function authMethodOptions(): AuthMethod[] {
	return [...WELL_KNOWN_PROVIDERS[0]!.supportedAuth] as typeof ALL_AUTH_METHODS;
}

async function promptApi(
	ctx: ExtensionCommandContext,
	current: Api,
): Promise<Api | undefined> {
	const selected = await ctx.ui.select(
		"Provider API type",
		API_OPTIONS.map((api) => (api === current ? `${api} (current)` : api)),
	);
	if (!selected) return undefined;
	return selected.replace(" (current)", "") as Api;
}

async function promptAuthConfig(
	ctx: ExtensionCommandContext,
	current: AuthConfig,
): Promise<AuthConfig | undefined> {
	const methodOptions = authMethodOptions();
	const selected = await ctx.ui.select(
		"Authentication method",
		methodOptions.map((method) =>
			method === current.method ? `${method} (current)` : method,
		),
	);
	if (!selected) return undefined;
	const method = selected.replace(" (current)", "") as AuthMethod;

	switch (method) {
		case "none":
			return { method: "none" };
		case "api-key": {
			const apiKey = await ctx.ui.input("API Key", current.method === "api-key" ? current.apiKey : undefined);
			if (!apiKey) return undefined;
			return { method: "api-key", apiKey };
		}
		case "bearer-token": {
			const token = await ctx.ui.input(
				"Bearer token",
				current.method === "bearer-token" ? current.token : undefined,
			);
			if (!token) return undefined;
			const headerName = await ctx.ui.input(
				"Header name (default Authorization)",
				current.method === "bearer-token" ? current.headerName : "Authorization",
			);
			return { method: "bearer-token", token, headerName: headerName || "Authorization" };
		}
		case "custom-header": {
			const headerName = await ctx.ui.input(
				"Header name",
				current.method === "custom-header" ? current.headerName : "X-API-Key",
			);
			if (!headerName) return undefined;
			const headerValue = await ctx.ui.input(
				"Header value",
				current.method === "custom-header" ? current.headerValue : undefined,
			);
			if (!headerValue) return undefined;
			return { method: "custom-header", headerName, headerValue };
		}
		case "query-param": {
			const paramName = await ctx.ui.input(
				"Query param name",
				current.method === "query-param" ? current.paramName : "api_key",
			);
			if (!paramName) return undefined;
			const paramValue = await ctx.ui.input(
				"Query param value",
				current.method === "query-param" ? current.paramValue : undefined,
			);
			if (!paramValue) return undefined;
			return { method: "query-param", paramName, paramValue };
		}
		case "browser-session": {
			const cookieHeader = await ctx.ui.input(
				"Cookie header",
				current.method === "browser-session" ? current.cookieHeader : undefined,
			);
			if (!cookieHeader) return undefined;
			return { method: "browser-session", cookieHeader };
		}
		case "oauth2": {
			const tokenUrl = await ctx.ui.input(
				"OAuth token URL",
				current.method === "oauth2" ? current.tokenUrl : undefined,
			);
			const clientId = await ctx.ui.input(
				"OAuth client ID",
				current.method === "oauth2" ? current.clientId : undefined,
			);
			const clientSecret = await ctx.ui.input(
				"OAuth client secret (optional)",
				current.method === "oauth2" ? current.clientSecret : undefined,
			);
			const token = await ctx.ui.input(
				"Access token (or JSON token payload)",
				current.method === "oauth2" ? current.token : undefined,
			);
			if (!tokenUrl || !clientId || !token) return undefined;
			return { method: "oauth2", tokenUrl, clientId, clientSecret, token };
		}
		case "oauth2-pkce": {
			const authorizationUrl = await ctx.ui.input(
				"Authorization URL",
				current.method === "oauth2-pkce" ? current.authorizationUrl : undefined,
			);
			const tokenUrl = await ctx.ui.input(
				"Token URL",
				current.method === "oauth2-pkce" ? current.tokenUrl : undefined,
			);
			const clientId = await ctx.ui.input(
				"Client ID",
				current.method === "oauth2-pkce" ? current.clientId : undefined,
			);
			const token = await ctx.ui.input(
				"Access token (or JSON token payload)",
				current.method === "oauth2-pkce" ? current.token : undefined,
			);
			if (!authorizationUrl || !tokenUrl || !clientId || !token) return undefined;
			return { method: "oauth2-pkce", authorizationUrl, tokenUrl, clientId, token };
		}
		case "oauth-device-code": {
			const deviceAuthorizationUrl = await ctx.ui.input(
				"Device authorization URL",
				current.method === "oauth-device-code"
					? current.deviceAuthorizationUrl
					: undefined,
			);
			const tokenUrl = await ctx.ui.input(
				"Token URL",
				current.method === "oauth-device-code" ? current.tokenUrl : undefined,
			);
			const clientId = await ctx.ui.input(
				"Client ID",
				current.method === "oauth-device-code" ? current.clientId : undefined,
			);
			const token = await ctx.ui.input(
				"Access token (or JSON token payload)",
				current.method === "oauth-device-code" ? current.token : undefined,
			);
			if (!deviceAuthorizationUrl || !tokenUrl || !clientId || !token) return undefined;
			return { method: "oauth-device-code", deviceAuthorizationUrl, tokenUrl, clientId, token };
		}
	}
}

async function promptModels(
	ctx: ExtensionCommandContext,
	current: UnifyModelConfig[],
): Promise<UnifyModelConfig[] | undefined> {
	const prefill = current.map((m) => m.id).join("\n");
	const edited = await ctx.ui.editor("Model IDs (one per line)", prefill);
	if (edited === undefined) return undefined;
	const ids = edited
		.split(/\r?\n|,/g)
		.map((value) => value.trim())
		.filter(Boolean);
	const byId = new Map(current.map((m) => [m.id, m]));
	return dedupeModels(ids.map((id) => byId.get(id) ?? { id }));
}

async function runAddProviderFlow(
	ctx: ExtensionCommandContext,
	store: ConfigStore,
): Promise<ProviderConfigRecord | undefined> {
	const presetName = await ctx.ui.select(
		"Add provider preset",
		WELL_KNOWN_PROVIDERS.map((preset) => `${preset.name} [${preset.category}]`),
	);
	if (!presetName) return undefined;
	const cleanName = presetName.replace(/ \[[^\]]+\]$/, "");
	const preset = WELL_KNOWN_PROVIDERS.find((p) => p.name === cleanName);
	if (!preset) return undefined;

	const name = await ctx.ui.input("Provider name", preset.name);
	if (!name) return undefined;
	const baseUrl = await ctx.ui.input("Base URL", preset.baseUrl);
	if (!baseUrl) return undefined;
	const api = await promptApi(ctx, preset.api);
	if (!api) return undefined;
	const auth = await promptAuthConfig(ctx, { method: preset.defaultAuth } as AuthConfig);
	if (!auth) return undefined;

	const provider: ProviderConfigRecord = {
		type: preset.id,
		name: name.trim(),
		baseUrl: baseUrl.trim(),
		api,
		auth,
		models: dedupeModels(preset.hardcodedModels ?? []),
		extraHeaders: preset.extraHeaders,
		extraQuery: preset.extraQuery,
		extraBody: preset.extraBody,
		autoFetchOfficialModels: !!preset.officialModelsEndpoint,
		updatedAt: Date.now(),
	};

	store.upsertProvider(provider);
	return provider;
}

async function runEditProviderFlow(
	ctx: ExtensionCommandContext,
	store: ConfigStore,
	providerName: string,
): Promise<boolean> {
	const provider = store.getProvider(providerName);
	if (!provider) return false;
	const baseUrl = await ctx.ui.input("Base URL", provider.baseUrl);
	if (!baseUrl) return false;
	const api = await promptApi(ctx, provider.api);
	if (!api) return false;
	const autoFetchOfficialModels = await ctx.ui.confirm(
		"Auto-fetch official models",
		"Enable official model refresh for this provider?",
	);
	provider.baseUrl = baseUrl.trim();
	provider.api = api;
	provider.autoFetchOfficialModels = autoFetchOfficialModels;
	provider.updatedAt = Date.now();
	store.upsertProvider(provider);
	return true;
}

async function runAuthEditFlow(
	ctx: ExtensionCommandContext,
	store: ConfigStore,
	providerName: string,
): Promise<boolean> {
	const provider = store.getProvider(providerName);
	if (!provider) return false;
	const auth = await promptAuthConfig(ctx, provider.auth);
	if (!auth) return false;
	provider.auth = auth;
	provider.updatedAt = Date.now();
	store.upsertProvider(provider);
	return true;
}

async function runModelsEditFlow(
	ctx: ExtensionCommandContext,
	store: ConfigStore,
	providerName: string,
): Promise<boolean> {
	const provider = store.getProvider(providerName);
	if (!provider) return false;
	const models = await promptModels(ctx, provider.models);
	if (!models) return false;
	provider.models = models;
	provider.updatedAt = Date.now();
	store.upsertProvider(provider);
	return true;
}

async function runDashboard(
	ctx: ExtensionCommandContext,
	store: ConfigStore,
	refreshProviders: () => Promise<void>,
): Promise<void> {
	if (!ctx.hasUI) return;
	while (true) {
		const providers = [...store.getProviders()].sort((a, b) => a.name.localeCompare(b.name));
		const action = await ctx.ui.custom<DashboardAction>(
			(_tui, theme, _kb, done) => new UnifyDashboardComponent(theme, providers, done),
			{ overlay: true, overlayOptions: { anchor: "center", width: 98, maxHeight: "85%" } },
		);
		if (!action || action.kind === "close") {
			return;
		}
		switch (action.kind) {
			case "add": {
				const added = await runAddProviderFlow(ctx, store);
				if (added) {
					await refreshProviders();
					ctx.ui.notify(`Added provider: ${added.name}`, "info");
				}
				break;
			}
			case "refresh": {
				await refreshProviders();
				ctx.ui.notify("Providers refreshed.", "info");
				break;
			}
			case "delete": {
				const ok = await ctx.ui.confirm(
					"Delete provider",
					`Delete provider '${action.providerName}'?`,
				);
				if (!ok) break;
				store.removeProvider(action.providerName);
				await refreshProviders();
				ctx.ui.notify(`Deleted provider: ${action.providerName}`, "warning");
				break;
			}
			case "edit": {
				const changed = await runEditProviderFlow(ctx, store, action.providerName);
				if (changed) {
					await refreshProviders();
					ctx.ui.notify(`Updated provider: ${action.providerName}`, "info");
				}
				break;
			}
			case "auth": {
				const changed = await runAuthEditFlow(ctx, store, action.providerName);
				if (changed) {
					await refreshProviders();
					ctx.ui.notify(`Updated auth for: ${action.providerName}`, "info");
				}
				break;
			}
			case "models": {
				const changed = await runModelsEditFlow(ctx, store, action.providerName);
				if (changed) {
					await refreshProviders();
					ctx.ui.notify(`Updated models for: ${action.providerName}`, "info");
				}
				break;
			}
		}
	}
}

export function registerCommands(input: RegisterCommandsInput): void {
	const { pi, store, refreshProviders } = input;

	pi.registerCommand("unify", {
		description: "Open unified provider dashboard",
		handler: async (_args, ctx) => {
			await runDashboard(ctx, store, refreshProviders);
		},
	});

	pi.registerCommand("unify-add", {
		description: "Add provider with guided flow",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const provider = await runAddProviderFlow(ctx, store);
			if (!provider) return;
			await refreshProviders();
			ctx.ui.notify(`Added provider: ${provider.name}`, "info");
		},
	});

	pi.registerCommand("unify-refresh", {
		description: "Refresh configured providers and models",
		handler: async (_args, ctx) => {
			await refreshProviders();
			if (ctx.hasUI) {
				ctx.ui.notify("Providers refreshed.", "info");
			}
		},
	});
}
