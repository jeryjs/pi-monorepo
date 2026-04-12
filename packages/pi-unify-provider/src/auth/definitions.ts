import type { AuthConfig, AuthMethod } from "../types.js";
import type { AuthProvider, AuthProviderContext } from "./auth-provider.js";
import { NoneAuthProvider } from "./providers/none.js";
import { ApiKeyAuthProvider } from "./providers/api-key.js";
import { BearerTokenAuthProvider } from "./providers/bearer-token.js";
import { OAuth2LikeAuthProvider } from "./providers/oauth2.js";
import { BrowserSessionAuthProvider } from "./providers/browser-session.js";
import { CustomHeaderAuthProvider } from "./providers/custom-header.js";
import { QueryParamAuthProvider } from "./providers/query-param.js";

export interface AuthMethodDefinition {
  id: AuthMethod;
  label: string;
  description?: string;
  category: "General" | "OAuth" | "Advanced";
  ctor: new (context: AuthProviderContext, config?: any) => AuthProvider;
}

export const AUTH_METHODS: Record<AuthMethod, AuthMethodDefinition> = {
  "none": {
    id: "none",
    label: "None",
    description: "No authentication",
    category: "General",
    ctor: NoneAuthProvider,
  },
  "api-key": {
    id: "api-key",
    label: "API Key",
    description: "Authenticate with API key",
    category: "General",
    ctor: ApiKeyAuthProvider,
  },
  "bearer-token": {
    id: "bearer-token",
    label: "Bearer Token",
    description: "Authenticate with bearer token",
    category: "General",
    ctor: BearerTokenAuthProvider,
  },
  "oauth2": {
    id: "oauth2",
    label: "OAuth 2.0",
    description: "OAuth2 authorization code / client credentials / device code",
    category: "OAuth",
    ctor: OAuth2LikeAuthProvider,
  },
  "oauth2-pkce": {
    id: "oauth2-pkce",
    label: "OAuth 2.0 PKCE",
    description: "OAuth2 authorization code with PKCE",
    category: "OAuth",
    ctor: OAuth2LikeAuthProvider,
  },
  "oauth-device-code": {
    id: "oauth-device-code",
    label: "OAuth Device Code",
    description: "OAuth2 device authorization flow",
    category: "OAuth",
    ctor: OAuth2LikeAuthProvider,
  },
  "browser-session": {
    id: "browser-session",
    label: "Browser Session",
    description: "Use browser session token/cookie",
    category: "Advanced",
    ctor: BrowserSessionAuthProvider,
  },
  "custom-header": {
    id: "custom-header",
    label: "Custom Headers",
    description: "Set arbitrary auth headers",
    category: "Advanced",
    ctor: CustomHeaderAuthProvider,
  },
  "query-param": {
    id: "query-param",
    label: "Query Parameter",
    description: "Put auth in URL query parameter",
    category: "Advanced",
    ctor: QueryParamAuthProvider,
  },
};

export function getAuthMethodDefinition(method: AuthMethod): AuthMethodDefinition {
  return AUTH_METHODS[method];
}

export function getAuthMethodCtor(method: AuthMethod): AuthMethodDefinition["ctor"] {
  return AUTH_METHODS[method].ctor;
}

export function listAuthMethodDefinitions(): AuthMethodDefinition[] {
  return Object.values(AUTH_METHODS);
}

export function createAuthProvider(context: AuthProviderContext, config: AuthConfig): AuthProvider {
  const Ctor = getAuthMethodCtor(config.method);
  return new Ctor(context, config);
}
