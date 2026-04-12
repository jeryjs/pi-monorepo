import type { ConfigStore } from "../config-store.js";
import type { AuthManager } from "../auth/auth-manager.js";
import type { ModelConfig, ProviderConfig } from "../types.js";
import { mergeModelWithPreset } from "../models/database.js";
import { getWellKnownProvider } from "./well-known.js";

export interface FetchSummary {
  refreshed: number;
  failed: number;
  errors: Array<{ provider: string; error: string }>;
}

const DEFAULT_FETCH_INTERVAL_MS = 30 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createUrl(baseUrl: string, endpoint: string, query?: Record<string, string>): string {
  const url = new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function normalizeModel(input: Partial<ModelConfig> & { id: string }): ModelConfig {
  return mergeModelWithPreset({
    id: input.id,
    name: input.name,
    family: input.family,
    contextWindow: input.contextWindow,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    capabilities: {
      toolCalling: input.capabilities?.toolCalling ?? true,
      imageInput: input.capabilities?.imageInput ?? false,
      reasoning: input.capabilities?.reasoning ?? false,
      editTools: input.capabilities?.editTools,
    },
    cost: input.cost,
    source: input.source ?? "fetched",
    fetchedAt: Date.now(),
  });
}

export class OfficialModelsFetcher {
  constructor(
    private readonly store: ConfigStore,
    private readonly authManager: AuthManager,
  ) {}

  async fetchAllProviders(force = false): Promise<FetchSummary> {
    const providers = this.store.getAllProviders().filter((provider) => provider.autoFetchOfficialModels !== false);

    let refreshed = 0;
    let failed = 0;
    const errors: Array<{ provider: string; error: string }> = [];

    for (const provider of providers) {
      try {
        const result = await this.fetchProvider(provider.name, force);
        if (result.refreshed) refreshed++;
      } catch (error) {
        failed++;
        errors.push({ provider: provider.name, error: String(error) });
      }
    }

    return { refreshed, failed, errors };
  }

  async fetchProvider(providerName: string, force = false): Promise<{ refreshed: boolean; models: ModelConfig[] }> {
    const provider = this.store.getProvider(providerName);
    if (!provider) {
      throw new Error(`Provider not found: ${providerName}`);
    }

    if (!force && !this.shouldFetch(provider)) {
      return { refreshed: false, models: provider.models };
    }

    const models = await this.fetchWithBackoff(provider);
    this.store.setProviderModels(provider.name, models);
    return { refreshed: true, models };
  }

  async getMergedModels(provider: ProviderConfig): Promise<ModelConfig[]> {
    const wellKnown = getWellKnownProvider(provider.type);
    const fetched = provider.autoFetchOfficialModels === false
      ? provider.models
      : (await this.fetchProvider(provider.name).catch(() => ({ refreshed: false, models: provider.models }))).models;

    const byId = new Map<string, ModelConfig>();

    for (const model of wellKnown?.hardcodedModels ?? []) {
      byId.set(model.id, normalizeModel({ ...model, source: "builtin" }));
    }

    for (const model of fetched) {
      byId.set(model.id, normalizeModel({ ...model, source: model.source ?? "fetched" }));
    }

    for (const model of provider.models) {
      byId.set(model.id, normalizeModel({ ...model, source: model.source ?? "manual" }));
    }

    return [...byId.values()];
  }

  private shouldFetch(provider: ProviderConfig): boolean {
    if (!provider.lastFetchTime) return true;
    return Date.now() - provider.lastFetchTime > DEFAULT_FETCH_INTERVAL_MS;
  }

  private async fetchWithBackoff(provider: ProviderConfig): Promise<ModelConfig[]> {
    const maxRetries = provider.retry?.maxRetries ?? 3;
    const initialDelay = provider.retry?.initialDelayMs ?? 500;
    const maxDelay = provider.retry?.maxDelayMs ?? 8000;
    const multiplier = provider.retry?.backoffMultiplier ?? 2;
    const jitter = provider.retry?.jitterFactor ?? 0.2;

    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.fetchProviderModels(provider);
      } catch (error) {
        lastError = error;
        if (attempt === maxRetries) break;

        const baseDelay = Math.min(maxDelay, initialDelay * Math.pow(multiplier, attempt));
        const randomized = baseDelay * (1 + (Math.random() * 2 - 1) * jitter);
        await sleep(Math.max(1, Math.round(randomized)));
      }
    }

    const message = String(lastError);
    this.store.markFetchError(provider.name, message);
    throw new Error(`Failed to fetch models for ${provider.name}: ${message}`);
  }

  private async fetchProviderModels(provider: ProviderConfig): Promise<ModelConfig[]> {
    const wellKnown = getWellKnownProvider(provider.type);
    if (!wellKnown) {
      return provider.models;
    }

    if (!wellKnown.officialModelsEndpoint) {
      return (wellKnown.hardcodedModels ?? []).map((model) => normalizeModel({ ...model, source: "builtin" }));
    }

    const auth = await this.authManager.resolveAuth(provider, {
      ...(wellKnown.defaultHeaders ?? {}),
      ...(provider.extraHeaders ?? {}),
    });

    const timeoutMs = provider.timeout?.response ?? 30_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = createUrl(provider.baseUrl, wellKnown.officialModelsEndpoint, auth.query);

      const response = await fetch(url, {
        method: "GET",
        headers: auth.headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const body = await response.json();
      const parsed = this.parseModelsFromResponse(provider, body);

      const combined = new Map<string, ModelConfig>();
      for (const model of wellKnown.hardcodedModels ?? []) {
        combined.set(model.id, normalizeModel({ ...model, source: "builtin" }));
      }
      for (const model of parsed) {
        combined.set(model.id, normalizeModel({ ...model, source: "fetched" }));
      }

      return [...combined.values()];
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseModelsFromResponse(provider: ProviderConfig, payload: any): ModelConfig[] {
    // OpenAI style: { data: [{ id, ... }] }
    const openAiModels = Array.isArray(payload?.data) ? payload.data : undefined;
    if (openAiModels) {
      return openAiModels
        .filter((model: any) => !!model?.id)
        .map((model: any) => normalizeModel({
          id: String(model.id),
          name: model.name ? String(model.name) : undefined,
          family: model.family ? String(model.family) : undefined,
          contextWindow: typeof model.context_window === "number" ? model.context_window : undefined,
          maxOutputTokens: typeof model.max_output_tokens === "number" ? model.max_output_tokens : undefined,
          capabilities: {
            toolCalling: model.capabilities?.function_calling ?? true,
            imageInput: model.capabilities?.vision ?? false,
            reasoning: model.capabilities?.reasoning ?? false,
          },
        }));
    }

    // Some APIs return array directly
    if (Array.isArray(payload)) {
      return payload
        .filter((model: any) => !!model?.id)
        .map((model: any) => normalizeModel({
          id: String(model.id),
          name: model.name ? String(model.name) : undefined,
          family: model.family ? String(model.family) : undefined,
          capabilities: {
            toolCalling: model.tool_calling ?? true,
            imageInput: model.image_input ?? false,
            reasoning: model.reasoning ?? false,
          },
        }));
    }

    // Fallback for providers with no models endpoint compatibility
    const fallback = getWellKnownProvider(provider.type)?.hardcodedModels ?? [];
    return fallback.map((model) => normalizeModel({ ...model, source: "builtin" }));
  }
}
