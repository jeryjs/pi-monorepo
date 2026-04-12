import type { AuthConfig, AuthMethod } from "../types.js";

export function createDefaultAuthConfig(method: AuthMethod): AuthConfig {
  switch (method) {
    case "none":
      return { method: "none" };
    case "api-key":
      return { method: "api-key", headerName: "Authorization", prefix: "Bearer " };
    case "bearer-token":
      return { method: "bearer-token", headerName: "Authorization" };
    case "oauth2":
      return {
        method: "oauth2",
        oauth: {
          grantType: "authorization_code",
          authorizationUrl: "",
          tokenUrl: "",
          clientId: "",
        },
      };
    case "oauth2-pkce":
      return {
        method: "oauth2-pkce",
        oauth: {
          authorizationUrl: "",
          tokenUrl: "",
          clientId: "",
          codeChallengeMethod: "S256",
        },
      };
    case "oauth-device-code":
      return {
        method: "oauth-device-code",
        oauth: {
          deviceAuthorizationUrl: "",
          tokenUrl: "",
          clientId: "",
        },
      };
    case "browser-session":
      return { method: "browser-session" };
    case "custom-header":
      return { method: "custom-header", headers: {} };
    case "query-param":
      return { method: "query-param", paramName: "api_key" };
    default:
      return { method: "none" };
  }
}
