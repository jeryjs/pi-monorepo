/**
 * Configuration persistence layer for Unify Provider
 * Manages provider configs, models, and database file I/O
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// Database file location
const DB_PATH = join(homedir(), ".pi", "agent", "unify-providers-db.json");

// ============================================================================
// Types
// ============================================================================

export interface ModelCapabilities {
  textInput?: boolean;
  imageInput?: boolean;
  toolCalling?: boolean | number;
  reasoning?: boolean;
  editTools?: string;
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

export interface UnifyModelConfig {
  id: string;
  name?: string;
  family?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: ModelCapabilities;
  cost?: ModelCost;
  tokenizer?: string;
 temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stream?: boolean;
  compat?: ModelCompat;
  // Preset templates for model variants
  presets?: Record<string, Partial<UnifyModelConfig>>;
  // For auto-fetched models
  source?: "builtin" | "fetched" | "manual";
  fetchedAt?: number;
}

/**
 * Authentication configuration - supports 7+ auth methods
 * Inspired by vscode-unify-chat-provider auth system
 */

// Auth method types
export type AuthMethodType =
  | "api_key"           // Standard API key in header
  | "bearer_token"      // Bearer token (different format)
  | "oauth2"           // OAuth 2.0 authorization code
  | "oauth2_pkce"      // OAuth 2.0 with PKCE
  | "oauth_device_code" // Device code flow (for CLI)
  | "custom_header"    // Custom header authentication
  | "query_param"      // API key in query parameter
  | "browser_session"  // Browser-based OAuth (like Claude Code)
  | "none";            // No authentication

// Base auth config
export interface BaseAuthConfig {
  type: AuthMethodType;
}

// API Key auth
export interface ApiKeyAuthConfig extends BaseAuthConfig {
  type: "api_key";
  /** Environment variable name for the API key (e.g., "POE_API_KEY") */
  envVar: string;
  /** If true, store key in Pi's auth.json; if false, requires env var */
  allowStoredKey?: boolean;
  /** Custom header name (default: "Authorization") */
  headerName?: string;
  /** Key prefix (default: "Bearer ") */
  prefix?: string;
  /** Store key in Pi secret storage? */
  useSecretStorage?: boolean;
}

// Bearer token auth
export interface BearerTokenAuthConfig extends BaseAuthConfig {
  type: "bearer_token";
  envVar: string;
  allowStoredToken?: boolean;
  useSecretStorage?: boolean;
}

// OAuth 2.0 standard flow
export interface OAuth2AuthConfig extends BaseAuthConfig {
  type: "oauth2";
  /** Display name for OAuth provider */
  displayName: string;
  /** Authorization endpoint URL */
  authUrl: string;
  /** Token endpoint URL */
  tokenUrl: string;
  /** Client ID (may be empty for some providers) */
  clientId?: string;
  /** OAuth scopes to request */
  scopes: string[];
  /** Additional parameters for auth URL */
  extraAuthParams?: Record<string, string>;
  /** Use PKCE? */
  usePkce?: boolean;
  /** For headless/device flows */
  deviceCodeUrl?: string;
}

// OAuth 2.0 PKCE flow
export interface OAuth2PkceAuthConfig extends BaseAuthConfig {
  type: "oauth2_pkce";
  displayName: string;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  /** Code challenge method (default: "S256") */
  codeChallengeMethod?: "S256" | "plain";
}

// Device code flow (for CLI-only providers)
export interface OAuthDeviceCodeAuthConfig extends BaseAuthConfig {
  type: "oauth_device_code";
  displayName: string;
  /** Device code endpoint */
  deviceCodeUrl: string;
  /** Token endpoint (polling) */
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  /** Polling interval in seconds */
  interval?: number;
}

// Browser session OAuth (like Claude Code's approach)
export interface BrowserSessionAuthConfig extends BaseAuthConfig {
  type: "browser_session";
  displayName: string;
  /** URL to open in browser for auth */
  loginUrl: string;
  /** Callback URL or method to receive token */
  callbackUrl?: string;
  /** Use custom URI handler? */
  useUriHandler?: boolean;
}

// Custom header auth
export interface CustomHeaderAuthConfig extends BaseAuthConfig {
  type: "custom_header";
  headers: Record<string, string>;
  /** Whether values are env var names or literal values */
  valueSource?: "env" | "literal" | "mixed";
}

// Query parameter auth
export interface QueryParamAuthConfig extends BaseAuthConfig {
  type: "query_param";
  /** Parameter name (default: "api_key") */
  paramName: string;
  /** Env var containing the key */
  envVar: string;
}

// No auth
export interface NoAuthConfig extends BaseAuthConfig {
  type: "none";
}

// Union type for all auth configs
export type AuthConfig =
  | ApiKeyAuthConfig
  | BearerTokenAuthConfig
  | OAuth2AuthConfig
  | OAuth2PkceAuthConfig
  | OAuthDeviceCodeAuthConfig
  | BrowserSessionAuthConfig
  | CustomHeaderAuthConfig
  | QueryParamAuthConfig
  | NoAuthConfig;

// Helper to check if auth requires OAuth flow
export function isOAuthAuth(auth: AuthConfig): boolean {
  return [
    "oauth2",
    "oauth2_pkce",
    "oauth_device_code",
    "browser_session",
  ].includes(auth.type);
}

