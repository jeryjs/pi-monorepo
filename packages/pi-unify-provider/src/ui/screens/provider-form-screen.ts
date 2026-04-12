import { getWellKnownProvider, getWellKnownProviders } from "../../providers/well-known.js";
import { createDefaultAuthConfig } from "../../utils/auth.js";
import { pickItem } from "../component.js";
import type { ProviderConfig } from "../../types.js";
import type {
  ProviderFormRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from "../router/types.js";

function validateDraftName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed) return "Provider name is required";
  return undefined;
}

function validateDraftBaseUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return "Base URL is required";

  try {
    new URL(trimmed);
    return undefined;
  } catch {
    return "Base URL must be valid";
  }
}

function toProviderConfig(route: ProviderFormRoute): ProviderConfig {
  const now = Date.now();
  return {
    type: route.draft.type!,
    name: route.draft.name!.trim(),
    baseUrl: route.draft.baseUrl!.trim().replace(/\/+$/, ""),
    api: route.draft.api!,
    auth: route.draft.auth,
    models: route.draft.models,
    extraHeaders: route.draft.extraHeaders,
    extraBody: route.draft.extraBody,
    timeout: route.draft.timeout,
    retry: route.draft.retry,
    autoFetchOfficialModels: route.draft.autoFetchOfficialModels ?? true,
    lastFetchTime: route.draft.lastFetchTime,
    lastFetchError: route.draft.lastFetchError,
    createdAt: route.mode === "edit" && route.providerName
      ? (route.draft.createdAt ?? now)
      : now,
    updatedAt: now,
  };
}

export async function runProviderFormScreen(
  ctx: UiContext,
  route: ProviderFormRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const action = await pickItem(ctx.cmd, route.mode === "edit" ? `Edit provider: ${route.providerName}` : "Add provider", [
    { label: "Back", value: "back" as const },
    { label: "Name", detail: route.draft.name || "(required)", value: "name" as const },
    {
      label: "Type",
      detail: route.draft.type || "(required)",
      value: "type" as const,
    },
    {
      label: "Base URL",
      detail: route.draft.baseUrl || "(required)",
      value: "base-url" as const,
    },
    {
      label: "API Format",
      detail: route.draft.api || "(required)",
      value: "api" as const,
    },
    {
      label: "Authentication",
      detail: route.draft.auth?.method || "none",
      value: "auth" as const,
    },
    {
      label: "Models",
      detail: `${route.draft.models.length} configured`,
      value: "models" as const,
    },
    {
      label: "Auto Fetch Official Models",
      detail: route.draft.autoFetchOfficialModels === false ? "disabled" : "enabled",
      value: "auto-fetch" as const,
    },
    { label: "Save", value: "save" as const },
  ]);

  if (!action || action === "back") {
    return { kind: "pop" };
  }

  if (action === "name") {
    const value = await ctx.cmd.ui.input("Provider Name", route.draft.name || "My Provider");
    if (value !== undefined) route.draft.name = value.trim();
    return { kind: "stay" };
  }

  if (action === "type") {
    const selected = await pickItem(ctx.cmd, "Provider Type", getWellKnownProviders().map((provider) => ({
      label: provider.name,
      detail: provider.description,
      value: provider,
    })));

    if (selected) {
      route.draft.type = selected.id;
      route.draft.baseUrl = selected.baseUrl;
      route.draft.api = selected.api;
      route.draft.auth = createDefaultAuthConfig(selected.defaultAuthMethod);
      route.draft.autoFetchOfficialModels = true;
      if (!route.draft.name || route.mode === "create") {
        route.draft.name = selected.name;
      }
    }
    return { kind: "stay" };
  }

  if (action === "base-url") {
    const value = await ctx.cmd.ui.input("Base URL", route.draft.baseUrl || "https://api.example.com/v1");
    if (value !== undefined) route.draft.baseUrl = value.trim();
    return { kind: "stay" };
  }

  if (action === "api") {
    const selected = await pickItem(ctx.cmd, "API Format", [
      { label: "openai-completions", detail: "OpenAI Chat Completions", value: "openai-completions" as const },
      { label: "openai-responses", detail: "OpenAI Responses", value: "openai-responses" as const },
      { label: "anthropic-messages", detail: "Anthropic Messages", value: "anthropic-messages" as const },
    ]);
    if (selected) route.draft.api = selected;
    return { kind: "stay" };
  }

  if (action === "auth") {
    return {
      kind: "push",
      route: {
        kind: "auth-method",
        draft: route.draft,
      },
    };
  }

  if (action === "models") {
    return {
      kind: "push",
      route: {
        kind: "model-list",
        draft: route.draft,
      },
    };
  }

  if (action === "auto-fetch") {
    route.draft.autoFetchOfficialModels = !(route.draft.autoFetchOfficialModels === false);
    return { kind: "stay" };
  }

  const nameError = validateDraftName(route.draft.name);
  if (nameError) {
    ctx.cmd.ui.notify(nameError, "error");
    return { kind: "stay" };
  }

  const baseUrlError = validateDraftBaseUrl(route.draft.baseUrl);
  if (baseUrlError) {
    ctx.cmd.ui.notify(baseUrlError, "error");
    return { kind: "stay" };
  }

  if (!route.draft.type) {
    ctx.cmd.ui.notify("Provider type is required", "error");
    return { kind: "stay" };
  }

  if (!route.draft.api) {
    const wellKnown = getWellKnownProvider(route.draft.type);
    route.draft.api = wellKnown?.api;
  }

  if (!route.draft.api) {
    ctx.cmd.ui.notify("API format is required", "error");
    return { kind: "stay" };
  }

  const next = toProviderConfig(route);

  if (route.mode === "create") {
    if (ctx.store.hasProvider(next.name)) {
      ctx.cmd.ui.notify(`Provider already exists: ${next.name}`, "error");
      return { kind: "stay" };
    }
  }

  if (route.mode === "edit" && route.providerName && route.providerName !== next.name) {
    if (ctx.store.hasProvider(next.name)) {
      ctx.cmd.ui.notify(`Provider already exists: ${next.name}`, "error");
      return { kind: "stay" };
    }
    ctx.store.removeProvider(route.providerName);
  }

  ctx.store.upsertProvider(next);

  if (next.autoFetchOfficialModels !== false) {
    await ctx.fetcher.fetchProvider(next.name, true).catch((error) => {
      ctx.cmd.ui.notify(`Model refresh failed: ${error}`, "warning");
    });
  }

  await ctx.registerAllProviders();
  ctx.cmd.ui.notify(`Saved provider: ${next.name}`, "info");

  return {
    kind: "pop",
    resume: {
      kind: "provider-saved",
      provider: next,
    },
  };
}
