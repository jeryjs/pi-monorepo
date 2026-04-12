import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { ConfigStore } from "./config-store.js";
import { SecretStore } from "./secret-store.js";
import {
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_MAX_TOKENS,
	type ProviderConfigRecord,
	type UnifyModelConfig,
} from "./types.js";

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

function toRuntimeProviderConfig(provider: ProviderConfigRecord): ProviderConfig {
	return {
		baseUrl: provider.baseUrl,
		api: provider.api,
		authHeader: false,
		headers: provider.extraHeaders,
		models: provider.models.map((m) => toProviderModelConfig(provider, m)),
	};
}

async function registerConfiguredProviders(
	pi: ExtensionAPI,
	store: ConfigStore,
): Promise<void> {
	const providers = store.getProviders();
	for (const provider of providers) {
		pi.registerProvider(provider.name, toRuntimeProviderConfig(provider));
	}
}

export default function registerExtension(pi: ExtensionAPI): void {
	const store = new ConfigStore();
	const secrets = new SecretStore();
	void secrets;

	pi.registerCommand("unify", {
		description: "Open unify provider manager (rewrite in progress)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			ctx.ui.notify("Unify rewrite scaffold is active. Full TUI flow is being rebuilt.", "info");
		},
	});

	pi.on("session_start", async (_event, _ctx) => {
		await registerConfiguredProviders(pi, store);
	});
}
