import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { ConfigStore } from "../../config-store.js";
import type { AuthManager } from "../../auth/auth-manager.js";
import type { OfficialModelsFetcher } from "../../providers/fetcher.js";
import type { AuthMethod, ModelConfig, ProviderConfig, ProviderType } from "../../types.js";

export interface UiContext {
  pi: ExtensionAPI;
  cmd: ExtensionCommandContext;
  store: ConfigStore;
  authManager: AuthManager;
  fetcher: OfficialModelsFetcher;
  registerAllProviders: () => Promise<void>;
}

export interface ProviderListRoute {
  kind: "provider-list";
}

export interface WellKnownProviderListRoute {
  kind: "well-known-provider-list";
}

export interface ProviderFormRoute {
  kind: "provider-form";
  mode: "create" | "edit";
  providerName?: string;
  draft: Partial<ProviderConfig> & { models: ModelConfig[] };
}

export interface AuthMethodRoute {
  kind: "auth-method";
  draft: Partial<ProviderConfig> & { models: ModelConfig[] };
}

export interface ModelListRoute {
  kind: "model-list";
  draft: Partial<ProviderConfig> & { models: ModelConfig[] };
}

export interface ModelFormRoute {
  kind: "model-form";
  draft: ModelConfig;
  models: ModelConfig[];
  originalId?: string;
}

export type UiRoute =
  | ProviderListRoute
  | WellKnownProviderListRoute
  | ProviderFormRoute
  | AuthMethodRoute
  | ModelListRoute
  | ModelFormRoute;

export type UiResume =
  | { kind: "model-saved"; model: ModelConfig; originalId?: string }
  | { kind: "model-deleted"; modelId: string }
  | { kind: "provider-saved"; provider: ProviderConfig }
  | { kind: "noop" };

export type UiNavAction =
  | { kind: "stay" }
  | { kind: "push"; route: UiRoute }
  | { kind: "replace"; route: UiRoute }
  | { kind: "pop"; resume?: UiResume }
  | { kind: "exit" };

export interface WellKnownAddChoice {
  type: ProviderType;
  name: string;
  baseUrl: string;
  api: string;
  authMethods: AuthMethod[];
}
