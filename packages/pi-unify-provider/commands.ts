import type { Api } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { ConfigStore } from "./config-store.ts";
import { SecretStore } from "./secret-store.ts";
import {
	type AuthConfig,
	type AuthMethod,
	type OAuth2TokenData,
	type ProviderConfigRecord,
	type UnifyModelConfig,
} from "./types.ts";
import { WELL_KNOWN_PROVIDERS } from "./well-known.ts";
import {
	ModelManagerComponent,
	type DashboardAction,
	type ModelManagerAction,
	UnifyDashboardComponent,
} from "./ui.ts";

interface RegisterCommandsInput {
	pi: ExtensionAPI;
	store: ConfigStore;
	secrets: SecretStore;
	refreshProviders: () => Promise<void>;
	fetchOfficialModels: (providerName: string) => Promise<UnifyModelConfig[]>;
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

function generateUniqueProviderName(baseName: string, store: ConfigStore): string {
	if (!store.getProvider(baseName)) return baseName;
	let name = `${baseName} (copy)`;
	let n = 2;
	while (store.getProvider(name)) {
		name = `${baseName} (copy ${n})`;
		n++;
	}
	return name;
}

async function resolveProviderNameConflict(
	ctx: ExtensionCommandContext,
	store: ConfigStore,
	requestedName: string,
): Promise<string | undefined> {
	if (!store.getProvider(requestedName)) return requestedName;
	const choice = await ctx.ui.select("Provider already exists", [
		"Overwrite existing",
		"Rename as copy",
		"Cancel",
	]);
	if (!choice || choice === "Cancel") return undefined;
	if (choice === "Overwrite existing") return requestedName;
	return generateUniqueProviderName(requestedName, store);
}

function authMethodOptions(): AuthMethod[] {
	return [...WELL_KNOWN_PROVIDERS[0]!.supportedAuth];
}

function parseTokenData(raw: string): OAuth2TokenData {
	try {
		const parsed = JSON.parse(raw) as Partial<OAuth2TokenData>;
		if (parsed && typeof parsed.accessToken === "string" && parsed.accessToken.trim()) {
			return {
				accessToken: parsed.accessToken,
				refreshToken: parsed.refreshToken,
				tokenType: parsed.tokenType ?? "Bearer",
				expiresAt: parsed.expiresAt,
				scope: parsed.scope,
			};
		}
	} catch {
		// fallthrough to raw token wrapping.
	}
	return { accessToken: raw, tokenType: "Bearer" };
}

async function captureSecretValue(
	ctx: ExtensionCommandContext,
	secrets: SecretStore,
	label: string,
	prefill: string | undefined,
	kind: "api-key" | "generic" | "oauth-token",
): Promise<string | undefined> {
	const value = await ctx.ui.input(label, prefill);
	if (!value) return undefined;
	const secure = await ctx.ui.confirm(
		"Store as secret reference",
		"Store this value in local secret storage and keep only a reference?",
	);
	if (!secure) return value;
	const ref = secrets.createRef();
	if (kind === "api-key") {
		secrets.setApiKey(ref, value);
		return ref;
	}
	if (kind === "oauth-token") {
		secrets.setOAuthToken(ref, parseTokenData(value));
		return ref;
	}
	secrets.setGeneric(ref, value);
	return ref;
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
	secrets: SecretStore,
	current: AuthConfig,
): Promise<AuthConfig | undefined> {
	const methodOptions = authMethodOptions();
	const selected = await ctx.ui.select(
		"Authentication method",
		methodOptions.map((candidate) =>
			candidate === current.method ? `${candidate} (current)` : candidate,
		),
	);
	if (!selected) return undefined;
	const method = selected.replace(" (current)", "") as AuthMethod;

	switch (method) {
		case "none":
			return { method: "none" };
		case "api-key": {
			const apiKey = await captureSecretValue(
				ctx,
				secrets,
				"API Key",
				current.method === "api-key" ? current.apiKey : undefined,
				"api-key",
			);
			if (!apiKey) return undefined;
			return { method: "api-key", apiKey };
		}
		case "bearer-token": {
			const token = await captureSecretValue(
				ctx,
				secrets,
				"Bearer token",
				current.method === "bearer-token" ? current.token : undefined,
				"generic",
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
			const headerValue = await captureSecretValue(
				ctx,
				secrets,
				"Header value",
				current.method === "custom-header" ? current.headerValue : undefined,
				"generic",
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
			const paramValue = await captureSecretValue(
				ctx,
				secrets,
				"Query param value",
				current.method === "query-param" ? current.paramValue : undefined,
				"generic",
			);
			if (!paramValue) return undefined;
			return { method: "query-param", paramName, paramValue };
		}
		case "browser-session": {
			const cookieHeader = await captureSecretValue(
				ctx,
				secrets,
				"Cookie header",
				current.method === "browser-session" ? current.cookieHeader : undefined,
				"generic",
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
			const clientSecret = await captureSecretValue(
				ctx,
				secrets,
				"OAuth client secret (optional)",
				current.method === "oauth2" ? current.clientSecret : undefined,
				"generic",
			);
			const token = await captureSecretValue(
				ctx,
				secrets,
				"Access token (or JSON token payload)",
				current.method === "oauth2" ? current.token : undefined,
				"oauth-token",
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
			const token = await captureSecretValue(
				ctx,
				secrets,
				"Access token (or JSON token payload)",
				current.method === "oauth2-pkce" ? current.token : undefined,
				"oauth-token",
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
			const token = await captureSecretValue(
				ctx,
				secrets,
				"Access token (or JSON token payload)",
				current.method === "oauth-device-code" ? current.token : undefined,
				"oauth-token",
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
	secrets: SecretStore,
): Promise<ProviderConfigRecord | undefined> {
	const presetName = await ctx.ui.select(
		"Add provider preset",
		WELL_KNOWN_PROVIDERS.map((preset) => `${preset.name} [${preset.category}]`),
	);
	if (!presetName) return undefined;
	const cleanName = presetName.replace(/ \[[^\]]+\]$/, "");
	const preset = WELL_KNOWN_PROVIDERS.find((p) => p.name === cleanName);
	if (!preset) return undefined;

	let resolvedName = await resolveProviderNameConflict(ctx, store, preset.name);
	if (!resolvedName) return undefined;

	let baseUrl = preset.baseUrl;
	let api = preset.api;

	if (preset.id === "custom") {
		const customName = await ctx.ui.input("Provider name", preset.name);
		if (!customName) return undefined;
		resolvedName = await resolveProviderNameConflict(ctx, store, customName.trim());
		if (!resolvedName) return undefined;

		const customBaseUrl = await ctx.ui.input("Base URL", preset.baseUrl);
		if (!customBaseUrl) return undefined;
		baseUrl = customBaseUrl.trim();

		const customApi = await promptApi(ctx, preset.api);
		if (!customApi) return undefined;
		api = customApi;
	} else {
		const customize = await ctx.ui.confirm(
			"Known provider defaults",
			`Use defaults for ${preset.name}?\nEndpoint: ${preset.baseUrl}\nAPI: ${preset.api}`,
		);
		if (!customize) {
			const customBaseUrl = await ctx.ui.input("Base URL", preset.baseUrl);
			if (!customBaseUrl) return undefined;
			baseUrl = customBaseUrl.trim();

			const customApi = await promptApi(ctx, preset.api);
			if (!customApi) return undefined;
			api = customApi;
		}
	}

	const auth = await promptAuthConfig(ctx, secrets, { method: preset.defaultAuth } as AuthConfig);
	if (!auth) return undefined;

	const provider: ProviderConfigRecord = {
		type: preset.id,
		name: resolvedName,
		baseUrl,
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

	let changed = false;
	while (true) {
		const choice = await ctx.ui.select(`Edit provider: ${provider.name}`, [
			`Name: ${provider.name}`,
			`Base URL: ${provider.baseUrl}`,
			`API: ${provider.api}`,
			`Auto-fetch official models: ${provider.autoFetchOfficialModels ? "on" : "off"}`,
			"Done",
		]);

		if (!choice || choice === "Done") {
			break;
		}

		if (choice.startsWith("Name:")) {
			const nextName = await ctx.ui.input("Provider name", provider.name);
			if (!nextName) continue;
			const trimmed = nextName.trim();
			if (trimmed === provider.name) continue;
			const resolved = await resolveProviderNameConflict(ctx, store, trimmed);
			if (!resolved) continue;
			provider.name = resolved;
			changed = true;
			continue;
		}

		if (choice.startsWith("Base URL:")) {
			const nextBaseUrl = await ctx.ui.input("Base URL", provider.baseUrl);
			if (!nextBaseUrl) continue;
			provider.baseUrl = nextBaseUrl.trim();
			changed = true;
			continue;
		}

		if (choice.startsWith("API:")) {
			const nextApi = await promptApi(ctx, provider.api);
			if (!nextApi) continue;
			provider.api = nextApi;
			changed = true;
			continue;
		}

		if (choice.startsWith("Auto-fetch official models:")) {
			provider.autoFetchOfficialModels = !provider.autoFetchOfficialModels;
			changed = true;
		}
	}

	if (!changed) return false;
	provider.updatedAt = Date.now();
	store.upsertProvider(provider);
	return true;
}

async function runAuthEditFlow(
	ctx: ExtensionCommandContext,
	store: ConfigStore,
	secrets: SecretStore,
	providerName: string,
): Promise<boolean> {
	const provider = store.getProvider(providerName);
	if (!provider) return false;
	const auth = await promptAuthConfig(ctx, secrets, provider.auth);
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
	fetchOfficialModels: (providerName: string) => Promise<UnifyModelConfig[]>,
): Promise<boolean> {
	const provider = store.getProvider(providerName);
	if (!provider) return false;

	const editModelFields = async (
		model: UnifyModelConfig,
	): Promise<UnifyModelConfig | "delete" | undefined> => {
		const next: UnifyModelConfig = {
			...model,
			capabilities: { ...(model.capabilities ?? {}) },
		};

		while (true) {
			const choice = await ctx.ui.select(`Edit model: ${next.id}`, [
				`ID: ${next.id}`,
				`Name: ${next.name ?? "(none)"}`,
				`Family: ${next.family ?? "(none)"}`,
				`Context Window: ${next.contextWindow ?? "(unset)"}`,
				`Max Tokens: ${next.maxTokens ?? "(unset)"}`,
				`Tool Calling: ${next.capabilities?.toolCalling ? "on" : "off"}`,
				`Image Input: ${next.capabilities?.imageInput ? "on" : "off"}`,
				`Reasoning: ${next.capabilities?.reasoning ? "on" : "off"}`,
				"Delete model",
				"Done",
			]);

			if (!choice || choice === "Done") return next;
			if (choice === "Delete model") return "delete";

			if (choice.startsWith("ID:")) {
				const id = await ctx.ui.input("Model ID", next.id);
				if (!id) continue;
				next.id = id.trim();
				continue;
			}

			if (choice.startsWith("Name:")) {
				const name = await ctx.ui.input("Model name", next.name);
				next.name = name?.trim() || undefined;
				continue;
			}

			if (choice.startsWith("Family:")) {
				const family = await ctx.ui.input("Model family", next.family);
				next.family = family?.trim() || undefined;
				continue;
			}

			if (choice.startsWith("Context Window:")) {
				const value = await ctx.ui.input(
					"Context window tokens",
					next.contextWindow !== undefined ? String(next.contextWindow) : "",
				);
				if (!value) {
					next.contextWindow = undefined;
					continue;
				}
				const parsed = Number(value);
				if (Number.isFinite(parsed) && parsed > 0) next.contextWindow = parsed;
				continue;
			}

			if (choice.startsWith("Max Tokens:")) {
				const value = await ctx.ui.input(
					"Max output tokens",
					next.maxTokens !== undefined ? String(next.maxTokens) : "",
				);
				if (!value) {
					next.maxTokens = undefined;
					continue;
				}
				const parsed = Number(value);
				if (Number.isFinite(parsed) && parsed > 0) next.maxTokens = parsed;
				continue;
			}

			if (choice.startsWith("Tool Calling:")) {
				next.capabilities = {
					...(next.capabilities ?? {}),
					toolCalling: !next.capabilities?.toolCalling,
				};
				continue;
			}

			if (choice.startsWith("Image Input:")) {
				next.capabilities = {
					...(next.capabilities ?? {}),
					imageInput: !next.capabilities?.imageInput,
				};
				continue;
			}

			if (choice.startsWith("Reasoning:")) {
				next.capabilities = {
					...(next.capabilities ?? {}),
					reasoning: !next.capabilities?.reasoning,
				};
			}
		}
	};

	let working = dedupeModels([...provider.models]);

	while (true) {
		const official = await fetchOfficialModels(providerName);
		const allModels = dedupeModels([...official, ...working]);
		const action = await ctx.ui.custom<ModelManagerAction>(
			(_tui, theme, _kb, done) => new ModelManagerComponent(theme, allModels, working, done),
			{ overlay: true, overlayOptions: { anchor: "center", width: 110, maxHeight: "85%" } },
		);

		if (!action || action.kind === "cancel") {
			return false;
		}

		if (action.kind === "save") {
			provider.models = dedupeModels(action.models);
			provider.updatedAt = Date.now();
			store.upsertProvider(provider);
			return true;
		}

		if (action.kind === "add-custom") {
			const id = await ctx.ui.input("New model ID", "");
			if (!id) continue;
			const name = await ctx.ui.input("Model name (optional)", "");
			working = dedupeModels([
				...working,
				{
					id: id.trim(),
					name: name?.trim() || undefined,
				},
			]);
			continue;
		}

		if (action.kind === "edit-model") {
			const existing = working.find((m) => m.id === action.modelId);
			if (!existing) continue;
			const edited = await editModelFields(existing);
			if (!edited) continue;
			if (edited === "delete") {
				working = working.filter((m) => m.id !== action.modelId);
				continue;
			}
			working = dedupeModels([
				...working.filter((m) => m.id !== action.modelId),
				edited,
			]);
		}
	}
}

async function runOfficialModelsFlow(
	ctx: ExtensionCommandContext,
	store: ConfigStore,
	providerName: string,
	fetchOfficialModels: (providerName: string) => Promise<UnifyModelConfig[]>,
): Promise<boolean> {
	const provider = store.getProvider(providerName);
	if (!provider) return false;

	const officialModels = await fetchOfficialModels(providerName);
	if (officialModels.length === 0) {
		ctx.ui.notify(`No official models found for ${providerName}.`, "warning");
		return false;
	}

	const addAllLabel = "[Add all official models]";
	const selected = await ctx.ui.select(
		`Official models: ${providerName}`,
		[
			addAllLabel,
			...officialModels.map((model) => {
				const exists = provider.models.some((m) => m.id === model.id);
				return exists ? `${model.id} (already added)` : model.id;
			}),
		],
	);
	if (!selected) return false;

	if (selected === addAllLabel) {
		provider.models = dedupeModels([...provider.models, ...officialModels]);
	} else {
		const modelId = selected.replace(" (already added)", "");
		const model = officialModels.find((m) => m.id === modelId) ?? { id: modelId };
		provider.models = dedupeModels([...provider.models, model]);
	}

	provider.updatedAt = Date.now();
	store.upsertProvider(provider);
	return true;
}

async function pickProviderName(
	ctx: ExtensionCommandContext,
	store: ConfigStore,
	inputName?: string,
): Promise<string | undefined> {
	if (inputName && store.getProvider(inputName)) return inputName;
	const providers = store.getProviders();
	if (providers.length === 0) return undefined;
	if (inputName && !store.getProvider(inputName)) {
		ctx.ui.notify(`Provider not found: ${inputName}`, "warning");
	}
	return ctx.ui.select(
		"Select provider",
		providers.map((provider) => provider.name),
	);
}

async function runDashboard(
	ctx: ExtensionCommandContext,
	store: ConfigStore,
	secrets: SecretStore,
	refreshProviders: () => Promise<void>,
	fetchOfficialModels: (providerName: string) => Promise<UnifyModelConfig[]>,
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
				const added = await runAddProviderFlow(ctx, store, secrets);
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
				const changed = await runAuthEditFlow(ctx, store, secrets, action.providerName);
				if (changed) {
					await refreshProviders();
					ctx.ui.notify(`Updated auth for: ${action.providerName}`, "info");
				}
				break;
			}
			case "models": {
				const changed = await runModelsEditFlow(
					ctx,
					store,
					action.providerName,
					fetchOfficialModels,
				);
				if (changed) {
					await refreshProviders();
					ctx.ui.notify(`Updated models for: ${action.providerName}`, "info");
				}
				break;
			}
			case "official-models": {
				const changed = await runOfficialModelsFlow(
					ctx,
					store,
					action.providerName,
					fetchOfficialModels,
				);
				if (changed) {
					await refreshProviders();
					ctx.ui.notify(`Updated models for: ${action.providerName}`, "info");
				}
				break;
			}
		}
	}
}

function normalizeImportedProviders(raw: unknown): ProviderConfigRecord[] {
	const source = Array.isArray(raw)
		? raw
		: raw && typeof raw === "object" && Array.isArray((raw as { providers?: unknown }).providers)
			? ((raw as { providers: unknown[] }).providers)
			: undefined;
	if (!source) {
		throw new Error("Import must be a providers array or an object with { providers: [...] }");
	}
	const out: ProviderConfigRecord[] = [];
	for (const item of source) {
		if (!item || typeof item !== "object") continue;
		const provider = item as Partial<ProviderConfigRecord>;
		if (!provider.name || !provider.baseUrl || !provider.api || !provider.type || !provider.auth) continue;
		out.push({
			type: provider.type,
			name: provider.name,
			baseUrl: provider.baseUrl,
			api: provider.api,
			auth: provider.auth,
			models: Array.isArray(provider.models) ? provider.models : [],
			extraHeaders: provider.extraHeaders,
			extraQuery: provider.extraQuery,
			extraBody: provider.extraBody,
			autoFetchOfficialModels: provider.autoFetchOfficialModels,
			updatedAt: Date.now(),
		});
	}
	if (out.length === 0) {
		throw new Error("No valid providers found in import payload");
	}
	return out;
}

async function runImport(
	ctx: ExtensionCommandContext,
	store: ConfigStore,
	refreshProviders: () => Promise<void>,
	args: string,
): Promise<void> {
	if (!ctx.hasUI) return;
	const rawInput = args.trim()
		? args.trim()
		: await ctx.ui.editor("Paste provider import JSON", '{\n\t"providers": []\n}');
	if (!rawInput) return;
	const parsed = JSON.parse(rawInput);
	const providers = normalizeImportedProviders(parsed);
	const overwrite = await ctx.ui.confirm(
		"Import providers",
		`Replace current provider set with ${providers.length} imported provider(s)?`,
	);
	if (!overwrite) return;
	store.replaceProviders(providers);
	await refreshProviders();
	ctx.ui.notify(`Imported ${providers.length} provider(s).`, "info");
}

async function runExport(
	ctx: ExtensionCommandContext,
	store: ConfigStore,
): Promise<void> {
	if (!ctx.hasUI) return;
	const payload = JSON.stringify({ providers: store.getProviders() }, null, "\t");
	ctx.ui.setEditorText(payload);
	ctx.ui.notify("Export JSON was placed into the editor input.", "info");
}

export function registerCommands(input: RegisterCommandsInput): void {
	const { pi, store, secrets, refreshProviders, fetchOfficialModels } = input;

	pi.registerCommand("unify", {
		description: "Open unified provider dashboard",
		handler: async (_args, ctx) => {
			await runDashboard(ctx, store, secrets, refreshProviders, fetchOfficialModels);
		},
	});

	pi.registerCommand("unify-add", {
		description: "Add provider with guided flow",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const provider = await runAddProviderFlow(ctx, store, secrets);
			if (!provider) return;
			await refreshProviders();
			ctx.ui.notify(`Added provider: ${provider.name}`, "info");
		},
	});

	pi.registerCommand("unify-providers", {
		description: "Open unified provider dashboard",
		handler: async (_args, ctx) => {
			await runDashboard(ctx, store, secrets, refreshProviders, fetchOfficialModels);
		},
	});

	pi.registerCommand("unify-official-models", {
		description: "List and add official models for a provider",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const requestedName = args.trim() || undefined;
			const providerName = await pickProviderName(ctx, store, requestedName);
			if (!providerName) return;
			const changed = await runOfficialModelsFlow(
				ctx,
				store,
				providerName,
				fetchOfficialModels,
			);
			if (!changed) return;
			await refreshProviders();
			ctx.ui.notify(`Updated models for: ${providerName}`, "info");
		},
	});

	pi.registerCommand("unify-models", {
		description: "Edit provider models",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const requestedName = args.trim() || undefined;
			const providerName = await pickProviderName(ctx, store, requestedName);
			if (!providerName) return;
			const changed = await runModelsEditFlow(
				ctx,
				store,
				providerName,
				fetchOfficialModels,
			);
			if (!changed) return;
			await refreshProviders();
			ctx.ui.notify(`Updated models for: ${providerName}`, "info");
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

	pi.registerCommand("unify-import", {
		description: "Import provider configuration JSON",
		handler: async (args, ctx) => {
			try {
				await runImport(ctx, store, refreshProviders, args);
			} catch (error) {
				if (!ctx.hasUI) return;
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});

	pi.registerCommand("unify-export", {
		description: "Export provider configuration JSON",
		handler: async (_args, ctx) => {
			await runExport(ctx, store);
		},
	});
}
