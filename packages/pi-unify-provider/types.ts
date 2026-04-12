import type { ThinkingLevel as CoreThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, ThinkingLevel as AiThinkingLevel } from "@mariozechner/pi-ai";

export type ProviderType =
	| "custom"
	| "together"
	| "fireworks"
	| "ai21"
	| "perplexity"
	| "poe";

export type AuthMethod =
	| "none"
	| "api-key"
	| "bearer-token"
	| "oauth2"
	| "oauth2-pkce"
	| "oauth-device-code"
	| "browser-session"
	| "custom-header"
	| "query-param";

export type UnifiedThinkingLevel = Exclude<CoreThinkingLevel | AiThinkingLevel, "xhigh"> | "xhigh";

export interface NoneAuthConfig {
	method: "none";
}

export interface ApiKeyAuthConfig {
	method: "api-key";
	apiKey?: string;
}

export interface BearerTokenAuthConfig {
	method: "bearer-token";
	token?: string;
	headerName?: string;
}

export interface OAuth2TokenData {
	accessToken: string;
	refreshToken?: string;
	tokenType?: string;
	expiresAt?: number;
	scope?: string;
}

export interface OAuth2AuthConfig {
	method: "oauth2";
	tokenUrl: string;
	clientId: string;
	clientSecret?: string;
	scopes?: string[];
	token?: string;
}

export interface OAuth2PkceAuthConfig {
	method: "oauth2-pkce";
	authorizationUrl: string;
	tokenUrl: string;
	clientId: string;
	scopes?: string[];
	redirectUri?: string;
	token?: string;
}

export interface OAuthDeviceCodeAuthConfig {
	method: "oauth-device-code";
	deviceAuthorizationUrl: string;
	tokenUrl: string;
	clientId: string;
	scopes?: string[];
	token?: string;
}

export interface BrowserSessionAuthConfig {
	method: "browser-session";
	cookieHeader?: string;
}

export interface CustomHeaderAuthConfig {
	method: "custom-header";
	headerName: string;
	headerValue?: string;
}

export interface QueryParamAuthConfig {
	method: "query-param";
	paramName: string;
	paramValue?: string;
}

export type AuthConfig =
	| NoneAuthConfig
	| ApiKeyAuthConfig
	| BearerTokenAuthConfig
	| OAuth2AuthConfig
	| OAuth2PkceAuthConfig
	| OAuthDeviceCodeAuthConfig
	| BrowserSessionAuthConfig
	| CustomHeaderAuthConfig
	| QueryParamAuthConfig;

export interface ModelCostConfig {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface ModelCapabilities {
	toolCalling?: boolean | number;
	imageInput?: boolean;
	reasoning?: boolean;
}

export interface UnifyModelConfig {
	id: string;
	name?: string;
	family?: string;
	api?: Api;
	contextWindow?: number;
	maxTokens?: number;
	capabilities?: ModelCapabilities;
	cost?: ModelCostConfig;
}

export interface ProviderConfigRecord {
	type: ProviderType;
	name: string;
	baseUrl: string;
	api: Api;
	auth: AuthConfig;
	models: UnifyModelConfig[];
	extraHeaders?: Record<string, string>;
	extraQuery?: Record<string, string>;
	extraBody?: Record<string, unknown>;
	autoFetchOfficialModels?: boolean;
	updatedAt?: number;
}

export interface ExtensionDatabase {
	version: 2;
	providers: ProviderConfigRecord[];
}

export interface SecretsDatabase {
	version: 1;
	apiKeys: Record<string, string>;
	oauthTokens: Record<string, OAuth2TokenData>;
	generic: Record<string, string>;
}

export interface WellKnownProviderPreset {
	id: ProviderType;
	name: string;
	category: "Hosted APIs" | "Custom";
	description: string;
	baseUrl: string;
	api: Api;
	supportedAuth: AuthMethod[];
	defaultAuth: AuthMethod;
	officialModelsEndpoint?: string;
	hardcodedModels?: UnifyModelConfig[];
	extraHeaders?: Record<string, string>;
	extraQuery?: Record<string, string>;
	extraBody?: Record<string, unknown>;
}

export interface ResolvedAuth {
	headers?: Record<string, string>;
	query?: Record<string, string>;
	body?: Record<string, unknown>;
}

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8_192;

export function now(): number {
	return Date.now();
}
