import {
  createSecretRef,
  isSecretRef,
} from "../../secret-store.js";
import type {
  OAuth2AuthConfig,
  OAuth2PkceAuthConfig,
  OAuthDeviceCodeAuthConfig,
  AuthCredential,
  AuthConfig,
  OAuthTokenData,
} from "../../types.js";
import type {
  AuthConfigureResult,
  AuthProviderDefinition,
  AuthUi,
} from "../auth-provider.js";
import { BaseAuthProvider } from "../auth-provider.js";
import {
  buildAuthorizationUrl,
  exchangeCodeForToken,
  generatePkceVerifier,
  generateState,
  getClientCredentialsToken,
  pollDeviceCodeToken,
  refreshOAuthToken,
  revokeOAuthToken,
  startDeviceCodeFlow,
} from "./oauth-client.js";

type OAuthConfigUnion = OAuth2AuthConfig | OAuth2PkceAuthConfig | OAuthDeviceCodeAuthConfig;

interface RuntimeOAuthConfig {
  mode: "authorization_code" | "authorization_code_pkce" | "client_credentials" | "device_code";
  authorizationUrl?: string;
  deviceAuthorizationUrl?: string;
  tokenUrl: string;
  revocationUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  redirectUri?: string;
}

function parseStoredToken(value: string): OAuthTokenData | null {
  try {
    const parsed = JSON.parse(value) as OAuthTokenData;
    if (!parsed?.accessToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

export class OAuth2LikeAuthProvider extends BaseAuthProvider<OAuthConfigUnion> {
  get definition(): AuthProviderDefinition {
    const method = this.config?.method;
    if (method === "oauth2-pkce") {
      return { id: "oauth2-pkce", label: this.config.label ?? "OAuth2 PKCE" };
    }
    if (method === "oauth-device-code") {
      return { id: "oauth-device-code", label: this.config.label ?? "OAuth2 Device Code" };
    }
    return { id: "oauth2", label: this.config?.label ?? "OAuth2" };
  }

  getExpiryBufferMs(): number {
    return 5 * 60 * 1000;
  }

  async getSummaryDetail(): Promise<string | undefined> {
    const token = await this.resolveTokenData();
    if (!token) return "Not authorized";
    if (!token.expiresAt) return "Authorized";
    if (this.context.secretStore.isOAuthTokenExpired(token, 0)) return "Expired";
    const remainingMs = token.expiresAt - Date.now();
    if (remainingMs < 60_000) return `Expires in ${Math.ceil(remainingMs / 1000)}s`;
    if (remainingMs < 3_600_000) return `Expires in ${Math.ceil(remainingMs / 60_000)}m`;
    return `Expires in ${Math.ceil(remainingMs / 3_600_000)}h`;
  }

  async getCredential(): Promise<AuthCredential | undefined> {
    const token = await this.resolveTokenData();
    if (!token?.accessToken) return undefined;

    if (this.context.secretStore.isOAuthTokenExpired(token, this.getExpiryBufferMs())) {
      const ok = await this.refresh();
      if (!ok) {
        this.emit({ status: "expired" });
        return undefined;
      }
      const refreshed = await this.resolveTokenData();
      if (!refreshed?.accessToken) return undefined;
      return {
        value: refreshed.accessToken,
        tokenType: refreshed.tokenType,
        expiresAt: refreshed.expiresAt,
      };
    }

    return {
      value: token.accessToken,
      tokenType: token.tokenType,
      expiresAt: token.expiresAt,
    };
  }

  async isValid(): Promise<boolean> {
    const token = await this.resolveTokenData();
    if (!token?.accessToken) return false;
    if (!token.expiresAt) return true;

    if (!this.context.secretStore.isOAuthTokenExpired(token, 0)) {
      return true;
    }

    return this.canRefresh(token);
  }

  async configure(ui: AuthUi): Promise<AuthConfigureResult> {
    const runtime = await this.resolveOrPromptRuntimeConfig(ui);
    if (!runtime) return { success: false };

    try {
      const token = await this.authorize(runtime, ui);
      if (!token) {
        return { success: false, error: "Authorization cancelled" };
      }

      const tokenRef = this.config?.token && isSecretRef(this.config.token)
        ? this.config.token
        : createSecretRef();
      await this.context.secretStore.setOAuthToken(tokenRef, token);

      const next = await this.buildPersistedConfig(runtime, tokenRef);
      await this.persist(next);

      this.emit({ status: "valid" });
      return { success: true, config: next };
    } catch (error) {
      this.emit({ status: "error", error: error as Error });
      ui.notify(`OAuth configuration failed: ${error}`, "error");
      return { success: false, error: String(error) };
    }
  }

  async refresh(): Promise<boolean> {
    const runtime = await this.resolveRuntimeConfig();
    if (!runtime) return false;

    try {
      if (runtime.mode === "client_credentials") {
        if (!runtime.clientId || !runtime.clientSecret) return false;
        const token = await getClientCredentialsToken({
          tokenUrl: runtime.tokenUrl,
          clientId: runtime.clientId,
          clientSecret: runtime.clientSecret,
          scopes: runtime.scopes,
        });
        await this.storeTokenData(token);
        this.emit({ status: "valid" });
        return true;
      }

      const current = await this.resolveTokenData();
      if (!current?.refreshToken) return false;

      const token = await refreshOAuthToken({
        tokenUrl: runtime.tokenUrl,
        refreshToken: current.refreshToken,
        clientId: runtime.clientId,
        clientSecret: runtime.clientSecret,
      });

      if (!token.refreshToken) {
        token.refreshToken = current.refreshToken;
      }

      await this.storeTokenData(token);
      this.emit({ status: "valid" });
      return true;
    } catch (error) {
      this.emit({ status: "error", error: error as Error });
      return false;
    }
  }

  async revoke(): Promise<void> {
    const runtime = await this.resolveRuntimeConfig();
    const token = await this.resolveTokenData();

    if (runtime?.revocationUrl && token?.accessToken) {
      try {
        await revokeOAuthToken({
          revocationUrl: runtime.revocationUrl,
          token: token.accessToken,
          tokenTypeHint: "access_token",
          clientId: runtime.clientId,
          clientSecret: runtime.clientSecret,
        });
      } catch {
        // fail-fast enough for local revoke; still clear local secrets
      }

      if (token.refreshToken) {
        try {
          await revokeOAuthToken({
            revocationUrl: runtime.revocationUrl,
            token: token.refreshToken,
            tokenTypeHint: "refresh_token",
            clientId: runtime.clientId,
            clientSecret: runtime.clientSecret,
          });
        } catch {
          // ignore
        }
      }
    }

    await this.clearStoredToken();
    this.emit({ status: "revoked" });
  }

  private async resolveTokenData(): Promise<OAuthTokenData | null> {
    const raw = this.config?.token?.trim();
    if (!raw) return null;

    if (isSecretRef(raw)) {
      return (await this.context.secretStore.getOAuthToken(raw)) ?? null;
    }

    return parseStoredToken(raw);
  }

  private async storeTokenData(token: OAuthTokenData): Promise<void> {
    if (!this.config?.token) return;

    if (isSecretRef(this.config.token)) {
      await this.context.secretStore.setOAuthToken(this.config.token, token);
      return;
    }

    const ref = createSecretRef();
    await this.context.secretStore.setOAuthToken(ref, token);
    await this.persist({ ...this.config, token: ref } as OAuthConfigUnion);
  }

  private async clearStoredToken(): Promise<void> {
    const raw = this.config?.token?.trim();
    if (raw && isSecretRef(raw)) {
      await this.context.secretStore.deleteOAuthToken(raw);
    }

    if (!this.config) return;
    await this.persist({ ...this.config, token: undefined } as OAuthConfigUnion);
  }

  private canRefresh(token: OAuthTokenData): boolean {
    if (!this.config) return false;
    if (this.config.method === "oauth-device-code") {
      return false;
    }

    if (this.config.method === "oauth2") {
      return this.config.oauth.grantType === "client_credentials" || !!token.refreshToken;
    }

    return !!token.refreshToken;
  }

  private async resolveRuntimeConfig(): Promise<RuntimeOAuthConfig | undefined> {
    const config = this.config;
    if (!config) return undefined;

    if (config.method === "oauth2") {
      const grant = config.oauth.grantType;
      if (grant === "authorization_code") {
        return {
          mode: "authorization_code",
          authorizationUrl: config.oauth.authorizationUrl,
          tokenUrl: config.oauth.tokenUrl,
          revocationUrl: config.oauth.revocationUrl,
          clientId: config.oauth.clientId,
          clientSecret: await this.resolveClientSecret(config.oauth.clientSecret),
          scopes: config.oauth.scopes,
          redirectUri: config.oauth.redirectUri,
        };
      }

      if (grant === "client_credentials") {
        return {
          mode: "client_credentials",
          tokenUrl: config.oauth.tokenUrl,
          revocationUrl: config.oauth.revocationUrl,
          clientId: config.oauth.clientId,
          clientSecret: await this.resolveClientSecret(config.oauth.clientSecret),
          scopes: config.oauth.scopes,
        };
      }

      return {
        mode: "device_code",
        deviceAuthorizationUrl: config.oauth.authorizationUrl,
        tokenUrl: config.oauth.tokenUrl,
        revocationUrl: config.oauth.revocationUrl,
        clientId: config.oauth.clientId,
        scopes: config.oauth.scopes,
      };
    }

    if (config.method === "oauth2-pkce") {
      return {
        mode: "authorization_code_pkce",
        authorizationUrl: config.oauth.authorizationUrl,
        tokenUrl: config.oauth.tokenUrl,
        revocationUrl: config.oauth.revocationUrl,
        clientId: config.oauth.clientId,
        scopes: config.oauth.scopes,
        redirectUri: config.oauth.redirectUri,
      };
    }

    return {
      mode: "device_code",
      deviceAuthorizationUrl: config.oauth.deviceAuthorizationUrl,
      tokenUrl: config.oauth.tokenUrl,
      revocationUrl: config.oauth.revocationUrl,
      clientId: config.oauth.clientId,
      scopes: config.oauth.scopes,
    };
  }

  private async resolveClientSecret(raw?: string): Promise<string | undefined> {
    if (!raw) return undefined;
    if (!isSecretRef(raw)) return raw;
    return this.context.secretStore.getOAuthClientSecret(raw);
  }

  private async resolveOrPromptRuntimeConfig(ui: AuthUi): Promise<RuntimeOAuthConfig | undefined> {
    const existing = await this.resolveRuntimeConfig();
    if (existing) {
      return existing;
    }

    if (!this.config) {
      return undefined;
    }

    if (this.config.method === "oauth2") {
      const grant = await ui.select("OAuth2 Grant Type", [
        "authorization_code",
        "client_credentials",
        "device_code",
      ]);
      if (!grant) return undefined;

      if (grant === "authorization_code") {
        const authorizationUrl = await ui.input("Authorization URL", "https://example.com/oauth/authorize");
        const tokenUrl = await ui.input("Token URL", "https://example.com/oauth/token");
        const clientId = await ui.input("Client ID", "client-id");
        if (!authorizationUrl || !tokenUrl) return undefined;

        const redirectUri = await ui.input("Redirect URI", "http://localhost/callback");
        const scopes = await ui.input("Scopes (space separated)", "openid profile email");
        const clientSecretInput = await ui.input("Client Secret (optional)", "secret");

        return {
          mode: "authorization_code",
          authorizationUrl: authorizationUrl.trim(),
          tokenUrl: tokenUrl.trim(),
          clientId: clientId?.trim() || undefined,
          clientSecret: clientSecretInput?.trim() || undefined,
          redirectUri: redirectUri?.trim() || "http://localhost/callback",
          scopes: scopes?.trim() ? scopes.trim().split(/\s+/) : undefined,
        };
      }

      if (grant === "client_credentials") {
        const tokenUrl = await ui.input("Token URL", "https://example.com/oauth/token");
        const clientId = await ui.input("Client ID", "client-id");
        const clientSecret = await ui.input("Client Secret", "secret");
        const scopes = await ui.input("Scopes (space separated)", "");
        if (!tokenUrl || !clientId || !clientSecret) return undefined;

        return {
          mode: "client_credentials",
          tokenUrl: tokenUrl.trim(),
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          scopes: scopes?.trim() ? scopes.trim().split(/\s+/) : undefined,
        };
      }

      const deviceAuthorizationUrl = await ui.input("Device Authorization URL", "https://example.com/oauth/device/code");
      const tokenUrl = await ui.input("Token URL", "https://example.com/oauth/token");
      const clientId = await ui.input("Client ID", "client-id");
      const scopes = await ui.input("Scopes (space separated)", "");
      if (!deviceAuthorizationUrl || !tokenUrl || !clientId) return undefined;

      return {
        mode: "device_code",
        deviceAuthorizationUrl: deviceAuthorizationUrl.trim(),
        tokenUrl: tokenUrl.trim(),
        clientId: clientId.trim(),
        scopes: scopes?.trim() ? scopes.trim().split(/\s+/) : undefined,
      };
    }

    if (this.config.method === "oauth2-pkce") {
      const authorizationUrl = await ui.input("Authorization URL", "https://example.com/oauth/authorize");
      const tokenUrl = await ui.input("Token URL", "https://example.com/oauth/token");
      const clientId = await ui.input("Client ID", "client-id");
      const redirectUri = await ui.input("Redirect URI", "http://localhost/callback");
      const scopes = await ui.input("Scopes (space separated)", "openid profile email");
      if (!authorizationUrl || !tokenUrl || !clientId) return undefined;

      return {
        mode: "authorization_code_pkce",
        authorizationUrl: authorizationUrl.trim(),
        tokenUrl: tokenUrl.trim(),
        clientId: clientId.trim(),
        redirectUri: redirectUri?.trim() || "http://localhost/callback",
        scopes: scopes?.trim() ? scopes.trim().split(/\s+/) : undefined,
      };
    }

    const deviceAuthorizationUrl = await ui.input("Device Authorization URL", "https://example.com/oauth/device/code");
    const tokenUrl = await ui.input("Token URL", "https://example.com/oauth/token");
    const clientId = await ui.input("Client ID", "client-id");
    const scopes = await ui.input("Scopes (space separated)", "");
    if (!deviceAuthorizationUrl || !tokenUrl || !clientId) return undefined;

    return {
      mode: "device_code",
      deviceAuthorizationUrl: deviceAuthorizationUrl.trim(),
      tokenUrl: tokenUrl.trim(),
      clientId: clientId.trim(),
      scopes: scopes?.trim() ? scopes.trim().split(/\s+/) : undefined,
    };
  }

  private async authorize(runtime: RuntimeOAuthConfig, ui: AuthUi): Promise<OAuthTokenData | undefined> {
    if (runtime.mode === "client_credentials") {
      if (!runtime.clientId || !runtime.clientSecret) {
        throw new Error("Client credentials require clientId and clientSecret");
      }

      return getClientCredentialsToken({
        tokenUrl: runtime.tokenUrl,
        clientId: runtime.clientId,
        clientSecret: runtime.clientSecret,
        scopes: runtime.scopes,
      });
    }

    if (runtime.mode === "device_code") {
      if (!runtime.deviceAuthorizationUrl || !runtime.clientId) {
        throw new Error("Device code requires deviceAuthorizationUrl and clientId");
      }

      const flow = await startDeviceCodeFlow({
        deviceAuthorizationUrl: runtime.deviceAuthorizationUrl,
        tokenUrl: runtime.tokenUrl,
        clientId: runtime.clientId,
        scopes: runtime.scopes,
      });

      const loginUrl = flow.verificationUriComplete || flow.verificationUri;
      ui.notify(`Open ${loginUrl} and enter code ${flow.userCode}`, "info");

      const start = Date.now();
      while (Date.now() - start < flow.expiresIn * 1000) {
        const token = await pollDeviceCodeToken({
          config: {
            deviceAuthorizationUrl: runtime.deviceAuthorizationUrl,
            tokenUrl: runtime.tokenUrl,
            clientId: runtime.clientId,
            scopes: runtime.scopes,
          },
          deviceCode: flow.deviceCode,
        });

        if (token) {
          return token;
        }

        await new Promise((resolve) => setTimeout(resolve, flow.interval * 1000));
      }

      throw new Error("Device authorization timed out");
    }

    if (!runtime.authorizationUrl || !runtime.redirectUri) {
      throw new Error("Authorization code flow requires authorizationUrl and redirectUri");
    }

    const usePkce = runtime.mode === "authorization_code_pkce";
    const state = generateState();
    const pkce = usePkce ? generatePkceVerifier() : undefined;

    const authUrl = buildAuthorizationUrl({
      config: {
        authorizationUrl: runtime.authorizationUrl,
        tokenUrl: runtime.tokenUrl,
        clientId: runtime.clientId,
        clientSecret: runtime.clientSecret,
        redirectUri: runtime.redirectUri,
        scopes: runtime.scopes,
      },
      state,
      codeChallenge: pkce?.challenge,
      codeChallengeMethod: pkce?.method,
    });

    ui.notify(`Open this URL and authorize: ${authUrl}`, "info");
    const code = await ui.input("Authorization Code", "paste code");
    if (!code?.trim()) {
      return undefined;
    }

    return exchangeCodeForToken({
      config: {
        authorizationUrl: runtime.authorizationUrl,
        tokenUrl: runtime.tokenUrl,
        clientId: runtime.clientId,
        clientSecret: runtime.clientSecret,
        redirectUri: runtime.redirectUri,
        scopes: runtime.scopes,
      },
      code: code.trim(),
      codeVerifier: pkce?.verifier,
    });
  }

  private async buildPersistedConfig(runtime: RuntimeOAuthConfig, tokenRef: string): Promise<OAuthConfigUnion> {
    if (!this.config) {
      throw new Error("Missing auth config");
    }

    const toSecretRef = async (raw?: string): Promise<string | undefined> => {
      if (!raw) return undefined;
      if (isSecretRef(raw)) return raw;
      const ref = createSecretRef();
      await this.context.secretStore.setOAuthClientSecret(ref, raw);
      return ref;
    };

    if (this.config.method === "oauth2") {
      const grantType = runtime.mode === "client_credentials"
        ? "client_credentials"
        : runtime.mode === "device_code"
          ? "device_code"
          : "authorization_code";

      const authorizationUrl = runtime.mode === "device_code"
        ? runtime.deviceAuthorizationUrl
        : runtime.authorizationUrl;

      return {
        ...this.config,
        token: tokenRef,
        oauth: {
          grantType,
          authorizationUrl,
          tokenUrl: runtime.tokenUrl,
          revocationUrl: runtime.revocationUrl,
          clientId: runtime.clientId,
          clientSecret: await toSecretRef(runtime.clientSecret),
          redirectUri: runtime.redirectUri,
          scopes: runtime.scopes,
        },
      } satisfies AuthConfig as OAuth2AuthConfig;
    }

    if (this.config.method === "oauth2-pkce") {
      return {
        ...this.config,
        token: tokenRef,
        oauth: {
          authorizationUrl: runtime.authorizationUrl || this.config.oauth.authorizationUrl,
          tokenUrl: runtime.tokenUrl,
          revocationUrl: runtime.revocationUrl,
          clientId: runtime.clientId || this.config.oauth.clientId,
          redirectUri: runtime.redirectUri,
          scopes: runtime.scopes,
          codeChallengeMethod: this.config.oauth.codeChallengeMethod ?? "S256",
        },
      };
    }

    return {
      ...this.config,
      token: tokenRef,
      oauth: {
        deviceAuthorizationUrl: runtime.deviceAuthorizationUrl || this.config.oauth.deviceAuthorizationUrl,
        tokenUrl: runtime.tokenUrl,
        revocationUrl: runtime.revocationUrl,
        clientId: runtime.clientId || this.config.oauth.clientId,
        scopes: runtime.scopes,
      },
    };
  }
}
