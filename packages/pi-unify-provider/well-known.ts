import type { WellKnownProviderPreset } from "./types.ts";

export const ALL_AUTH_METHODS: WellKnownProviderPreset["supportedAuth"] = [
	"none",
	"api-key",
	"bearer-token",
	"oauth2",
	"oauth2-pkce",
	"oauth-device-code",
	"browser-session",
	"custom-header",
	"query-param",
];

export const WELL_KNOWN_PROVIDERS: WellKnownProviderPreset[] = [
	{
		id: "custom",
		name: "Custom",
		category: "Custom",
		description: "Bring your own OpenAI-compatible provider",
		baseUrl: "https://api.example.com/v1",
		api: "openai-completions",
		supportedAuth: ALL_AUTH_METHODS,
		defaultAuth: "api-key",
		officialModelsEndpoint: "/models",
	},
	{
		id: "together",
		name: "Together AI",
		category: "Hosted APIs",
		description: "OpenAI-compatible API for open models",
		baseUrl: "https://api.together.xyz/v1",
		api: "openai-completions",
		supportedAuth: ALL_AUTH_METHODS,
		defaultAuth: "api-key",
		officialModelsEndpoint: "/models",
	},
	{
		id: "fireworks",
		name: "Fireworks AI",
		category: "Hosted APIs",
		description: "OpenAI-compatible inference API",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		api: "openai-completions",
		supportedAuth: ALL_AUTH_METHODS,
		defaultAuth: "api-key",
		officialModelsEndpoint: "/models",
	},
	{
		id: "ai21",
		name: "AI21",
		category: "Hosted APIs",
		description: "AI21 studio OpenAI-compatible endpoint",
		baseUrl: "https://api.ai21.com/studio/v1",
		api: "openai-completions",
		supportedAuth: ALL_AUTH_METHODS,
		defaultAuth: "api-key",
		officialModelsEndpoint: "/models",
	},
	{
		id: "poe",
		name: "Poe",
		category: "Hosted APIs",
		description: "Poe API (OpenAI-compatible)",
		baseUrl: "https://api.poe.com/v1",
		api: "openai-completions",
		supportedAuth: ALL_AUTH_METHODS,
		defaultAuth: "api-key",
		officialModelsEndpoint: "/models",
	},
	{
		id: "perplexity",
		name: "Perplexity",
		category: "Hosted APIs",
		description: "Perplexity API with curated model list",
		baseUrl: "https://api.perplexity.ai",
		api: "openai-completions",
		supportedAuth: ALL_AUTH_METHODS,
		defaultAuth: "api-key",
		officialModelsEndpoint: "/models",
		hardcodedModels: [
			{ id: "sonar" },
			{ id: "sonar-pro" },
			{ id: "sonar-reasoning" },
			{ id: "sonar-reasoning-pro" },
		],
	},
];

export function getProviderPreset(id: string): WellKnownProviderPreset | undefined {
	return WELL_KNOWN_PROVIDERS.find((provider) => provider.id === id);
}
