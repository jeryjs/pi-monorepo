import type { Api } from "@mariozechner/pi-ai";
import type { AuthMethod, ProviderType, ModelConfig } from "../types.js";

export interface WellKnownProviderConfig {
  id: ProviderType;
  name: string;
  category: "Hosted APIs" | "Custom";
  description: string;
  baseUrl: string;
  api: Api;
  authMethods: AuthMethod[];
  defaultAuthMethod: AuthMethod;
  officialModelsEndpoint?: string;
  defaultHeaders?: Record<string, string>;
  hardcodedModels?: ModelConfig[];
}

export const WELL_KNOWN_PROVIDERS: WellKnownProviderConfig[] = [
  {
    id: "together",
    name: "Together AI",
    category: "Hosted APIs",
    description: "OpenAI-compatible API for open models",
    baseUrl: "https://api.together.xyz/v1",
    api: "openai-completions",
    authMethods: [
      "api-key",
      "bearer-token",
      "oauth2",
      "oauth2-pkce",
      "oauth-device-code",
      "custom-header",
      "query-param",
      "none",
    ],
    defaultAuthMethod: "api-key",
    officialModelsEndpoint: "/models",
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    category: "Hosted APIs",
    description: "OpenAI-compatible inference API",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    api: "openai-completions",
    authMethods: [
      "api-key",
      "bearer-token",
      "oauth2",
      "oauth2-pkce",
      "oauth-device-code",
      "custom-header",
      "query-param",
      "none",
    ],
    defaultAuthMethod: "api-key",
    officialModelsEndpoint: "/models",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    category: "Hosted APIs",
    description: "Perplexity Sonar and reasoning models",
    baseUrl: "https://api.perplexity.ai",
    api: "openai-completions",
    authMethods: [
      "api-key",
      "bearer-token",
      "oauth2",
      "oauth2-pkce",
      "oauth-device-code",
      "custom-header",
      "query-param",
      "none",
    ],
    defaultAuthMethod: "api-key",
    officialModelsEndpoint: "/models",
    hardcodedModels: [
      { id: "sonar", name: "Sonar", source: "builtin" },
      { id: "sonar-pro", name: "Sonar Pro", source: "builtin" },
      { id: "sonar-reasoning", name: "Sonar Reasoning", capabilities: { reasoning: true }, source: "builtin" },
      { id: "sonar-reasoning-pro", name: "Sonar Reasoning Pro", capabilities: { reasoning: true }, source: "builtin" },
    ],
  },
  {
    id: "ai21",
    name: "AI21",
    category: "Hosted APIs",
    description: "AI21 Jamba family models",
    baseUrl: "https://api.ai21.com/studio/v1",
    api: "openai-completions",
    authMethods: [
      "api-key",
      "bearer-token",
      "oauth2",
      "oauth2-pkce",
      "oauth-device-code",
      "custom-header",
      "query-param",
      "none",
    ],
    defaultAuthMethod: "api-key",
    officialModelsEndpoint: "/models",
    hardcodedModels: [
      { id: "jamba-mini", name: "Jamba Mini", source: "builtin" },
      { id: "jamba-large", name: "Jamba Large", source: "builtin", capabilities: { reasoning: true } },
      { id: "jamba-1.6-large", name: "Jamba 1.6 Large", source: "builtin", capabilities: { reasoning: true } },
    ],
  },
  {
    id: "poe",
    name: "Poe",
    category: "Hosted APIs",
    description: "OpenAI-compatible Poe API endpoint",
    baseUrl: "https://api.poe.com/v1",
    api: "openai-completions",
    authMethods: [
      "api-key",
      "bearer-token",
      "oauth2",
      "oauth2-pkce",
      "oauth-device-code",
      "browser-session",
      "custom-header",
      "query-param",
      "none",
    ],
    defaultAuthMethod: "api-key",
    officialModelsEndpoint: "/models",
  },
  {
    id: "custom",
    name: "Custom Provider",
    category: "Custom",
    description: "Bring your own OpenAI/Anthropic-compatible gateway",
    baseUrl: "https://api.example.com/v1",
    api: "openai-completions",
    authMethods: [
      "api-key",
      "bearer-token",
      "oauth2",
      "oauth2-pkce",
      "oauth-device-code",
      "browser-session",
      "custom-header",
      "query-param",
      "none",
    ],
    defaultAuthMethod: "api-key",
    officialModelsEndpoint: "/models",
  },
];

export function getWellKnownProviders(): WellKnownProviderConfig[] {
  return WELL_KNOWN_PROVIDERS;
}

export function getWellKnownProvider(type: ProviderType): WellKnownProviderConfig | undefined {
  return WELL_KNOWN_PROVIDERS.find((provider) => provider.id === type);
}
