/**
 * Official Model Fetcher Service
 * Fetches model lists from provider APIs with exponential backoff and caching
 */

import type { UnifyProviderConfig, UnifyModelConfig, ProviderType } from "../config.js";
import type { ConfigStore } from "../config.js";
import { WELL_KNOWN_PROVIDERS, getWellKnownProvider } from "./well-known.js";
import { MODEL_PARAMETERS_DB } from "../models/database.js";

// ============================================================================
// Types
// ============================================================================

export interface FetchResult {
  models: UnifyModelConfig[];
  success: boolean;
  error?: string;
  fetchedAt: number;
}

interface FetchState {
  lastFetchTime: number;
  lastError?: string;
  currentIntervalMs: number;
  consecutiveErrors: number;
}

// ============================================================================
// Provider API Response Types
// ============================================================================

interface TogetherModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  context_length?: number;
  pricing?: {
    input: number;
    output: number;
  };
  capabilities?: {
    vision?: boolean;
    function_calling?: boolean;
  };
}

interface FireworksModel {
  id: string;
  object: "model";
  created?: number;
  owned_by?: string;
  context_length?: number;
}

interface AI21Model {
  id: string;
  name?: string;
  context_length?: number;
  input_token_price?: number;
  output_token_price?: number;
}

// Poe has a simpler model list
interface PoeModel {
  id: string;
  name?: string;
  context_window?: number;
  max_tokens?: number;
}

// ============================================================================
// Fetch Configuration
// ============================================================================

const FETCH_CONFIG = {
  initialIntervalMs: 5 * 60 * 1000, // 5 minutes
  maxIntervalMs: 24 * 60 * 60 * 1000, // 24 hours
  backoffMultiplier: 2,
  identicalFetchesThreshold: 2,
  minIntervalMs: 60 * 1000, // 1 minute
  errorInitialIntervalMs: 1000, // 1 second
  errorMaxIntervalMs: 60 * 1000, // 1 minute
  errorBackoffMultiplier: 2,
} as const;

// ============================================================================
// Official Models Fetcher
// ============================================================================

export class OfficialModelsFetcher {
  private configStore: ConfigStore;
  private fetchStates: Map<string, FetchState> = new Map();
  private fetchPromises: Map<string, Promise<FetchResult>> = new Map();

  constructor(configStore: ConfigStore) {
    this.configStore = configStore;
  }

  /**
   * Fetch official models for a provider
   * Implements exponential backoff and deduplication
   */
  async fetchOfficialModels(provider: UnifyProviderConfig): Promise<FetchResult> {
    // Check if fetch already in progress
    const existing = this.fetchPromises.get(provider.name);
    if (existing) {
      return existing;
    }

    // Create new fetch promise
    const promise = this.doFetch(provider);
    this.fetchPromises.set(provider.name, promise);

    try {
      const result = await promise;
      return result;
    } finally {
      this.fetchPromises.delete(provider.name);
    }
  }

  /**
   * Get merged models (manual + fetched + built-in params)
   */
  async getMergedModels(provider: UnifyProviderConfig): Promise<UnifyModelConfig[]> {
    // If auto-fetch is disabled, return stored models
    if (!provider.autoFetchOfficialModels) {
      return provider.models;
    }

    // Try to fetch fresh models
    const result = await this.fetchOfficialModels(provider);
    
    if (result.success) {
      // Merge with database
      return this.mergeWithDatabase(result.models, provider.type);
    }

    // Fallback to stored models on error
    console.warn(`[UnifyProvider] Fetch failed for ${provider.name}: ${result.error}`);
    return provider.models;
  }

