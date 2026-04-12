/**
 * TUI Commands for Unify Provider
 * Interactive commands: /unify, /unify-add, /unify-models, /unify-refresh
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ConfigStore, UnifyProviderConfig, AuthConfig } from "../config.js";
import type { OfficialModelsFetcher } from "../providers/fetcher.js";
import { WELL_KNOWN_PROVIDERS, getAllWellKnownProviders } from "../providers/well-known.js";
import { AuthManager } from "../utils/auth.js";

interface SelectItem<T extends string> {
  label: string;
  value: T;
  detail?: string;
}

async function selectValue<T extends string>(
  ctx: ExtensionContext,
  title: string,
  items: Array<SelectItem<T>>
): Promise<T | undefined> {
  const options = items.map((item) =>
    item.detail ? `${item.label} — ${item.detail}` : item.label
  );
  const selected = await ctx.ui.select(title, options);
  if (!selected) return undefined;

  const index = options.indexOf(selected);
  return index >= 0 ? items[index].value : undefined;
}

// ============================================================================
// Main Dashboard
// ============================================================================

export async function showProviderDashboard(
  configStore: ConfigStore,
  ctx: ExtensionContext
): Promise<void> {
  const providers = configStore.getAllProviders();

  if (providers.length === 0) {
    const choice = await selectValue(ctx, "Unify Provider - No Providers Configured", [
      { label: "📥 Add your first provider", value: "add", detail: "Set up a new LLM provider" },
      { label: "❓ Learn more", value: "help", detail: "Open documentation" },
    ]);

    if (choice === "add") {
      ctx.ui.notify("Run /unify-add to add a provider", "info");
    } else if (choice === "help") {
      ctx.ui.notify("Use /unify-add to configure providers and /unify-refresh to fetch official models.", "info");
    }
    return;
  }

  const items: Array<SelectItem<string>> = providers.map((p) => {
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

  const choice = await selectValue(
    ctx,
    `Unify Provider Dashboard (${providers.length} configured)`,
    items
  );

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
  const providerChoice = await selectValue<keyof typeof WELL_KNOWN_PROVIDERS>(
    ctx,
    "Unify Provider - Add Provider",
    wellKnown.map((p) => ({
      label: `${p.displayName}`,
      value: p.type,
      detail: `${p.description} (${p.authType === "oauth" ? "OAuth" : "API Key"})`,
    })),
  );

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
  ctx.ui.notify(`Configuring ${providerDef.displayName}...`, "info");

  if (providerDef.authType === "api_key" || providerDef.authType === "both") {
    const useApiKey = await ctx.ui.confirm(
      "Authentication",
      "Use API Key authentication? Recommended for server-to-server use."
    );

    if (useApiKey) {
      const envVar = await ctx.ui.input(
        "API Key Environment Variable",
        `${providerChoice.toUpperCase()}_API_KEY`
      );

      config.auth = {
        type: "api_key",
        envVar: envVar || `${providerChoice.toUpperCase()}_API_KEY`,
        allowStoredKey: true,
        useSecretStorage: true,
      } as AuthConfig;

      // For testing: allow direct input (for development only)
      const testKey = await ctx.ui.input(
        "Test API Key (optional, for verification)",
        "sk-... (or leave empty to configure manually)"
      );

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
  const enableAutoFetch = await ctx.ui.confirm(
    "Auto-Fetch Official Models",
    "Enable automatic official model fetching for this provider?"
  );
  config.autoFetchOfficialModels = enableAutoFetch;

  // Step 5: Provider name
  const customName = await ctx.ui.input(
    "Provider Name (optional)",
    providerDef.displayName
  );
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
      "info"
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

  const choice = await selectValue(ctx, `${providerName} - Options`, items);

  switch (choice) {
    case "refresh":
      ctx.ui.notify(`Refreshing models for ${providerName}...`, "info");
      // Trigger fetch (would need fetcher instance)
      break;
    case "models":
      await showModelsList(configStore, providerName, ctx);
      break;
    case "toggle_fetch":
      provider.autoFetchOfficialModels = !provider.autoFetchOfficialModels;
      configStore.setProvider(provider);
      ctx.ui.notify(`Auto-fetch ${provider.autoFetchOfficialModels ? "enabled" : "disabled"}`, "info");
      break;
    case "delete":
      const confirm = await ctx.ui.confirm(
        "Delete Provider",
        `Delete provider "${providerName}"? This cannot be undone.`
      );
      if (confirm) {
        configStore.deleteProvider(providerName);
        ctx.ui.notify(`Provider "${providerName}" deleted`, "info");
      }
      break;
  }
}

// ============================================================================
// Show Models List
// ============================================================================

export async function showModelsList(
  configStore: ConfigStore,
  providerName: string | undefined,
  ctx: ExtensionContext
): Promise<void> {
  const providers = providerName
    ? [configStore.getProvider(providerName)].filter(Boolean)
    : configStore.getAllProviders();

  if (providers.length === 0) {
    ctx.ui.notify("No providers configured.", "warning");
    return;
  }

  // Build model list from all providers
  const items: { label: string; value: string; detail: string }[] = [];

  for (const provider of providers as UnifyProviderConfig[]) {
    const wellKnown = WELL_KNOWN_PROVIDERS[provider.type];

    for (const model of provider.models) {
      const capabilities = [];
      if (model.capabilities?.toolCalling) capabilities.push("🔧");
      if (model.capabilities?.imageInput) capabilities.push("👁️");
      if (model.capabilities?.reasoning) capabilities.push("🧠");

      const costStr = model.cost
        ? `$${model.cost.input}/${model.cost.output}`
        : "N/A";

      items.push({
        label: model.name || model.id,
        value: `${provider.name}/${model.id}`,
        detail: `${wellKnown?.displayName || provider.type} • ${model.contextWindow?.toLocaleString() || "?"} ctx • ${costStr} ${capabilities.join(" ")}`,
      });
    }
  }

  if (items.length === 0) {
    ctx.ui.notify("No models found. Run /unify-refresh to fetch models.", "warning");
    return;
  }

  const choice = await selectValue(
    ctx,
    providerName
      ? `Models for ${providerName} (${items.length})`
      : `All Provider Models (${items.length})`,
    items
  );

  if (choice) {
    ctx.ui.notify(`Model selected: ${choice}. Use /model to view all available models.`, "info");
  }
}

// ============================================================================
// Refresh All Providers
// ============================================================================

export async function refreshAllProviders(
  fetcher: OfficialModelsFetcher,
  _configStore: ConfigStore,
  ctx: ExtensionContext
): Promise<void> {
  ctx.ui.notify("🔄 Fetching official model lists from all providers...", "info");

  const results = await fetcher.refreshAll();

  if (results.refreshed > 0) {
    ctx.ui.notify(`✅ Refreshed ${results.refreshed} provider(s). ${results.failed > 0 ? `${results.failed} failed.` : ""}`,
      results.failed > 0 ? "warning" : "info"
    );
  } else if (results.failed > 0) {
    ctx.ui.notify(`⚠️ All ${results.failed} refresh(es) failed. Check /unify-providers for errors.`, "error");
  } else {
    ctx.ui.notify("No providers need refreshing (auto-fetch disabled or already up to date).", "info");
  }

  if (results.errors.length > 0) {
    console.error("[UnifyProvider] Refresh errors:", results.errors);
  }
}

// ============================================================================
// Utility: Get Provider Status Summary
// ============================================================================

export function getProviderStatusSummary(configStore: ConfigStore): string {
  const providers = configStore.getAllProviders();
  if (providers.length === 0) return "No providers";

  const autoCount = providers.filter((p) => p.autoFetchOfficialModels).length;
  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0);

  return `${providers.length} providers, ${autoCount} auto, ${totalModels} models`;
}
