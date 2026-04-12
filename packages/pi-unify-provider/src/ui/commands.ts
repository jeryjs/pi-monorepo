/**
 * TUI Commands for Unify Provider
 * Interactive commands: /unify, /unify-add, /unify-models, /unify-refresh
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ConfigStore, UnifyProviderConfig, AuthConfig } from "../config.js";
import type { OfficialModelsFetcher } from "../providers/fetcher.js";
import { WELL_KNOWN_PROVIDERS, getAllWellKnownProviders } from "../providers/well-known.js";
import { AuthManager } from "../utils/auth.js";

// ============================================================================
// Main Dashboard
// ============================================================================

export async function showProviderDashboard(
  configStore: ConfigStore,
  ctx: ExtensionContext
): Promise<void> {
  const providers = configStore.getAllProviders();

  if (providers.length === 0) {
    const choice = await ctx.ui.quickPick({
      title: "Unify Provider - No Providers Configured",
      items: [
        { label: "📥 Add your first provider", value: "add", detail: "Set up a new LLM provider" },
        { label: "❓ Learn more", value: "help", detail: "Open documentation" },
      ],
    });

    if (choice === "add") {
      // This would redirect to showAddProviderFlow, but we need ExtensionAPI
      ctx.ui.notify("Run /unify-add to add a provider", "info");
    }
    return;
  }

  // Build provider list
  const items = providers.map((p) => {
    const wellKnown = WELL_KNOWN_PROVIDERS[p.type];
    const status = p.lastFetchError
      ? "⚠️ Error"
      : p.autoFetchOfficialModels
      ? "🔄 Auto"
      : "📌 Manual";
    const modelCount = p.models.length;

    return {
      label: `${wellKnown?.displayName || p.name} ${status}`,
      value: p.name,
      detail: `${modelCount} models • ${new URL(p.baseUrl).hostname}`,
    };
  });

  items.push({
    label: "➕ Add new provider",
    value: "__add__",
    detail: "Configure another provider",
  });

  const choice = await ctx.ui.quickPick({
    title: `Unify Provider Dashboard (${providers.length} configured)`,
    items,
  });

  if (choice === "__add__") {
    ctx.ui.notify("Run /unify-add to add a provider", "info");
  } else if (choice) {
    await showProviderDetails(configStore, choice, ctx);
  }
}

// ============================================================================
// Add Provider Flow
// ============================================================================

export async function showAddProviderFlow(
  pi: ExtensionAPI,
  configStore: ConfigStore,
  ctx: ExtensionContext
): Promise<void> {
  // Step 1: Choose provider type
  const wellKnown = getAllWellKnownProviders();
  const providerChoice = await ctx.ui.quickPick({
    title: "Unify Provider - Add Provider",
    items: wellKnown.map((p) => ({
      label: `${p.displayName}`,
      value: p.type,
      detail: `${p.description} (${p.authType === "oauth" ? "OAuth" : "API Key"})`,
    })),
    placeholder: "Select a provider type...",
  });

  if (!providerChoice) return;

  const providerDef = WELL_KNOWN_PROVIDERS[providerChoice];

  // Step 2: Configure provider
  const config: Partial<UnifyProviderConfig> = {
    type: providerChoice,
    baseUrl: providerDef.defaultBaseUrl,
    autoFetchOfficialModels: true,
    models: [],
  };

  // Step 3: Authentication setup
  ctx.ui.notify(`Configuring ${providerDef.displayName}...", "info");

  if (providerDef.authType === "api_key" || providerDef.authType === "both") {
    const useApiKey = await ctx.ui.confirm({
      message: "Use API Key authentication?",
      details: "Recommended for server-to-server use",
    });

    if (useApiKey) {
      const envVar = await ctx.ui.input({
        title: "API Key Environment Variable",
        placeholder: `${providerChoice.toUpperCase()}_API_KEY`,
      });

      config.auth = {
        type: "api_key",
        envVar: envVar || `${providerChoice.toUpperCase()}_API_KEY`,
        allowStoredKey: true,
        useSecretStorage: true,
      } as AuthConfig;

      // For testing: allow direct input (for development only)
      const testKey = await ctx.ui.input({
        title: "Test API Key (optional, for verification)",
        placeholder: "sk-... (or leave empty to configure manually)",
      });

      if (testKey) {
        const authManager = new AuthManager();
        authManager.setApiKey(providerDef.name, testKey);
        ctx.ui.notify("API key stored for testing", "info");
      }
    }
  }

  if (providerDef.authType === "oauth") {
    ctx.ui.notify(
      "OAuth authentication will be configured automatically when you first use this provider",
      "info"
    );
    config.auth = {
      type: "oauth2",
      displayName: providerDef.oauth!.name,
      authUrl: providerDef.oauth!.authUrl,
      tokenUrl: providerDef.oauth!.tokenUrl,
      scopes: providerDef.oauth!.scopes,
    } as AuthConfig;
  }

  // Step 4: Auto-fetch settings
  const enableAutoFetch = await ctx.ui.confirm({
    message: "Enable automatic model fetching?",
    details: "Periodically fetch official model list from provider",
    default: true,
  });
  config.autoFetchOfficialModels = enableAutoFetch;

  // Step 5: Provider name
  const customName = await ctx.ui.input({
    title: "Provider Name (optional)",
    placeholder: providerDef.displayName,
  });
  config.name = customName || providerDef.displayName;

  // Save provider
  const fullConfig: UnifyProviderConfig = {
    ...config,
    name: config.name!,
    type: providerChoice,
    baseUrl: providerDef.defaultBaseUrl,
    autoFetchOfficialModels: config.autoFetchOfficialModels ?? true,
    models: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  configStore.setProvider(fullConfig);

  // Step 6: Register with Pi immediately
  try {
    // Convert to Pi format and register
    const piModels: any[] = []; // Will be populated by fetch
    pi.registerProvider(fullConfig.name, {
      baseUrl: fullConfig.baseUrl,
      apiKey: fullConfig.auth?.type === "api_key"
        ? (fullConfig.auth as any).envVar
        : `${fullConfig.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`,
      api: providerDef.apiType,
      models: piModels,
    });

    ctx.ui.notify(
      `✅ Provider "${fullConfig.name}" added and registered. Models will appear in /model once fetched.`,
      "success"
    );
  } catch (error) {
    ctx.ui.notify(`Provider saved but registration failed: ${error}`, "warning");
  }
}

// ============================================================================
// Provider Details
// ============================================================================

async function showProviderDetails(
  configStore: ConfigStore,
  providerName: string,
  ctx: ExtensionContext
): Promise<void> {
  const provider = configStore.getProvider(providerName);
  if (!provider) return;

  const items = [
    { label: "🔄 Refresh official models", value: "refresh" },
    { label: `📋 Models (${provider.models.length})`, value: "models" },
    { label: provider.autoFetchOfficialModels ? "⚙️ Disable auto-fetch" : "⚙️ Enable auto-fetch", value: "toggle_fetch" },
    { label: "🗑️ Delete provider", value: "delete", detail: "Remove this provider configuration" },
    { label: "⬅️ Back", value: "back" },
  ];

  const choice = await ctx.ui.quickPick({
    title: `${providerName} - Options`,
    items,
  });

  switch (choice) {
    case "refresh":
      ctx.ui.notify(`Refreshing models for ${providerName}...`, "info");
      // Trigger fetch (would need fetcher instance)
      break;
    case "models":
