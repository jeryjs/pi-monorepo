/**
 * Pi Unify Provider - Multi-provider LLM management extension
 * Provides automatic model discovery and unified configuration for 5+ providers
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { ConfigStore, type UnifyProviderConfig } from "./config.js";
import { OfficialModelsFetcher } from "./providers/fetcher.js";
import { WELL_KNOWN_PROVIDERS } from "./providers/well-known.js";
import { showProviderDashboard, showAddProviderFlow, showModelsList, refreshAllProviders } from "./ui/commands.js";

let configStore: ConfigStore;
let fetcher: OfficialModelsFetcher;

export default function (pi: ExtensionAPI) {
  // Initialize configuration
  configStore = new ConfigStore();
  fetcher = new OfficialModelsFetcher(configStore);

  // Event: session_start - Register all saved providers
  pi.on("session_start", async (_event, ctx) => {
    await registerAllProviders(pi, ctx);
  });

  // Event: provider request - Inject any custom headers if needed
  pi.on("before_provider_request", async (event, _ctx) => {
    // Future: dynamic header injection per provider
    return { payload: event.payload };
  });

  // Command: /unify - Main dashboard
  pi.registerCommand("unify", {
    description: "Open the unified provider management dashboard",
    handler: async (_args, ctx) => {
      await showProviderDashboard(configStore, ctx);
    },
  });

  // Command: /unify-add - Add new provider
  pi.registerCommand("unify-add", {
    description: "Add a new LLM provider (interactive)",
    handler: async (_args, ctx) => {
      await showAddProviderFlow(pi, configStore, ctx);
    },
  });

  // Command: /unify-providers - List providers
  pi.registerCommand("unify-providers", {
    description: "List and manage configured providers",
    handler: async (_args, ctx) => {
      await showProviderDashboard(configStore, ctx);
    },
  });

  // Command: /unify-models - View models
  pi.registerCommand("unify-models", {
    description: "View models for a provider",
    handler: async (args, ctx) => {
      const providerName = args.trim() || undefined;
      await showModelsList(configStore, providerName, ctx);
    },
  });

  // Command: /unify-refresh - Refresh official models
  pi.registerCommand("unify-refresh", {
    description: "Refresh official model lists from all providers",
    handler: async (_args, ctx) => {
      await refreshAllProviders(fetcher, configStore, ctx);
    },
  });

  // Keyboard shortcut: Ctrl+Shift+U for dashboard
  pi.registerShortcut("ctrl+shift+u", {
    description: "Open Unify Provider dashboard",
    handler: async (ctx) => {
      await showProviderDashboard(configStore, ctx);
    },
  });

  console.log("[UnifyProvider] Extension loaded. Commands: /unify, /unify-add, /unify-providers, /unify-models, /unify-refresh");
}

/**
 * Register all saved providers with Pi's model registry
 */
async function registerAllProviders(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const providers = configStore.getAllProviders();

  if (providers.length === 0) {
    ctx.ui.notify("No providers configured. Run /unify-add to add one.", "info");
    return;
  }

  let registered = 0;
  for (const provider of providers) {
    try {
      await registerProviderWithPi(pi, provider, ctx);
      registered++;
    } catch (error) {
      ctx.ui.notify(`Failed to register provider "${provider.name}": ${error}`, "error");
    }
  }

  if (registered > 0) {
    ctx.ui.notify(`${registered} provider(s) registered from Unify.`, "info");
  }
}

/**
 * Convert a Unify provider config to Pi's registerProvider format
 */
async function registerProviderWithPi(
  pi: ExtensionAPI,
  provider: UnifyProviderConfig,
  _ctx: ExtensionContext
): Promise<void> {
  const wellKnown = WELL_KNOWN_PROVIDERS[provider.type];
  if (!wellKnown) {
    throw new Error(`Unknown provider type: ${provider.type}`);
  }

  // Merge auto-fetched models with manual ones
  const allModels = provider.autoFetchOfficialModels
    ? await fetcher.getMergedModels(provider)
    : provider.models;

  // Convert to Pi's format
  const piModels = allModels.map((model) => ({
    id: model.id,
    name: model.name || model.id,
    reasoning: model.capabilities?.reasoning ?? false,
    input: [
      ...(model.capabilities?.textInput !== false ? ["text" as const] : []),
      ...(model.capabilities?.imageInput ? ["image" as const] : []),
    ],
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cacheRead: model.cost?.cacheRead ?? 0,
      cacheWrite: model.cost?.cacheWrite ?? 0,
    },
    contextWindow: model.contextWindow ?? wellKnown.defaultContextWindow ?? 128000,
    maxTokens: model.maxOutputTokens ?? wellKnown.defaultMaxTokens ?? 4096,
    compat: model.compat,
  }));

  // Register with Pi
  const apiKeyEnvVar = provider.auth?.type === "api_key"
    ? provider.auth.envVar
    : `${provider.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;

  pi.registerProvider(provider.name, {
    baseUrl: provider.baseUrl,
    apiKey: apiKeyEnvVar,
    api: wellKnown.apiType,
    models: piModels,
    headers: provider.extraHeaders,
  });

  console.log(`[UnifyProvider] Registered "${provider.name}" with ${piModels.length} models`);
}
