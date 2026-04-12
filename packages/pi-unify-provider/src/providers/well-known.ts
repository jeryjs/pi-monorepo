/**
 * Well-known provider definitions and API configurations
 * Contains the 5 target providers: Poe, Together, Fireworks, Perplexity, AI21
 */

import type { ProviderType } from "../config.js";

export interface WellKnownProvider {
  name: string;
  type: ProviderType;
  displayName: string;
  description: string;
  apiType: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  defaultBaseUrl: string;
  defaultContextWindow: number;
  defaultMaxTokens: number;
  supportsOfficialModelFetch: boolean;
  // API endpoint for fetching models (if supported)
  modelsEndpoint?: string;
  // OAuth configuration
  oauth?: {
    name: string;
    authUrl: string;
    tokenUrl: string;
    scopes: string[];
  };
  // Default headers required
  defaultHeaders?: Record<string, string>;
  // Auth type
  authType: "api_key" | "oauth" | "both";
  // Provider-specific quirks
  quirks?: {
    // Transform model names (e.g., remove prefixes)
    modelIdTransform?: (id: string) => string;
    // Custom parameter injection
    extraBodyParams?: Record<string, unknown>;
  };
}

export const WELL_KNOWN_PROVIDERS: Record<ProviderType, WellKnownProvider> = {
  // ==========================================================================
  // Poe - creator.poe.com/docs
  // ==========================================================================
  poe: {
    name: "poe",
    type: "poe",
    displayName: "Poe",
    description: "Universal AI hub with access to 100+ models",
    apiType: "openai-completions",
    defaultBaseUrl: "https://api.poe.com/machine",
    defaultContextWindow: 128000,
    defaultMaxTokens: 4096,
    supportsOfficialModelFetch: true,
    modelsEndpoint: "https://api.poe.com/machine/models",
    authType: "api_key", // Uses API keys
    defaultHeaders: {
      "Accept": "application/json",
    },
    quirks: {
      modelIdTransform: (id) => id.replace(/^poe-/, ""), // Strip poe- prefix if present
    },
  },

  // ==========================================================================
  // Together AI - together.xyz
  // ==========================================================================
  together: {
    name: "together",
    type: "together",
    displayName: "Together AI",
    description: "Inference platform for open-source models",
    apiType: "openai-completions",
    defaultBaseUrl: "https://api.together.xyz/v1",
    defaultContextWindow: 128000,
    defaultMaxTokens: 8192,
    supportsOfficialModelFetch: true,
    modelsEndpoint: "https://api.together.xyz/v1/models",
    authType: "api_key",
    defaultHeaders: {
      "Accept": "application/json",
    },
    quirks: {
      // Together exposes models as "organization/model-name"
      modelIdTransform: (id) => id,
    },
  },

  // ==========================================================================
  // Fireworks AI - fireworks.ai
  // ==========================================================================
  fireworks: {
    name: "fireworks",
    type: "fireworks",
    displayName: "Fireworks AI",
    description: "Fast, affordable generative AI inference",
    apiType: "openai-completions",
    defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
    defaultContextWindow: 131072,
    defaultMaxTokens: 8192,
    supportsOfficialModelFetch: true,
    modelsEndpoint: "https://api.fireworks.ai/inference/v1/models",
    authType: "api_key",
    defaultHeaders: {
      "Accept": "application/json",
    },
    quirks: {
      // Fireworks uses "accounts/fireworks/models/" prefix
      modelIdTransform: (id) => id.replace(/^accounts\/fireworks\/models\//, ""),
    },
  },

  // ==========================================================================
  // Perplexity - perplexity.ai
  // ==========================================================================
  perplexity: {
    name: "perplexity",
    type: "perplexity",
    displayName: "Perplexity",
    description: "pplx-api with Sonar models",
    apiType: "openai-completions",
    defaultBaseUrl: "https://api.perplexity.ai",
    defaultContextWindow: 128000,
    defaultMaxTokens: 8192,
    supportsOfficialModelFetch: false, // Perplexity doesn't have a models endpoint, uses hardcoded list
    authType: "api_key",
    defaultHeaders: {
      "Accept": "application/json",
    },
    quirks: {
      // Perplexity doesn't support streaming tokens usage
      extraBodyParams: {
        "return_citations": false, // We handle citations differently
      },
    },
  },

  // ==========================================================================
  // AI21 Labs - studio.ai21.com
  // ==========================================================================
  ai21: {
    name: "ai21",
    type: "ai21",
    displayName: "AI21 Labs",
    description: "Jurassic and Jamba models",
    apiType: "openai-completions",
    defaultBaseUrl: "https://api.ai21.com/studio/v1",
    defaultContextWindow: 256000,
    defaultMaxTokens: 4096,
    supportsOfficialModelFetch: true,
    modelsEndpoint: "https://api.ai21.com/studio/v1/models",
    authType: "api_key",
    defaultHeaders: {
      "Accept": "application/json",
    },
    quirks: {
      // AI21 model IDs often use organization/model format
      modelIdTransform: (id) => id,
    },
  },
};

/**
 * Get well-known provider by type
 */
export function getWellKnownProvider(type: ProviderType): WellKnownProvider | undefined {
  return WELL_KNOWN_PROVIDERS[type];
}

/**
 * Get all well-known providers
 */
export function getAllWellKnownProviders(): WellKnownProvider[] {
  return Object.values(WELL_KNOWN_PROVIDERS);
}

/**
 * Get providers that support official model fetching
 */
export function getProvidersWithModelFetch(): ProviderType[] {
  return Object.entries(WELL_KNOWN_PROVIDERS)
    .filter(([_, def]) => def.supportsOfficialModelFetch)
    .map(([type, _]) => type as ProviderType);
}
