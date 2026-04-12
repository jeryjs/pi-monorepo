import type { Api } from "@mariozechner/pi-ai";

export type ProviderType =
  | "custom"
  | "poe"
  | "together"
  | "fireworks"
  | "perplexity"
  | "ai21";

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

export interface NoAuthConfig {
  method: "none";
}

export interface ApiKeyAuthConfig {
  method: "api-key";
  label?: string;
  description?: string;
  /** API key value or secret reference like $UPSECRET:{uuid}$ */
  apiKey?: string;
  headerName?: string;
  prefix?: string;
}

export interface BearerTokenAuthConfig {
  method: "bearer-token";
  label?: string;
  description?: string;
  /** bearer token value or secret reference */
  token?: string;
  headerName?: string;
}

export interface OAuth2AuthConfig {
  method: "oauth2";
  label?: string;
  description?: string;
  identityId?: string;
  token?: string;
  oauth: {
    grantType: "authorization_code" | "client_credentials" | "device_code";
    authorizationUrl?: string;
    tokenUrl: string;
    revocationUrl?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    scopes?: string[];
  };
}

export interface OAuth2PkceAuthConfig {
  method: "oauth2-pkce";
  label?: string;
  description?: string;
  identityId?: string;
  token?: string;
  oauth: {
    authorizationUrl: string;
    tokenUrl: string;
    revocationUrl?: string;
    clientId: string;
    redirectUri?: string;
    scopes?: string[];
    codeChallengeMethod?: "S256" | "plain";
  };
}

export interface OAuthDeviceCodeAuthConfig {
  method: "oauth-device-code";
  label?: string;
  description?: string;
  identityId?: string;
  token?: string;
  oauth: {
    deviceAuthorizationUrl: string;
    tokenUrl: string;
    revocationUrl?: string;
    clientId: string;
    scopes?: string[];
  };
}

export interface BrowserSessionAuthConfig {
  method: "browser-session";
  label?: string;
  description?: string;
  /** cookie/token value or secret reference */
  sessionToken?: string;
  loginUrl?: string;
}

export interface CustomHeaderAuthConfig {
  method: "custom-header";
  label?: string;
  description?: string;
  /** header values can be plain values or secret refs */
  headers: Record<string, string>;
}

export interface QueryParamAuthConfig {
  method: "query-param";
  label?: string;
  description?: string;
  paramName: string;
  /** key value or secret reference */
  value?: string;
}

export type AuthConfig =
  | NoAuthConfig
  | ApiKeyAuthConfig
  | BearerTokenAuthConfig
  | OAuth2AuthConfig
  | OAuth2PkceAuthConfig
  | OAuthDeviceCodeAuthConfig
  | BrowserSessionAuthConfig
  | CustomHeaderAuthConfig
  | QueryParamAuthConfig;

export interface AuthCredential {
  value: string;
  tokenType?: string;
  expiresAt?: number;
}

export interface OAuthTokenData {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

export interface RetryConfig {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  jitterFactor?: number;
}

export interface TimeoutConfig {
  connection?: number;
  response?: number;
}

export interface ModelCapabilities {
  toolCalling?: boolean | number;
  imageInput?: boolean;
  reasoning?: boolean;
  editTools?: "find-replace" | "multi-find-replace" | "apply-patch" | "code-rewrite";
}

export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelCompat {
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  requiresThinkingAsText?: boolean;
  thinkingFormat?: "openai" | "zai" | "qwen" | "qwen-chat-template";
  supportsUsageInStreaming?: boolean;
  maxTokensField?: string;
  reasoningEffortMap?: Record<string, string>;
}

export interface ModelConfig {
  id: string;
  name?: string;
  family?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  contextWindow?: number;
  capabilities?: ModelCapabilities;
  cost?: ModelCost;
  stream?: boolean;
  tokenizer?: string;
  tokenCountMultiplier?: number;
  temperature?: number;
  topK?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  parallelToolCalling?: boolean;
  serviceTier?: "auto" | "standard" | "flex" | "scale" | "priority";
  verbosity?: "low" | "medium" | "high";
  compat?: ModelCompat;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  source?: "manual" | "fetched" | "builtin";
  fetchedAt?: number;
}

export interface ProviderConfig {
  type: ProviderType;
  name: string;
  baseUrl: string;
  api: Api;
  auth?: AuthConfig;
  models: ModelConfig[];
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  timeout?: TimeoutConfig;
  retry?: RetryConfig;
  autoFetchOfficialModels?: boolean;
  lastFetchTime?: number;
  lastFetchError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProvidersDatabase {
  version: 2;
  providers: Record<string, ProviderConfig>;
}

export interface ProviderAuthHeadersResult {
  headers: Record<string, string>;
  query?: Record<string, string>;
}
