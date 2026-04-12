import type { Api } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { ConfigStore } from "./config-store.ts";
import { verboseLog } from "./debug.ts";
import { SecretStore } from "./secret-store.ts";
import {
	type AuthConfig,
	type AuthMethod,
	type OAuth2TokenData,
	type ProviderConfigRecord,
	type UnifyModelConfig,
} from "./types.ts";
import {
	formatModelProperties,
	SearchSelectorComponent,
	type SearchSelectorItem,
	toDashboardItems,
	toDashboardSelectorItems,
} from "./ui.ts";
import { WELL_KNOWN_PROVIDERS } from "./well-known.ts";

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

type ChoiceOption = string | SearchSelectorItem;

function toChoiceItem(option: ChoiceOption): SearchSelectorItem {
	if (typeof option === "string") {
		return { value: option, label: option };
	}
	return option;
}

async function selectWithSearch(
	ctx: ExtensionCommandContext,
	title: string,
	options: ChoiceOption[],
	hints?: string,
	initialSearchInput?: string,
): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	const items = options.map(toChoiceItem);
	const selected = await ctx.ui.custom<string | undefined>(
		(_tui, theme, _kb, done) =>
			new SearchSelectorComponent(
				theme,
				title,
				items,
				(value) => done(value),
				() => done(undefined),
				hints,
				initialSearchInput,
			),
		{ overlay: true, overlayOptions: { anchor: "center", width: 98, maxHeight: "85%" } },
	);
	if (selected !== undefined) return selected;

	// pi-test-harness mock custom() has zero-arg signature and always returns undefined.
	// In that case, fall back to select() so tests remain deterministic.
	if (ctx.ui.custom.length > 0) return undefined;

	const labels = items.map((item) => item.label);
	const fallbackSelection = await ctx.ui.select(title, labels);
	if (!fallbackSelection) return undefined;
	const matched = items.find((item) => item.label === fallbackSelection);
	return matched?.value;
}

function dedupeModels(models: UnifyModelConfig[]): UnifyModelConfig[] {
	const byUid = new Map<string, UnifyModelConfig>();
	for (const input of models) {
		const model = ensureModelIdentity(input);
		byUid.set(model.uid!, model);
	}
	return [...byUid.values()];
}

function ensureModelIdentity(model: UnifyModelConfig, source: "user" | "official" = "user"): UnifyModelConfig {
	return {
		...model,
		uid: model.uid ?? randomUUID(),
		source: model.source ?? source,
		enabled: model.enabled ?? (source === "user"),
	};
}

function buildModelUniverse(
	selectedModels: UnifyModelConfig[],
	officialModels: UnifyModelConfig[],
): UnifyModelConfig[] {
	const selected = selectedModels.map((m) => ensureModelIdentity(m, "user"));
	const selectedById = new Set(selected.map((m) => m.id));
	const remainingOfficial = officialModels
		.filter((m) => !selectedById.has(m.id))
		.map((m) => ensureModelIdentity({ ...m, enabled: false }, "official"));

	return [...selected, ...remainingOfficial];
}

function sortModelsForAllTab(models: UnifyModelConfig[]): UnifyModelConfig[] {
	return [...models].sort((a, b) => {
		const aEnabled = a.enabled ? 1 : 0;
		const bEnabled = b.enabled ? 1 : 0;
		if (aEnabled !== bEnabled) return bEnabled - aEnabled;

		const aUser = a.source === "user" ? 1 : 0;
		const bUser = b.source === "user" ? 1 : 0;
		if (aUser !== bUser) return bUser - aUser;

		return a.id.localeCompare(b.id);
	});
}

