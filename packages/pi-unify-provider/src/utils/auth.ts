/**
 * Authentication Manager
 * Handles 7+ auth methods: API key, OAuth 2.0, PKCE, Device Code, Browser, Custom headers
 */

import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import type {
  AuthConfig,
  OAuth2AuthConfig,
  OAuth2PkceAuthConfig,
  ApiKeyAuthConfig,
} from "../config.js";

// Pi's auth.json path (for storing OAuth tokens)
const PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

// Credential storage
interface StoredCredentials {
  [providerName: string]: {
    type: "oauth" | "api_key";
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    apiKey?: string;
    createdAt: number;
  };
}

// OAuth state (in-memory)
interface OAuthState {
  providerName: string;
  codeVerifier?: string;
  state?: string;
  expiresAt: number;
}

const oauthStates = new Map<string, OAuthState>();

// ============================================================================
// Auth Manager
// ============================================================================

export class AuthManager {
  private credentials: StoredCredentials = {};
  private cache: Map<string, { token: string; expiresAt: number }> = new Map();

  constructor() {
    this.load();
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Get authorization headers for a provider
   */
  async getAuthHeaders(
    providerName: string,
    authConfig: AuthConfig,
    ctx?: { ui: { notify: (msg: string, level: "info" | "warning" | "error") => void } }
  ): Promise<Record<string, string>> {
    switch (authConfig.type) {
      case "api_key":
        return this.getApiKeyHeaders(providerName, authConfig);
      case "bearer_token":
        return this.getBearerTokenHeaders(providerName, authConfig);
      case "oauth2":
      case "oauth2_pkce":
        return this.getOAuthHeaders(providerName, authConfig, ctx);
      case "oauth_device_code":
        return this.getDeviceCodeHeaders(providerName, authConfig, ctx);
      case "browser_session":
        return this.getBrowserSessionHeaders(providerName, authConfig, ctx);
      case "custom_header":
        return this.getCustomHeaders(authConfig);
      case "query_param":
        return {}; // Auth is in URL, not headers
      case "none":
        return {};
      default:
        throw new Error(`Unknown auth type: ${(authConfig as AuthConfig).type}`);
    }
  }

  /**
   * Check if authentication is configured and valid
   */
  async isAuthenticated(providerName: string, authConfig: AuthConfig): Promise<boolean> {
    try {
      const headers = await this.getAuthHeaders(providerName, authConfig);
      return Object.keys(headers).length > 0 || authConfig.type === "none";
    } catch {
      return false;
    }
  }

  /**
   * Initiate OAuth login flow (returns auth URL or code)
   */
  async initiateOAuth(
    providerName: string,
    authConfig: Extract<AuthConfig, { type: "oauth2" | "oauth2_pkce" | "oauth_device_code" }>
  ): Promise<{ type: "url"; url: string; state: string } | { type: "device_code"; userCode: string; verificationUrl: string }> {
    switch (authConfig.type) {
      case "oauth2":
        return this.initiateOAuth2(providerName, authConfig);
      case "oauth2_pkce":
        return this.initiateOAuth2Pkce(providerName, authConfig);
      case "oauth_device_code":
        return this.initiateDeviceCode(providerName, authConfig);
      default:
        throw new Error("Invalid OAuth config");
    }
  }

  /**
   * Complete OAuth flow with authorization code
   */
  async completeOAuth(
    providerName: string,
    code: string,
    state: string,
    authConfig: OAuth2AuthConfig | OAuth2PkceAuthConfig
  ): Promise<{ success: boolean; error?: string }> {
    const storedState = oauthStates.get(state);
    if (!storedState || storedState.providerName !== providerName) {
      return { success: false, error: "Invalid or expired state parameter" };
    }

    oauthStates.delete(state);

    try {
      const tokenResponse = await this.exchangeCodeForToken(code, storedState.codeVerifier, authConfig);
      this.storeCredentials(providerName, {
        type: "oauth",
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token,
        expiresAt: tokenResponse.expires_in ? Date.now() + tokenResponse.expires_in * 1000 : undefined,
        createdAt: Date.now(),
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Store API key in Pi storage
   */
  setApiKey(providerName: string, apiKey: string): void {
    this.storeCredentials(providerName, {
      type: "api_key",
      apiKey,
      createdAt: Date.now(),
    });
  }

  /**
   * Clear credentials for a provider
   */
  clearCredentials(providerName: string): void {
    delete this.credentials[providerName];
    this.cache.delete(providerName);
    this.save();
  }

  // --------------------------------------------------------------------------
  // Auth Method Implementations
  // --------------------------------------------------------------------------

  private async getApiKeyHeaders(
    providerName: string,
    config: ApiKeyAuthConfig
  ): Promise<Record<string, string>> {
    // 1. Try env var first
    let apiKey = process.env[config.envVar];

    // 2. Fall back to stored credential
    if (!apiKey && config.allowStoredKey !== false) {
      const stored = this.credentials[providerName];
      if (stored?.type === "api_key") {
        apiKey = stored.apiKey;
      }
    }

    if (!apiKey) {
      throw new Error(
        `API key not found. Set ${config.envVar} environment variable or configure via /unify-add`
      );
    }

    const prefix = config.prefix ?? "Bearer ";
    const headerName = config.headerName ?? "Authorization";

    return {
      [headerName]: `${prefix}${apiKey}`,
    };
  }

  private async getBearerTokenHeaders(
    providerName: string,
    config: { type: "bearer_token"; envVar: string; allowStoredToken?: boolean }
  ): Promise<Record<string, string>> {
    let token = process.env[config.envVar];

    if (!token && config.allowStoredToken !== false) {
      const stored = this.credentials[providerName];
      if (stored?.type === "api_key") {
        token = stored.apiKey;
      }
    }

    if (!token) {
      throw new Error(`Bearer token not found. Set ${config.envVar} environment variable.`);
    }

    return { Authorization: `Bearer ${token}` };
  }

  private async getOAuthHeaders(
    providerName: string,
    config: OAuth2AuthConfig | OAuth2PkceAuthConfig,
    ctx?: { ui: { notify: (msg: string, level: "info" | "warning" | "error") => void } }
  ): Promise<Record<string, string>> {
    // Check cache first
    const cached = this.cache.get(providerName);
    if (cached && cached.expiresAt > Date.now() + 60 * 1000) {
      return { Authorization: `Bearer ${cached.token}` };
    }

    // Get stored credentials
    const creds = this.credentials[providerName];
    if (creds?.type !== "oauth" || !creds.accessToken) {
      throw new Error(
        `OAuth not configured for ${providerName}. Run /unify-add to authenticate.`
      );
    }

    // Check if token is expired and needs refresh
    if (creds.expiresAt && creds.expiresAt < Date.now() && creds.refreshToken) {
      try {
        const refreshed = await this.refreshOAuthToken(creds.refreshToken, config);
        this.storeCredentials(providerName, {
