import { getWellKnownProviders } from "../../providers/well-known.js";
import { createDefaultAuthConfig } from "../../utils/auth.js";
import { pickItem } from "../component.js";
import type {
  WellKnownProviderListRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from "../router/types.js";

export async function runWellKnownProviderListScreen(
  ctx: UiContext,
  _route: WellKnownProviderListRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const providers = getWellKnownProviders();

  const selected = await pickItem<"back" | (typeof providers)[number]>(ctx.cmd, "Add from well-known providers", [
    {
      label: "Back",
      value: "back" as const,
    },
    ...providers.map((provider) => ({
      label: provider.name,
      detail: provider.description,
      value: provider,
    })),
  ]);

  if (!selected || selected === "back") {
    return { kind: "pop" };
  }

  return {
    kind: "push",
    route: {
      kind: "provider-form",
      mode: "create",
      draft: {
        type: selected.id,
        name: selected.name,
        baseUrl: selected.baseUrl,
        api: selected.api,
        auth: createDefaultAuthConfig(selected.defaultAuthMethod),
        models: [],
        autoFetchOfficialModels: true,
      },
    },
  };
}
