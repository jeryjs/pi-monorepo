import { pickItem } from "../component.js";
import type {
  ProviderListRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from "../router/types.js";

type ProviderListAction =
  | "exit"
  | "add-well-known"
  | "add-custom"
  | "refresh-all"
  | { kind: "provider"; providerName: string };

export async function runProviderListScreen(
  ctx: UiContext,
  _route: ProviderListRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const providers = ctx.store.getAllProviders().sort((a, b) => a.name.localeCompare(b.name));

  const action = await pickItem<ProviderListAction>(ctx.cmd, "Unify Provider Dashboard", [
    { label: "Exit", value: "exit" as const },
    { label: "Add from well-known list", value: "add-well-known" as const },
    {
      label: "Add custom provider",
      detail: "Start with blank provider template",
      value: "add-custom" as const,
    },
    {
      label: "Refresh all official model lists",
      value: "refresh-all" as const,
    },
    ...providers.map((provider) => ({
      label: provider.name,
      detail: [
        provider.type,
        `${provider.models.length} models`,
        provider.lastFetchError ? "last refresh failed" : undefined,
      ]
        .filter(Boolean)
        .join(" • "),
      value: { kind: "provider", providerName: provider.name } as const,
    })),
  ]);

  if (!action || action === "exit") {
    return { kind: "exit" };
  }

  if (action === "add-well-known") {
    return { kind: "push", route: { kind: "well-known-provider-list" } };
  }

  if (action === "add-custom") {
    return {
      kind: "push",
      route: {
        kind: "provider-form",
        mode: "create",
        draft: {
          type: "custom",
          name: "",
          baseUrl: "https://api.example.com/v1",
          api: "openai-completions",
          auth: { method: "api-key", headerName: "Authorization", prefix: "Bearer " },
          models: [],
          autoFetchOfficialModels: true,
        },
      },
    };
  }

  if (action === "refresh-all") {
    const summary = await ctx.fetcher.fetchAllProviders(true);
    await ctx.registerAllProviders();

    if (summary.failed > 0) {
      ctx.cmd.ui.notify(
        `Refreshed ${summary.refreshed}, failed ${summary.failed}`,
        "warning",
      );
    } else {
      ctx.cmd.ui.notify(`Refreshed ${summary.refreshed} provider(s)`, "info");
    }

    return { kind: "stay" };
  }

  if (typeof action === "object" && action.kind === "provider") {
    const provider = ctx.store.getProvider(action.providerName);
    if (!provider) {
      ctx.cmd.ui.notify(`Provider not found: ${action.providerName}`, "error");
      return { kind: "stay" };
    }

    const providerAction = await pickItem(ctx.cmd, `Provider: ${provider.name}`, [
      { label: "Back", value: "back" as const },
      { label: "Edit provider", value: "edit" as const },
      { label: "Refresh official models", value: "refresh" as const },
      { label: "Delete provider", value: "delete" as const },
    ]);

    if (!providerAction || providerAction === "back") {
      return { kind: "stay" };
    }

    if (providerAction === "edit") {
      return {
        kind: "push",
        route: {
          kind: "provider-form",
          mode: "edit",
          providerName: provider.name,
          draft: { ...provider, models: [...provider.models] },
        },
      };
    }

    if (providerAction === "refresh") {
      await ctx.fetcher.fetchProvider(provider.name, true).catch((error) => {
        ctx.cmd.ui.notify(`Failed refresh for ${provider.name}: ${error}`, "error");
      });
      await ctx.registerAllProviders();
      ctx.cmd.ui.notify(`Refreshed: ${provider.name}`, "info");
      return { kind: "stay" };
    }

    const confirmed = await ctx.cmd.ui.confirm("Delete provider", `Delete ${provider.name}?`);
    if (!confirmed) {
      return { kind: "stay" };
    }

    ctx.store.removeProvider(provider.name);
    ctx.authManager.clear(provider.name);
    await ctx.registerAllProviders();
    ctx.cmd.ui.notify(`Deleted provider: ${provider.name}`, "info");
    return { kind: "stay" };
  }

  return { kind: "stay" };
}
