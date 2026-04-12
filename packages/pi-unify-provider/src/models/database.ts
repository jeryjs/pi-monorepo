/**
 * Model Parameters Database
 * Built-in presets for common models with optimized parameters
 */

import type { UnifyModelConfig } from "../config.js";

/**
 * Built-in model parameters database
 * Key: Model ID (can be partial match)
 * Value: Partial model config with recommended parameters
 */
export const MODEL_PARAMETERS_DB = new Map<string, Partial<UnifyModelConfig>>([
  // ==================== Anthropic Claude ====================
  ["claude-3-opus", {
    name: "Claude 3 Opus",
    contextWindow: 200000,
    maxOutputTokens: 4096,
    capabilities: { textInput: true, imageInput: true, toolCalling: true, reasoning: false },
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    temperature: 1.0,
    compat: { supportsDeveloperRole: true, supportsReasoningEffort: false },
  }],
  ["claude-3-sonnet", {
    name: "Claude 3.5 Sonnet",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    capabilities: { textInput: true, imageInput: true, toolCalling: true, reasoning: false },
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    temperature: 1.0,
    compat: { supportsDeveloperRole: true, supportsReasoningEffort: false },
  }],
  ["claude-3-haiku", {
    name: "Claude 3 Haiku",
    contextWindow: 200000,
    maxOutputTokens: 4096,
    capabilities: { textInput: true, imageInput: true, toolCalling: true, reasoning: false },
    cost: { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
    temperature: 1.0,
    compat: { supportsDeveloperRole: true, supportsReasoningEffort: false },
  }],

  // ==================== OpenAI GPT ====================
  ["gpt-4o", {
    name: "GPT-4o",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    capabilities: { textInput: true, imageInput: true, toolCalling: true, reasoning: false },
    cost: { input: 2.5, output: 10 },
    temperature: 1.0,
    compat: { supportsDeveloperRole: true, supportsReasoningEffort: false },
  }],
  ["gpt-4o-mini", {
    name: "GPT-4o Mini",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    capabilities: { textInput: true, imageInput: true, toolCalling: true, reasoning: false },
    cost: { input: 0.15, output: 0.6 },
    temperature: 1.0,
    compat: { supportsDeveloperRole: true, supportsReasoningEffort: false },
  }],
  ["o1", {
    name: "o1",
    contextWindow: 200000,
    maxOutputTokens: 100000,
    capabilities: { textInput: true, imageInput: true, toolCalling: true, reasoning: true },
    cost: { input: 15, output: 60 },
    temperature: 1.0,
    compat: { supportsDeveloperRole: true, supportsReasoningEffort: true },
  }],
  ["o1-mini", {
    name: "o1-mini",
    contextWindow: 128000,
    maxOutputTokens: 65536,
    capabilities: { textInput: true, imageInput: false, toolCalling: true, reasoning: true },
    cost: { input: 1.1, output: 4.4 },
    temperature: 1.0,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
  }],

  // ==================== Google Gemini ====================
  ["gemini-1.5-pro", {
    name: "Gemini 1.5 Pro",
    contextWindow: 2000000,
    maxOutputTokens: 8192,
    capabilities: { textInput: true, imageInput: true, toolCalling: true, reasoning: false },
    cost: { input: 1.25, output: 5 },
    temperature: 1.0,
  }],
  ["gemini-1.5-flash", {
    name: "Gemini 1.5 Flash",
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    capabilities: { textInput: true, imageInput: true, toolCalling: true, reasoning: false },
    cost: { input: 0.075, output: 0.3 },
    temperature: 1.0,
  }],

  // ==================== Together AI Models ====================
  ["meta-llama", {
    contextWindow: 128000,
    maxOutputTokens: 4096,
    capabilities: { textInput: true, imageInput: false, toolCalling: true, reasoning: false },
    cost: { input: 0.18, output: 0.72 },
    temperature: 0.7,
  }],
  ["meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo", {
    name: "Llama 3.1 405B",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    capabilities: { textInput: true, imageInput: false, toolCalling: true, reasoning: false },
    cost: { input: 5, output: 15 },
    temperature: 0.7,
  }],
  ["meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo", {
    name: "Llama 3.1 70B",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    capabilities: { textInput: true, imageInput: false, toolCalling: true, reasoning: false },
    cost: { input: 0.88, output: 0.88 },
    temperature: 0.7,
  }],
  ["mistralai", {
    contextWindow: 128000,
    maxOutputTokens: 4096,
    capabilities: { textInput: true, imageInput: false, toolCalling: true, reasoning: false },
    cost: { input: 0.6, output: 0.6 },
    temperature: 0.7,
  }],
  ["deepseek-ai", {
    contextWindow: 128000,
    maxOutputTokens: 4096,
    capabilities: { textInput: true, imageInput: false, toolCalling: true, reasoning: true },
    cost: { input: 0.14, output: 0.28 },
    temperature: 1.0,
    compat: { supportsUsageInStreaming: true },
  }],
  ["Qwen", {
    contextWindow: 128000,
    maxOutputTokens: 4096,
    capabilities: { textInput: true, imageInput: false, toolCalling: true, reasoning: false },
    cost: { input: 0.5, output: 0.5 },
    temperature: 0.7,
    compat: { supportsDeveloperRole: false },
  }],

  // ==================== Fireworks Models ====================
  ["accounts/fireworks/models/llama-v3p1-405b-instruct", {
    name: "Llama 3.1 405B (Fireworks)",
    contextWindow: 131072,
    maxOutputTokens: 8192,
    capabilities: { textInput: true, imageInput: false, toolCalling: true, reasoning: false },
    cost: { input: 0.9, output: 0.9 },
    temperature: 0.7,
  }],
  ["accounts/fireworks/models/llama-v3p1-70b-instruct", {
    name: "Llama 3.1 70B (Fireworks)",
    contextWindow: 131072,
    maxOutputTokens: 8192,
    capabilities: { textInput: true, imageInput: false, toolCalling: true, reasoning: false },
    cost: { input: 0.9, output: 0.9 },
    temperature: 0.7,
  }],
  ["accounts/fireworks/models/mixtral-8x22b-instruct", {
    name: "Mixtral 8x22B (Fireworks)",
    contextWindow: 65536,
    maxOutputTokens: 8192,
    capabilities: { textInput: true, imageInput: false, toolCalling: true, reasoning: false },
    cost: { input: 0.9, output: 0.9 },
    temperature: 0.7,
  }],

  // ==================== Perplexity Models ====================
  ["sonar", {
    name: "Sonar",
    contextWindow: 128000,
    maxOutputTokens: 4096,
    capabilities: { textInput: true, imageInput: false, toolCalling: false, reasoning: false },
    cost: { input: 5, output: 5 },
    temperature: 0.7,
    compat: { supportsUsageInStreaming: false },
  }],
  ["sonar-pro", {
    name: "Sonar Pro",
    contextWindow: 200000,
    maxOutputTokens: 8192,
    capabilities: { textInput: true, imageInput: false, toolCalling: true, reasoning: false },
    cost: { input: 15, output: 60 },
    temperature: 0.7,
    compat: { supportsUsageInStreaming: false },
  }],
  ["sonar-reasoning", {
    name: "Sonar Reasoning",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    capabilities: { textInput: true, imageInput: false, toolCalling: true, reasoning: true },
    cost: { input: 10, output: 40 },
    temperature: 0.7,
    compat: { supportsUsageInStreaming: false },
  }],

  // ==================== AI21 Models ====================
  ["jamba-1-5-large", {
    name: "Jamba 1.5 Large",
    contextWindow: 256000,
    maxOutputTokens: 4096,
    capabilities: { textInput: true, imageInput: false, toolCalling: true, reasoning: true },
    cost: { input: 2, output: 8 },
    temperature: 0.7,
  }],
  ["jamba-1-5-mini", {
    name: "Jamba 1.5 Mini",
    contextWindow: 256000,
    maxOutputTokens: 4096,
    capabilities: { textInput: true, imageInput: false, toolCalling: true, reasoning: true },
    cost: { input: 0.2, output: 0.4 },
    temperature: 0.7,
  }],
]);
