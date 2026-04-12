import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { ConfigStore } from "./config-store.js";
import { SecretStore } from "./secret-store.js";
import { AuthManager } from "./auth/auth-manager.js";
import { OfficialModelsFetcher } from "./providers/fetcher.js";
import { registerUiCommands } from "./ui/commands.js";
import type { ModelConfig, ProviderConfig } from "./types.js";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 8192;

function toProviderModelConfig(provider: ProviderConfig, model: ModelConfig) {
  const input: Array<"text" | "image"> = model.capabilities?.imageInput
    ? ["text", "image"]
    : ["text"];

  return {
    id: model.id,
    name: model.name || model.id,
    api: provider.api,
    reasoning: !!model.capabilities?.reasoning,
    input,
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cacheRead: model.cost?.cacheRead ?? 0,
      cacheWrite: model.cost?.cacheWrite ?? 0,
    },
    contextWindow: model.contextWindow ?? model.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    compat: model.compat,
  };
}

function withQuery(baseUrl: string, query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return baseUrl;
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export default function unifyProviderExtension(pi: ExtensionAPI): void {
  const store = new ConfigStore();
  const secretStore = new SecretStore();
  const authManager = new AuthManager(secretStore);
  const fetcher = new OfficialModelsFetcher(store, authManager);

  let registeredProviderNames = new Set<string>();

  const registerAllProviders = async (): Promise<void> => {
    const providers = store.getAllProviders();
    const nextNames = new Set(providers.map((provider) => provider.name));

    for (const previous of registeredProviderNames) {
      if (!nextNames.has(previous)) {
        pi.unregisterProvider(previous);
      }
    }

    for (const provider of providers) {
      const auth = await authManager.resolveAuth(provider, provider.extraHeaders);
      const models = await fetcher.getMergedModels(provider);
      const registeredModels = models.map((model) => toProviderModelConfig(provider, model));

      pi.registerProvider(provider.name, {
        baseUrl: withQuery(provider.baseUrl, auth.query),
        api: provider.api,
        apiKey: "UP_INTERNAL",
        authHeader: false,
        headers: auth.headers,
        models: registeredModels,
      });
    }

    registeredProviderNames = nextNames;
  };

  registerUiCommands({
    pi,
    store,
    authManager,
    fetcher,
    registerAllProviders,
  });

  pi.registerCommand("unify-models", {
    description: "Open provider dashboard (models section)",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Open /unify and pick a provider to manage models", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await fetcher.fetchAllProviders(false).catch((error) => {
      ctx.ui.notify(`Model auto-refresh failed: ${error}`, "warning");
    });

    await registerAllProviders();
    ctx.ui.setStatus("unify-provider", `${store.getAllProviders().length} provider(s)`);
  });

  pi.on("session_shutdown", async () => {
    authManager.clear();
  });
}
