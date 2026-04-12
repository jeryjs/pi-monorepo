import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ConfigStore } from "../config-store.js";
import type { AuthManager } from "../auth/auth-manager.js";
import type { OfficialModelsFetcher } from "../providers/fetcher.js";
import { runUiStack } from "./router/stack-router.js";

interface RegisterUiCommandsInput {
  pi: ExtensionAPI;
  store: ConfigStore;
  authManager: AuthManager;
  fetcher: OfficialModelsFetcher;
  registerAllProviders: () => Promise<void>;
}

export function registerUiCommands(input: RegisterUiCommandsInput): void {
  const openDashboard = async (cmd: ExtensionCommandContext): Promise<void> => {
    await runUiStack(
      {
        pi: input.pi,
        cmd,
        store: input.store,
        authManager: input.authManager,
        fetcher: input.fetcher,
        registerAllProviders: input.registerAllProviders,
      },
      { kind: "provider-list" },
    );
  };

  input.pi.registerCommand("unify", {
    description: "Open provider dashboard",
    handler: async (_args, cmd) => {
      await openDashboard(cmd);
    },
  });

  input.pi.registerCommand("unify-providers", {
    description: "Open provider dashboard",
    handler: async (_args, cmd) => {
      await openDashboard(cmd);
    },
  });

  input.pi.registerCommand("unify-add", {
    description: "Add provider via well-known list",
    handler: async (_args, cmd) => {
      await runUiStack(
        {
          pi: input.pi,
          cmd,
          store: input.store,
          authManager: input.authManager,
          fetcher: input.fetcher,
          registerAllProviders: input.registerAllProviders,
        },
        { kind: "well-known-provider-list" },
      );
    },
  });

  input.pi.registerCommand("unify-refresh", {
    description: "Refresh official model lists",
    handler: async (_args, cmd) => {
      const summary = await input.fetcher.fetchAllProviders(true);
      await input.registerAllProviders();
      if (summary.failed > 0) {
        cmd.ui.notify(
          `Refreshed ${summary.refreshed}, failed ${summary.failed}`,
          "warning",
        );
      } else {
        cmd.ui.notify(`Refreshed ${summary.refreshed} provider(s)`, "info");
      }
    },
  });
}