function addOrEnableModelById(
	models: UnifyModelConfig[],
	candidate: UnifyModelConfig,
): UnifyModelConfig[] {
	const target = ensureModelIdentity({ ...candidate, source: "user", enabled: true }, "user");
	const existing = models.find((m) => m.id === target.id);
	if (!existing) {
		return dedupeModels([...models, target]);
	}
	return dedupeModels(models.map((m) =>
		m.uid === existing.uid
			? ensureModelIdentity({ ...m, enabled: true, source: "user" }, "user")
			: m,
	));
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
	const choice = await selectWithSearch(ctx, "Provider already exists", [
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
	const value = await ctx.ui.editor(label, prefill ?? "");
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

async function promptEditableValue(
	ctx: ExtensionCommandContext,
	title: string,
	currentValue: string | undefined,
): Promise<string | undefined> {
	const edited = await ctx.ui.editor(title, currentValue ?? "");
	if (edited === undefined) return undefined;
	return edited.trim();
}

async function promptApi(
	ctx: ExtensionCommandContext,
	current: Api,
): Promise<Api | undefined> {
	const selected = await selectWithSearch(
		ctx,
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
	const selected = await selectWithSearch(
		ctx,
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
			const headerName = await promptEditableValue(
				ctx,
				"Header name (default Authorization)",
				current.method === "bearer-token" ? current.headerName : "Authorization",
			);
			return { method: "bearer-token", token, headerName: headerName || "Authorization" };
		}
		case "custom-header": {
			const headerName = await promptEditableValue(
				ctx,
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
			const paramName = await promptEditableValue(
				ctx,
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
			const tokenUrl = await promptEditableValue(
				ctx,
				"OAuth token URL",
				current.method === "oauth2" ? current.tokenUrl : undefined,
			);
			const clientId = await promptEditableValue(
				ctx,
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
			const authorizationUrl = await promptEditableValue(
				ctx,
				"Authorization URL",
				current.method === "oauth2-pkce" ? current.authorizationUrl : undefined,
			);
			const tokenUrl = await promptEditableValue(
				ctx,
				"Token URL",
				current.method === "oauth2-pkce" ? current.tokenUrl : undefined,
			);
			const clientId = await promptEditableValue(
				ctx,
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
			const deviceAuthorizationUrl = await promptEditableValue(
				ctx,
				"Device authorization URL",
				current.method === "oauth-device-code"
					? current.deviceAuthorizationUrl
					: undefined,
			);
			const tokenUrl = await promptEditableValue(
				ctx,
				"Token URL",
				current.method === "oauth-device-code" ? current.tokenUrl : undefined,
			);
			const clientId = await promptEditableValue(
				ctx,
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

async function runAddProviderFlow(
	ctx: ExtensionCommandContext,
	store: ConfigStore,
	secrets: SecretStore,
): Promise<ProviderConfigRecord | undefined> {
	const presetName = await selectWithSearch(
		ctx,
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
		const customName = await promptEditableValue(ctx, "Provider name", preset.name);
		if (!customName) return undefined;
		resolvedName = await resolveProviderNameConflict(ctx, store, customName.trim());
		if (!resolvedName) return undefined;

		const customBaseUrl = await promptEditableValue(ctx, "Base URL", preset.baseUrl);
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
			const customBaseUrl = await promptEditableValue(ctx, "Base URL", preset.baseUrl);
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
		models: [],
		extraHeaders: preset.extraHeaders,
		extraQuery: preset.extraQuery,
		extraBody: preset.extraBody,
		updatedAt: Date.now(),
	};

	store.upsertProvider(provider);
	verboseLog("commands", "provider added", {
		name: provider.name,
		type: provider.type,
		baseUrl: provider.baseUrl,
		modelCount: provider.models.length,
	});
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
		const choice = await selectWithSearch(ctx, `Edit provider: ${provider.name}`, [
			`Name: ${provider.name}`,
			`Base URL: ${provider.baseUrl}`,
			`API: ${provider.api}`,
			"Delete provider",
			"Done",
		]);

		if (!choice || choice === "Done") {
			break;
		}

		if (choice.startsWith("Name:")) {
			const nextName = await promptEditableValue(ctx, "Provider name", provider.name);
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
			const nextBaseUrl = await promptEditableValue(ctx, "Base URL", provider.baseUrl);
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

		if (choice === "Delete provider") {
			const ok = await ctx.ui.confirm(
				"Delete provider",
				`Delete provider '${provider.name}'? This cannot be undone.`,
			);
			if (!ok) continue;
			store.removeProvider(provider.name);
			verboseLog("commands", "provider deleted from settings", { name: provider.name });
			return true;
		}

	}

	if (!changed) return false;
	provider.updatedAt = Date.now();
	store.upsertProvider(provider);
	verboseLog("commands", "provider edited", {
		name: provider.name,
		baseUrl: provider.baseUrl,
		api: provider.api,
	});
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
	verboseLog("commands", "provider auth updated", {
		name: provider.name,
		authMethod: provider.auth.method,
	});
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

	const editModelFields = async (model: UnifyModelConfig): Promise<UnifyModelConfig | "delete" | undefined> => {
		const next: UnifyModelConfig = {
			...ensureModelIdentity(model, model.source ?? "user"),
			source: "user",
			capabilities: { ...(model.capabilities ?? {}) },
		};

		while (true) {
			const choice = await selectWithSearch(ctx, `Edit model: ${next.id}`, [
				`Enabled: ${next.enabled ? "on" : "off"}`,
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

			if (choice.startsWith("Enabled:")) {
				next.enabled = !next.enabled;
				continue;
			}
			if (choice.startsWith("ID:")) {
				const id = await promptEditableValue(ctx, "Model ID", next.id);
				if (!id) continue;
				next.id = id.trim();
				continue;
			}
			if (choice.startsWith("Name:")) {
				const name = await promptEditableValue(ctx, "Model name", next.name ?? "");
				next.name = name?.trim() || undefined;
				continue;
			}
			if (choice.startsWith("Family:")) {
				const family = await promptEditableValue(ctx, "Model family", next.family ?? "");
				next.family = family?.trim() || undefined;
				continue;
			}
			if (choice.startsWith("Context Window:")) {
				const value = await promptEditableValue(
					ctx,
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
				const value = await promptEditableValue(
					ctx,
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
				next.capabilities = { ...(next.capabilities ?? {}), toolCalling: !next.capabilities?.toolCalling };
				continue;
			}
			if (choice.startsWith("Image Input:")) {
				next.capabilities = { ...(next.capabilities ?? {}), imageInput: !next.capabilities?.imageInput };
				continue;
			}
			if (choice.startsWith("Reasoning:")) {
				next.capabilities = { ...(next.capabilities ?? {}), reasoning: !next.capabilities?.reasoning };
			}
		}
	};

	let working = dedupeModels(provider.models.map((m) => ensureModelIdentity(m, "user")));
	let cachedOfficial = await fetchOfficialModels(providerName);
	let fetchStatus = `fetched ${cachedOfficial.length} model(s)`;
	let view: "enabled" | "all" = "enabled";
	let filter = "";

	while (true) {
		const universe = sortModelsForAllTab(buildModelUniverse(working, cachedOfficial));
		const visible = view === "enabled"
			? universe.filter((m) => m.source === "user" && m.enabled !== false)
			: universe;
		const filtered = filter
			? visible.filter((m) => `${m.id} ${m.name ?? ""}`.toLowerCase().includes(filter.toLowerCase()))
			: visible;

		const modelOptionMap = new Map<string, UnifyModelConfig>();
		const options: SearchSelectorItem[] = [
			{ value: "__switch_view__", label: `Switch view (current: ${view})` },
			{ value: "__search_filter__", label: `Search filter: ${filter || "(none)"}` },
			{ value: "__fetch_official__", label: `Fetch official models list (${fetchStatus})` },
			{ value: "__add_new__", label: "Add new model" },
			{ value: "__save__", label: "Save model changes (Ctrl+S)" },
			{ value: "__back__", label: "Back without saving" },
		];
		for (const model of filtered) {
			const key = model.uid ? `model:${model.uid}` : `model-id:${model.id}`;
			modelOptionMap.set(key, model);
			const selectedMark = model.enabled !== false ? "[x]" : "[ ]";
			const secondary = formatModelProperties(model);
			options.push({
				value: key,
				label: `${selectedMark} ${model.id}`,
				secondary: secondary || undefined,
				searchText: `${model.id} ${model.name ?? ""} ${secondary ?? ""}`,
			});
		}

		const choice = await selectWithSearch(
			ctx,
			`Models: ${providerName}`,
			options,
			"Enter:select/toggle  Tab:view switch via menu  Esc:cancel",
		);
		if (!choice || choice === "__back__") return false;

		if (choice === "__switch_view__") {
			view = view === "enabled" ? "all" : "enabled";
			continue;
		}
		if (choice === "__search_filter__") {
			const value = await ctx.ui.input("Model search filter", filter);
			filter = value?.trim() ?? "";
			continue;
		}
		if (choice === "__fetch_official__") {
			fetchStatus = "fetching...";
			cachedOfficial = await fetchOfficialModels(providerName);
			fetchStatus = `fetched ${cachedOfficial.length} model(s)`;
			ctx.ui.notify(fetchStatus, "info");
			continue;
		}
		if (choice === "__add_new__") {
			const id = await ctx.ui.input("New model ID", "");
			if (!id) continue;
			const name = await ctx.ui.input("Model name (optional)", "");
			working = dedupeModels([
				...working,
				ensureModelIdentity({
					id: id.trim(),
					name: name?.trim() || undefined,
					source: "user",
					enabled: true,
				}, "user"),
			]);
			continue;
		}
		if (choice === "__save__") {
			provider.models = dedupeModels(working.map((m) => ensureModelIdentity({ ...m, source: "user" }, "user")));
			provider.updatedAt = Date.now();
			store.upsertProvider(provider);
			verboseLog("commands", "models saved", { provider: provider.name, modelCount: provider.models.length });
			return true;
		}

		const selectedModel = modelOptionMap.get(choice);
		if (!selectedModel) continue;

		const existing = working.find((m) => m.uid === selectedModel.uid || m.id === selectedModel.id);
		const materialized = existing
			? ensureModelIdentity(existing, "user")
			: ensureModelIdentity({ ...selectedModel, source: "user", enabled: false }, "user");

		const edited = await editModelFields(materialized);
		if (!edited) continue;
		if (edited === "delete") {
			working = working.filter((m) => m.uid !== materialized.uid);
			continue;
		}
		working = dedupeModels([
			...working.filter((m) => m.uid !== materialized.uid),
			ensureModelIdentity({ ...edited, source: "user" }, "user"),
		]);
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
	verboseLog("commands", "official models listed", {
		provider: providerName,
		officialCount: officialModels.length,
	});
	if (officialModels.length === 0) {
		ctx.ui.notify(`No official models found for ${providerName}.`, "warning");
		return false;
	}

	const addAllLabel = "[Add all official models]";
	const selected = await selectWithSearch(
		ctx,
		`Official models: ${providerName}`,
		[
			addAllLabel,
			...officialModels.map((model) => {
				const exists = provider.models.some((m) => m.id === model.id);
				const label = exists ? `${model.id} (already added)` : model.id;
				return {
					value: label,
					label,
					secondary: formatModelProperties(model) || undefined,
					searchText: `${model.id} ${model.name ?? ""} ${formatModelProperties(model)}`,
				};
			}),
		],
	);
	if (!selected) return false;

	if (selected === addAllLabel) {
		let nextModels = dedupeModels(provider.models.map((model) => ensureModelIdentity(model, "user")));
		for (const model of officialModels) {
			nextModels = addOrEnableModelById(nextModels, model);
		}
		provider.models = nextModels;
	} else {
		const modelId = selected.replace(" (already added)", "");
		const model = officialModels.find((m) => m.id === modelId) ?? { id: modelId };
		provider.models = addOrEnableModelById(
			dedupeModels(provider.models.map((item) => ensureModelIdentity(item, "user"))),
			model,
		);
	}

	provider.updatedAt = Date.now();
	store.upsertProvider(provider);
	verboseLog("commands", "official models merged", {
		provider: provider.name,
		modelCount: provider.models.length,
	});
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
	return selectWithSearch(
		ctx,
		"Select provider",
		providers.map((provider) => ({
			value: provider.name,
			label: provider.name,
			secondary: `${provider.type} · auth:${provider.auth.method}`,
			searchText: `${provider.name} ${provider.type} ${provider.auth.method}`,
		})),
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

	const providerMenu = async (providerName: string): Promise<void> => {
		let fetchLabel = "not fetched";
		while (true) {
			const provider = store.getProvider(providerName);
			if (!provider) return;
			const enabledCount = provider.models.filter((m) => m.enabled !== false).length;

			const choice = await selectWithSearch(ctx, `Provider: ${provider.name}`, [
				{ value: "provider_settings", label: "Provider settings" },
				{ value: "auth", label: "Authentication" },
				{ value: "add_new_model", label: "Add new model" },
				{ value: "add_official", label: "Add from official models" },
				{ value: "fetch_official", label: `Fetch official models list (${fetchLabel})` },
				{ value: "enabled_models", label: `Enabled models (${enabledCount})` },
				{ value: "back", label: "Back" },
			]);

			if (!choice || choice === "back") return;

			if (choice === "provider_settings") {
				const changed = await runEditProviderFlow(ctx, store, provider.name);
				if (changed) await refreshProviders();
				continue;
			}
			if (choice === "auth") {
				const changed = await runAuthEditFlow(ctx, store, secrets, provider.name);
				if (changed) await refreshProviders();
				continue;
			}
			if (choice === "add_new_model") {
				const id = await ctx.ui.input("New model ID", "");
				if (!id) continue;
				const name = await ctx.ui.input("Model name (optional)", "");
				provider.models = dedupeModels([
					...provider.models,
					ensureModelIdentity({ id: id.trim(), name: name?.trim() || undefined, source: "user", enabled: true }, "user"),
				]);
				provider.updatedAt = Date.now();
				store.upsertProvider(provider);
				await refreshProviders();
				continue;
			}
			if (choice === "add_official") {
				const changed = await runOfficialModelsFlow(ctx, store, provider.name, fetchOfficialModels);
				if (changed) await refreshProviders();
				continue;
			}
			if (choice === "fetch_official") {
				fetchLabel = "fetching...";
				const models = await fetchOfficialModels(provider.name);
				fetchLabel = `fetched ${models.length} model(s)`;
				ctx.ui.notify(fetchLabel, "info");
				continue;
			}
			if (choice === "enabled_models") {
				const changed = await runModelsEditFlow(ctx, store, provider.name, fetchOfficialModels);
				if (changed) await refreshProviders();
			}
		}
	};

	while (true) {
		const providers = [...store.getProviders()].sort((a, b) => a.name.localeCompare(b.name));
		const providerItems = toDashboardSelectorItems(toDashboardItems(providers));
		const providerOptionMap = new Map(providerItems.map((item) => [item.value, item.value]));
		const choice = await selectWithSearch(
			ctx,
			"Unify Provider Manager",
			[
			{ value: "add_provider", label: "Add provider" },
			{ value: "refresh", label: "Refresh provider registrations" },
			{ value: "import", label: "Import providers" },
			{ value: "export", label: "Export providers" },
			...providerItems,
			{ value: "close", label: "Close" },
			],
			"Enter:select  Type to filter providers/options  Esc:close",
		);

		if (!choice || choice === "close") return;
		if (choice === "add_provider") {
			const added = await runAddProviderFlow(ctx, store, secrets);
			if (added) {
				await refreshProviders();
				ctx.ui.notify(`Added provider: ${added.name}`, "info");
			}
			continue;
		}
		if (choice === "refresh") {
			await refreshProviders();
			ctx.ui.notify("Providers refreshed.", "info");
			continue;
		}
		if (choice === "import") {
			await runImport(ctx, store, refreshProviders, "");
			continue;
		}
		if (choice === "export") {
			await runExport(ctx, store);
			continue;
		}

		const providerName = providerOptionMap.get(choice);
		if (providerName) {
			await providerMenu(providerName);
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
			models: Array.isArray(provider.models)
				? provider.models.map((model) => ensureModelIdentity(model as UnifyModelConfig, "user"))
				: [],
			extraHeaders: provider.extraHeaders,
			extraQuery: provider.extraQuery,
			extraBody: provider.extraBody,
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
	verboseLog("commands", "providers imported", { count: providers.length });
	ctx.ui.notify(`Imported ${providers.length} provider(s).`, "info");
}

async function runExport(
	ctx: ExtensionCommandContext,
	store: ConfigStore,
): Promise<void> {
	if (!ctx.hasUI) return;
	const payload = JSON.stringify({ providers: store.getProviders() }, null, "\t");
	ctx.ui.setEditorText(payload);
	verboseLog("commands", "providers exported", { count: store.getProviders().length });
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