  /**
   * Force refresh all providers
   */
  async refreshAll(): Promise<{ refreshed: number; failed: number; errors: string[] }> {
    const providers = this.configStore.getAllProviders().filter(
      p => p.autoFetchOfficialModels && getWellKnownProvider(p.type)?.supportsOfficialModelFetch
    );

    const results = await Promise.allSettled(
      providers.map(p => this.fetchOfficialModels(p))
    );

    let refreshed = 0;
    let failed = 0;
    const errors: string[] = [];

    results.forEach((result, index) => {
      const providerName = providers[index].name;
      if (result.status === "fulfilled" && result.value.success) {
        refreshed++;
        // Update stored models
        this.configStore.setProviderModels(providerName, result.value.models);
      } else {
        failed++;
        errors.push(`${providerName}: ${result.status === "rejected" ? String(result.reason) : result.value.error}`);
      }
    });

    return { refreshed, failed, errors };
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private async doFetch(provider: UnifyProviderConfig): Promise<FetchResult> {
    const wellKnown = getWellKnownProvider(provider.type);
    if (!wellKnown || !wellKnown.supportsOfficialModelFetch) {
      return {
        models: [],
        success: false,
        error: "Provider does not support official model fetching",
        fetchedAt: Date.now(),
      };
    }

    // Check if we should skip (rate limiting)
    const state = this.getFetchState(provider.name);
    const timeSinceLastFetch = Date.now() - state.lastFetchTime;
    if (timeSinceLastFetch < state.currentIntervalMs && state.lastFetchTime > 0) {
      return {
        models: provider.models,
        success: true,
        fetchedAt: state.lastFetchTime, // Return cached time
      };
    }

    try {
      const apiKey = this.resolveApiKey(provider);
      if (!apiKey) {
        throw new Error("API key not configured");
      }

      let models: UnifyModelConfig[] = [];

      switch (provider.type) {
        case "together":
          models = await this.fetchTogetherModels(provider, apiKey);
          break;
        case "fireworks":
          models = await this.fetchFireworksModels(provider, apiKey);
          break;
        case "ai21":
          models = await this.fetchAI21Models(provider, apiKey);
          break;
        case "poe":
          models = await this.fetchPoeModels(provider, apiKey);
          break;
        case "perplexity":
          // Perplexity doesn't support fetching, return hardcoded
          models = this.getPerplexityHardcodedModels();
          break;
        default:
          throw new Error(`Unknown provider type: ${provider.type}`);
      }

      // Update fetch state on success
      state.lastFetchTime = Date.now();
      state.consecutiveErrors = 0;
      state.currentIntervalMs = Math.min(
        state.currentIntervalMs * FETCH_CONFIG.backoffMultiplier,
        FETCH_CONFIG.maxIntervalMs
      );

      return {
        models,
        success: true,
        fetchedAt: Date.now(),
      };

    } catch (error) {
      // Update fetch state on error
      state.consecutiveErrors++;
      state.currentIntervalMs = Math.min(
        FETCH_CONFIG.errorInitialIntervalMs * Math.pow(FETCH_CONFIG.errorBackoffMultiplier, state.consecutiveErrors),
        FETCH_CONFIG.errorMaxIntervalMs
      );

      return {
        models: [],
        success: false,
        error: String(error),
        fetchedAt: Date.now(),
      };
    }
  }

  // --------------------------------------------------------------------------
  // Provider-Specific Fetchers
  // --------------------------------------------------------------------------

  private async fetchTogetherModels(provider: UnifyProviderConfig, apiKey: string): Promise<UnifyModelConfig[]> {
    const endpoint = WELL_KNOWN_PROVIDERS.together.modelsEndpoint!;
    
    const response = await fetch(endpoint, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Together API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { data: TogetherModel[] };

    return data.data
      .filter((m: TogetherModel) => {
        // Filter to models that support tool calling
        return m.capabilities?.function_calling !== false;
      })
      .map((model: TogetherModel): UnifyModelConfig => ({
        id: model.id,
        name: model.id.split("/").pop() || model.id,
        family: model.owned_by,
        contextWindow: model.context_length || 128000,
        maxOutputTokens: 8192,
        capabilities: {
          textInput: true,
          toolCalling: model.capabilities?.function_calling ?? true,
          imageInput: model.capabilities?.vision ?? false,
        },
        cost: model.pricing ? {
          input: model.pricing.input * 1000000, // Convert to per-1M
          output: model.pricing.output * 1000000,
        } : { input: 0, output: 0 },
        source: "fetched",
        fetchedAt: Date.now(),
      }));
  }

  private async fetchFireworksModels(provider: UnifyProviderConfig, apiKey: string): Promise<UnifyModelConfig[]> {
    const endpoint = WELL_KNOWN_PROVIDERS.fireworks.modelsEndpoint!;
    const response = await fetch(endpoint, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Fireworks API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { data: FireworksModel[] };

    return data.data
      .filter((m: FireworksModel) => {
        // Filter to chat models (not embeddings/other)
        return m.id.includes("-chat") || m.id.includes("-instruct") || m.owned_by === "fireworks";
      })
      .map((model: FireworksModel): UnifyModelConfig => {
        // Apply model ID transformation
        const id = model.id.replace(/^accounts\/fireworks\/models\//, "");
        return {
          id: model.id,
          name: id,
          family: model.owned_by || "fireworks",
          contextWindow: model.context_length || 131072,
          maxOutputTokens: 8192,
          capabilities: {
            textInput: true,
            toolCalling: true, // Most Fireworks models support tools
            imageInput: false, // Would need capability detection
          },
          cost: { input: 0.9, output: 0.9 }, // Default pricing
          source: "fetched",
          fetchedAt: Date.now(),
        };
      });
  }

  private async fetchAI21Models(provider: UnifyProviderConfig, apiKey: string): Promise<UnifyModelConfig[]> {
    const endpoint = WELL_KNOWN_PROVIDERS.ai21.modelsEndpoint!;
    const response = await fetch(endpoint, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`AI21 API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { models: AI21Model[] };

    return data.models
      .filter((m: AI21Model) => {
        // Filter to chat models
        return m.id.includes("jamba") || m.id.includes("jurassic");
      })
      .map((model: AI21Model): UnifyModelConfig => ({
        id: model.id,
        name: model.name || model.id,
        family: model.id.includes("jamba") ? "jamba" : "jurassic",
        contextWindow: model.context_length || 256000,
        maxOutputTokens: 4096,
        capabilities: {
          textInput: true,
          toolCalling: model.id.includes("jamba"),
          imageInput: false,
          reasoning: model.id.includes("jamba-l"),
        },
        cost: model.input_token_price && model.output_token_price ? {
          input: model.input_token_price * 1000000,
          output: model.output_token_price * 1000000,
        } : { input: 2.0, output: 8.0 },
        source: "fetched",
        fetchedAt: Date.now(),
      }));
  }

  private async fetchPoeModels(provider: UnifyProviderConfig, apiKey: string): Promise<UnifyModelConfig[]> {
    const endpoint = WELL_KNOWN_PROVIDERS.poe.modelsEndpoint!;
    const response = await fetch(endpoint, {
      headers: {
        "Authorization": apiKey.startsWith("poe-") ? apiKey : `Bearer ${apiKey}`,
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Poe API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { models: PoeModel[] };

    return data.models
      .map((model: PoeModel): UnifyModelConfig => ({
        id: model.id,
        name: model.name || model.id,
        family: "poe",
        contextWindow: model.context_window || 128000,
        maxOutputTokens: model.max_tokens || 4096,
        capabilities: {
          textInput: true,
          toolCalling: true,
          imageInput: false,
        },
        cost: { input: 0, output: 0 }, // Pricing varies by model
        source: "fetched",
        fetchedAt: Date.now(),
      }));
  }

  private getPerplexityHardcodedModels(): UnifyModelConfig[] {
    // Perplexity doesn't have a model API, return hardcoded list
    return [
      {
        id: "sonar",
        name: "Sonar",
        family: "sonar",
        contextWindow: 128000,
        maxOutputTokens: 4096,
        capabilities: { textInput: true, toolCalling: false, imageInput: false },
        cost: { input: 5, output: 5 },
        source: "builtin",
      },
      {
        id: "sonar-pro",
        name: "Sonar Pro",
        family: "sonar",
        contextWindow: 200000,
        maxOutputTokens: 8192,
        capabilities: { textInput: true, toolCalling: true, imageInput: false },
        cost: { input: 15, output: 60 },
        source: "builtin",
      },
      {
        id: "sonar-reasoning",
        name: "Sonar Reasoning",
        family: "sonar",
        contextWindow: 128000,
        maxOutputTokens: 8192,
        capabilities: { textInput: true, toolCalling: true, imageInput: false, reasoning: true },
        cost: { input: 10, output: 40 },
        source: "builtin",
      },
    ];
  }

  private async mergeWithDatabase(
    models: UnifyModelConfig[],
    providerType: ProviderType
  ): Promise<UnifyModelConfig[]> {
    return models.map((model) => {
      // Look up in database
      const dbEntry = MODEL_PARAMETERS_DB.get(model.id);
      if (dbEntry) {
        return {
          ...dbEntry,
          ...model, // Fetched values take precedence
          capabilities: {
            ...dbEntry.capabilities,
            ...model.capabilities,
          },
          cost: model.cost?.input !== undefined ? model.cost : dbEntry.cost,
        };
      }
      return model;
    });
  }

  private getFetchState(providerName: string): FetchState {
    if (!this.fetchStates.has(providerName)) {
      this.fetchStates.set(providerName, {
        lastFetchTime: 0,
        currentIntervalMs: FETCH_CONFIG.initialIntervalMs,
        consecutiveErrors: 0,
      });
    }
    return this.fetchStates.get(providerName)!;
  }

  private resolveApiKey(provider: UnifyProviderConfig): string | undefined {
    // 1. Environment variable
    const envVar = provider.auth?.type === "api_key" && "envVar" in provider.auth
      ? (provider.auth as any).envVar
      : `${provider.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;

    const envValue = process.env[envVar];
    if (envValue) return envValue;

    // 2. Check AuthManager for stored keys
    // Note: OAuth credentials and stored API keys would be here

    return undefined;
  }
}

