import type { ProviderConfig, AuthConfig, ProviderAuthHeadersResult } from "../types.js";
import type { SecretStore } from "../secret-store.js";
import { createAuthProvider } from "./definitions.js";
import type { AuthProvider, AuthUi } from "./auth-provider.js";
import { CustomHeaderAuthProvider } from "./providers/custom-header.js";
import { QueryParamAuthProvider } from "./providers/query-param.js";

function cacheKey(providerName: string, method: string): string {
  return `${providerName}:${method}`;
}

export class AuthManager {
  private providers = new Map<string, AuthProvider>();

  constructor(private readonly secretStore: SecretStore) {}

  clear(providerName?: string): void {
    if (!providerName) {
      for (const provider of this.providers.values()) {
        provider.dispose?.();
      }
      this.providers.clear();
      return;
    }

    for (const [key, provider] of this.providers.entries()) {
      if (!key.startsWith(`${providerName}:`)) continue;
      provider.dispose?.();
      this.providers.delete(key);
    }
  }

  getProvider(providerName: string, auth: AuthConfig): AuthProvider {
    const key = cacheKey(providerName, auth.method);
    const existing = this.providers.get(key);
    if (existing) return existing;

    const provider = createAuthProvider(
      {
        providerId: providerName,
        providerLabel: providerName,
        secretStore: this.secretStore,
      },
      auth,
    );

    this.providers.set(key, provider);
    return provider;
  }

  async configureAuth(
    providerName: string,
    auth: AuthConfig,
    ui: AuthUi,
    persistAuthConfig: (auth: AuthConfig) => Promise<void>,
  ): Promise<{ success: boolean; config?: AuthConfig; error?: string }> {
    const key = cacheKey(providerName, auth.method);

    const provider = createAuthProvider(
      {
        providerId: providerName,
        providerLabel: providerName,
        secretStore: this.secretStore,
        persistAuthConfig,
      },
      auth,
    );

    this.providers.set(key, provider);
    return provider.configure(ui);
  }

  async resolveAuth(
    provider: ProviderConfig,
    defaultHeaders?: Record<string, string>,
  ): Promise<ProviderAuthHeadersResult> {
    const auth = provider.auth;
    if (!auth || auth.method === "none") {
      return { headers: { ...(defaultHeaders ?? {}) } };
    }

    const authProvider = this.getProvider(provider.name, auth);
    const credential = await authProvider.getCredential();
    const headers: Record<string, string> = { ...(defaultHeaders ?? {}) };
    const query: Record<string, string> = {};

    switch (auth.method) {
      case "api-key": {
        if (!credential?.value) break;
        const headerName = auth.headerName?.trim() || "Authorization";
        const prefix = auth.prefix ?? (headerName.toLowerCase() === "authorization" ? "Bearer " : "");
        headers[headerName] = `${prefix}${credential.value}`;
        break;
      }
      case "bearer-token": {
        if (!credential?.value) break;
        headers[auth.headerName?.trim() || "Authorization"] = `Bearer ${credential.value}`;
        break;
      }
      case "oauth2":
      case "oauth2-pkce":
      case "oauth-device-code": {
        if (!credential?.value) break;
        headers["Authorization"] = `${credential.tokenType || "Bearer"} ${credential.value}`;
        break;
      }
      case "browser-session": {
        if (!credential?.value) break;
        headers["Cookie"] = credential.value;
        break;
      }
      case "custom-header": {
        if (authProvider instanceof CustomHeaderAuthProvider) {
          Object.assign(headers, await authProvider.resolveHeaders());
        }
        break;
      }
      case "query-param": {
        if (!credential?.value) break;
        const paramName = auth.paramName?.trim();
        if (paramName) {
          query[paramName] = credential.value;
        }
        break;
      }
      default:
        break;
    }

    return { headers, query: Object.keys(query).length ? query : undefined };
  }
}
