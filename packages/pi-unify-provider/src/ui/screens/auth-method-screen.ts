import { listAuthMethodDefinitions } from "../../auth/definitions.js";
import { getWellKnownProvider } from "../../providers/well-known.js";
import { createDefaultAuthConfig } from "../../utils/auth.js";
import { pickItem } from "../component.js";
import type {
  AuthMethodRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from "../router/types.js";
import type { AuthMethod } from "../../types.js";

export async function runAuthMethodScreen(
  ctx: UiContext,
  route: AuthMethodRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const allowedMethods = getAllowedMethods(route.draft.type);

  const selection = await pickItem(ctx.cmd, `Authentication (${route.draft.name || "provider"})`, [
    { label: "Back", value: "back" as const },
    ...listAuthMethodDefinitions()
      .filter((definition) => allowedMethods.includes(definition.id))
      .map((definition) => ({
        label: definition.label,
        detail: definition.description,
        value: definition.id,
      })),
  ]);

  if (!selection || selection === "back") {
    return { kind: "pop" };
  }

  if (selection === "none") {
    route.draft.auth = { method: "none" };
    ctx.cmd.ui.notify("Authentication disabled", "info");
    return { kind: "pop" };
  }

  const baseConfig = route.draft.auth?.method === selection
    ? route.draft.auth
    : createDefaultAuthConfig(selection);
  const result = await ctx.authManager.configureAuth(
    route.draft.name || "provider",
    baseConfig,
    {
      select: (title, options) => ctx.cmd.ui.select(title, options),
      confirm: (title, message) => ctx.cmd.ui.confirm(title, message),
      input: (title, placeholder) => ctx.cmd.ui.input(title, placeholder),
      editor: (title, prefill) => ctx.cmd.ui.editor(title, prefill),
      notify: (message, type) => ctx.cmd.ui.notify(message, type),
    },
    async (auth) => {
      route.draft.auth = auth;
    },
  );

  if (result.success && result.config) {
    route.draft.auth = result.config;
    ctx.cmd.ui.notify(`Configured auth: ${selection}`, "info");
  } else if (result.error) {
    ctx.cmd.ui.notify(result.error, "error");
  }

  return { kind: "pop" };
}

function getAllowedMethods(providerType: AuthMethodRoute["draft"]["type"]): AuthMethod[] {
  if (!providerType) {
    return ["api-key", "bearer-token", "oauth2", "oauth2-pkce", "oauth-device-code", "browser-session", "custom-header", "query-param", "none"];
  }
  return getWellKnownProvider(providerType)?.authMethods ?? ["api-key", "bearer-token", "none"];
}

