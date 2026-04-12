import type { ModelConfig } from "../types.js";

const PRESETS: Record<string, Partial<ModelConfig>> = {
  // Together
  "meta-llama/Llama-3.3-70B-Instruct-Turbo": {
    contextWindow: 131072,
    capabilities: { toolCalling: true },
  },
  "meta-llama/Llama-3.1-405B-Instruct-Turbo": {
    contextWindow: 131072,
    capabilities: { toolCalling: true, reasoning: true },
  },
  "Qwen/Qwen2.5-Coder-32B-Instruct": {
    contextWindow: 32768,
    capabilities: { toolCalling: true },
  },
  "deepseek-ai/DeepSeek-V3": {
    contextWindow: 65536,
    capabilities: { toolCalling: true, reasoning: true },
  },

  // Fireworks
  "accounts/fireworks/models/llama-v3p1-405b-instruct": {
    contextWindow: 131072,
    capabilities: { toolCalling: true, reasoning: true },
  },
  "accounts/fireworks/models/deepseek-r1": {
    contextWindow: 32768,
    capabilities: { toolCalling: true, reasoning: true },
  },
  "accounts/fireworks/models/qwen2p5-coder-32b-instruct": {
    contextWindow: 32768,
    capabilities: { toolCalling: true },
  },

  // Perplexity
  "sonar": {
    contextWindow: 127000,
    capabilities: { toolCalling: true },
  },
  "sonar-pro": {
    contextWindow: 127000,
    capabilities: { toolCalling: true },
  },
  "sonar-reasoning": {
    contextWindow: 127000,
    capabilities: { toolCalling: true, reasoning: true },
  },
  "sonar-reasoning-pro": {
    contextWindow: 127000,
    capabilities: { toolCalling: true, reasoning: true },
  },

  // AI21
  "jamba-mini": {
    contextWindow: 256000,
    capabilities: { toolCalling: true },
  },
  "jamba-large": {
    contextWindow: 256000,
    capabilities: { toolCalling: true, reasoning: true },
  },
  "jamba-1.6-large": {
    contextWindow: 256000,
    capabilities: { toolCalling: true, reasoning: true },
  },

  // Poe / common model aliases
  "gpt-4o": {
    contextWindow: 128000,
    capabilities: { toolCalling: true, imageInput: true },
  },
  "gpt-4.1": {
    contextWindow: 1048576,
    capabilities: { toolCalling: true, imageInput: true },
  },
  "o3-mini": {
    contextWindow: 200000,
    capabilities: { toolCalling: true, reasoning: true },
  },
  "claude-3.7-sonnet": {
    contextWindow: 200000,
    capabilities: { toolCalling: true, imageInput: true, reasoning: true },
  },
  "claude-sonnet-4": {
    contextWindow: 200000,
    capabilities: { toolCalling: true, imageInput: true, reasoning: true },
  },
  "gemini-2.5-pro": {
    contextWindow: 1048576,
    capabilities: { toolCalling: true, imageInput: true, reasoning: true },
  },
  "qwen3-coder-plus": {
    contextWindow: 1000000,
    capabilities: { toolCalling: true, reasoning: true },
  },
};

export function getModelPreset(modelId: string): Partial<ModelConfig> | undefined {
  return PRESETS[modelId];
}

export function mergeModelWithPreset(model: ModelConfig): ModelConfig {
  const preset = PRESETS[model.id];
  if (!preset) return model;

  return {
    ...preset,
    ...model,
    capabilities: {
      ...(preset.capabilities ?? {}),
      ...(model.capabilities ?? {}),
    },
  };
}
