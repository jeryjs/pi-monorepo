import type { UnifyModelConfig } from "./types.js";

export interface ModelMetadata {
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	imageInput?: boolean;
}

export const MODEL_METADATA: Record<string, ModelMetadata> = {
	"meta-llama/llama-3.3-70b-instruct-turbo": {
		contextWindow: 131_072,
		maxTokens: 8_192,
	},
	"meta-llama/llama-4-maverick-17b-128e-instruct": {
		contextWindow: 131_072,
		maxTokens: 8_192,
		imageInput: true,
	},
	"deepseek-ai/DeepSeek-R1": {
		contextWindow: 131_072,
		maxTokens: 16_384,
		reasoning: true,
	},
	"Qwen/Qwen2.5-Coder-32B-Instruct": {
		contextWindow: 131_072,
		maxTokens: 8_192,
	},
	"Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8": {
		contextWindow: 262_144,
		maxTokens: 16_384,
		reasoning: true,
	},
	"accounts/fireworks/models/llama-v3p1-8b-instruct": {
		contextWindow: 131_072,
		maxTokens: 8_192,
	},
	"accounts/fireworks/models/deepseek-r1": {
		contextWindow: 131_072,
		maxTokens: 16_384,
		reasoning: true,
	},
	"accounts/fireworks/models/qwen3-235b-a22b": {
		contextWindow: 131_072,
		maxTokens: 16_384,
		reasoning: true,
	},
	jamba: {
		contextWindow: 256_000,
		maxTokens: 8_192,
	},
	"jamba-1.6-large": {
		contextWindow: 256_000,
		maxTokens: 8_192,
	},
	"jamba-1.6-mini": {
		contextWindow: 256_000,
		maxTokens: 8_192,
	},
	"claude-3.5-sonnet": {
		contextWindow: 200_000,
		maxTokens: 8_192,
		imageInput: true,
	},
	"gpt-4.1": {
		contextWindow: 1_000_000,
		maxTokens: 32_768,
		imageInput: true,
	},
	sonar: {
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
	"sonar-pro": {
		contextWindow: 200_000,
		maxTokens: 8_192,
	},
	"sonar-reasoning": {
		contextWindow: 128_000,
		maxTokens: 8_192,
		reasoning: true,
	},
	"sonar-reasoning-pro": {
		contextWindow: 200_000,
		maxTokens: 16_384,
		reasoning: true,
	},
};

export function withModelMetadata(model: UnifyModelConfig): UnifyModelConfig {
	const metadata = MODEL_METADATA[model.id];
	if (!metadata) return model;
	return {
		...model,
		contextWindow: model.contextWindow ?? metadata.contextWindow,
		maxTokens: model.maxTokens ?? metadata.maxTokens,
		capabilities: {
			...(model.capabilities ?? {}),
			reasoning: model.capabilities?.reasoning ?? metadata.reasoning,
			imageInput: model.capabilities?.imageInput ?? metadata.imageInput,
		},
	};
}