// Helper to check if auth requires API key
export function isApiKeyAuth(auth: AuthConfig): boolean {
  return auth.type === "api_key" || auth.type === "bearer_token" || auth.type === "query_param";
}

// Helper to get env var requirement
export function getRequiredEnvVars(auth: AuthConfig): string[] {
  switch (auth.type) {
    case "api_key":
      return [auth.envVar];
    case "bearer_token":
      return [auth.envVar];
    case "query_param":
      return [auth.envVar];
    case "custom_header":
      // Extract env vars from header values that start with env: prefix
      return Object.values(auth.headers)
        .filter(v => v.startsWith("env:"))
        .map(v => v.slice(4));
    default:
      return [];
  }
}

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterFactor: number;
}

export interface TimeoutConfig {
  connection: number;
  response: number;
}

export interface UnifyProviderConfig {
  name: string;
  type: ProviderType;
  baseUrl: string;
  auth?: AuthConfig;
  models: UnifyModelConfig[];
  // Auto-fetch settings
  autoFetchOfficialModels: boolean;
  fetchIntervalMs?: number;
  lastFetchTime?: number;
  lastFetchError?: string;
  // Extra configuration
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  timeout?: TimeoutConfig;
  retry?: RetryConfig;
  // Metadata
  createdAt: number;
  updatedAt: number;
}

export type ProviderType = 
  | "poe"
  | "together"
  | "fireworks"
  | "perplexity"
  | "ai21";

export interface UnifyDatabase {
  version: number;
  providers: Record<string, UnifyProviderConfig>; // key is provider name
}

// ============================================================================
// Config Store
// ============================================================================

type ChangeListener = () => void;

export class ConfigStore {
  private data: UnifyDatabase;
  private listeners: ChangeListener[] = [];

  constructor() {
    this.data = this.load();
  }

  /**
   * Get a specific provider by name
   */
  getProvider(name: string): UnifyProviderConfig | undefined {
    return this.data.providers[name];
  }

  /**
   * Get all providers as array
   */
  getAllProviders(): UnifyProviderConfig[] {
    return Object.values(this.data.providers);
  }

  /**
   * Get provider names
   */
  getProviderNames(): string[] {
    return Object.keys(this.data.providers);
  }

  /**
   * Add or update a provider
   */
  setProvider(config: UnifyProviderConfig): void {
    const existing = this.data.providers[config.name];
    this.data.providers[config.name] = {
      ...config,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this.save();
    this.notifyChange();
  }

  /**
   * Delete a provider
   */
  deleteProvider(name: string): boolean {
    if (this.data.providers[name]) {
      delete this.data.providers[name];
      this.save();
      this.notifyChange();
      return true;
    }
    return false;
  }

  /**
   * Update partial config for a provider
   */
  updateProvider(name: string, updates: Partial<UnifyProviderConfig>): boolean {
    const provider = this.data.providers[name];
    if (!provider) return false;

    this.data.providers[name] = {
      ...provider,
      ...updates,
      updatedAt: Date.now(),
    };
    this.save();
    this.notifyChange();
    return true;
  }

  /**
   * Update models for a provider (used by fetcher)
   */
  setProviderModels(name: string, models: UnifyModelConfig[]): boolean {
    const provider = this.data.providers[name];
    if (!provider) return false;

    // Merge with existing manual models (source === "manual")
    const manualModels = provider.models.filter(m => m.source === "manual" || !m.source);
    const mergedModels = [...manualModels, ...models];

    // Deduplicate by ID
    const seen = new Set<string>();
    provider.models = mergedModels.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    provider.lastFetchTime = Date.now();
    provider.updatedAt = Date.now();

    this.save();
    this.notifyChange();
    return true;
  }

  /**
   * Subscribe to changes
   */
  onDidChange(listener: ChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) this.listeners.splice(index, 1);
    };
  }

  /**
   * Import from JSON string
   */
  importFromJson(json: string): { success: boolean; error?: string; count: number } {
    try {
      const parsed = JSON.parse(json);
      if (!parsed.providers || typeof parsed.providers !== "object") {
        return { success: false, error: "Invalid format: missing providers object", count: 0 };
      }

      let count = 0;
      for (const [name, config] of Object.entries(parsed.providers)) {
        this.setProvider(config as UnifyProviderConfig);
        count++;
      }

      return { success: true, count };
    } catch (error) {
      return { success: false, error: String(error), count: 0 };
    }
  }

  /**
   * Export to JSON string
   */
  exportToJson(): string {
    return JSON.stringify(this.data, null, 2);
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private load(): UnifyDatabase {
    if (!existsSync(DB_PATH)) {
      return { version: 1, providers: {} };
    }

    try {
      const content = readFileSync(DB_PATH, "utf-8");
      const data = JSON.parse(content) as UnifyDatabase;
      return {
        version: data.version || 1,
        providers: data.providers || {},
      };
    } catch (error) {
      console.error("[UnifyProvider] Failed to load database:", error);
      return { version: 1, providers: {} };
    }
  }

  private save(): void {
    try {
      const dir = dirname(DB_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(DB_PATH, JSON.stringify(this.data, null, 2), "utf-8");
    } catch (error) {
      console.error("[UnifyProvider] Failed to save database:", error);
    }
  }
}
