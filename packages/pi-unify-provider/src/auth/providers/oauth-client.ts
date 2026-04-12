import { createHash, randomBytes } from "node:crypto";
import type { OAuthTokenData } from "../../types.js";

export interface OAuthAuthCodeConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri: string;
  scopes?: string[];
}

export interface OAuthClientCredentialsConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: string[];
}

export interface OAuthDeviceCodeConfig {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export function generateState(): string {
  return randomBytes(24).toString("base64url");
}

export function generatePkceVerifier(): { verifier: string; challenge: string; method: "S256" } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

export function buildAuthorizationUrl(args: {
  config: OAuthAuthCodeConfig;
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    state: args.state,
    redirect_uri: args.config.redirectUri,
  });

  if (args.config.clientId) {
    params.set("client_id", args.config.clientId);
  }

  if (args.config.scopes?.length) {
    params.set("scope", args.config.scopes.join(" "));
  }

  if (args.codeChallenge) {
    params.set("code_challenge", args.codeChallenge);
    params.set("code_challenge_method", args.codeChallengeMethod ?? "S256");
  }

  return `${args.config.authorizationUrl}?${params.toString()}`;
}

function tokenResponseToData(response: any): OAuthTokenData {
  return {
    accessToken: String(response.access_token ?? ""),
    tokenType: String(response.token_type ?? "Bearer"),
    refreshToken: response.refresh_token ? String(response.refresh_token) : undefined,
    expiresAt: typeof response.expires_in === "number"
      ? Date.now() + response.expires_in * 1000
      : undefined,
    scope: response.scope ? String(response.scope) : undefined,
  };
}

export async function exchangeCodeForToken(args: {
  config: OAuthAuthCodeConfig;
  code: string;
  codeVerifier?: string;
}): Promise<OAuthTokenData> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.config.redirectUri,
  });

  if (args.config.clientId) body.set("client_id", args.config.clientId);
  if (args.config.clientSecret) body.set("client_secret", args.config.clientSecret);
  if (args.codeVerifier) body.set("code_verifier", args.codeVerifier);

  const response = await fetch(args.config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as any;
  return tokenResponseToData(data);
}

export async function refreshOAuthToken(args: {
  tokenUrl: string;
  refreshToken: string;
  clientId?: string;
  clientSecret?: string;
  signal?: AbortSignal;
}): Promise<OAuthTokenData> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
  });

  if (args.clientId) body.set("client_id", args.clientId);
  if (args.clientSecret) body.set("client_secret", args.clientSecret);

  const response = await fetch(args.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: args.signal,
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as any;
  return tokenResponseToData(data);
}

export async function getClientCredentialsToken(
  config: OAuthClientCredentialsConfig,
  signal?: AbortSignal,
): Promise<OAuthTokenData> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  if (config.scopes?.length) {
    body.set("scope", config.scopes.join(" "));
  }

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Client credentials token request failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as any;
  return tokenResponseToData(data);
}

export async function startDeviceCodeFlow(config: OAuthDeviceCodeConfig): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({ client_id: config.clientId });
  if (config.scopes?.length) {
    body.set("scope", config.scopes.join(" "));
  }

  const response = await fetch(config.deviceAuthorizationUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Device code request failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as any;

  return {
    deviceCode: String(data.device_code),
    userCode: String(data.user_code),
    verificationUri: String(data.verification_uri),
    verificationUriComplete: data.verification_uri_complete ? String(data.verification_uri_complete) : undefined,
    expiresIn: Number(data.expires_in ?? 900),
    interval: Number(data.interval ?? 5),
  };
}

export async function pollDeviceCodeToken(args: {
  config: OAuthDeviceCodeConfig;
  deviceCode: string;
  signal?: AbortSignal;
}): Promise<OAuthTokenData | null> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: args.config.clientId,
    device_code: args.deviceCode,
  });

  const response = await fetch(args.config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: args.signal,
  });

  if (!response.ok) {
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Device token request failed: ${response.status}`);
    }

    const error = String(data.error ?? "unknown_error");
    if (error === "authorization_pending" || error === "slow_down") {
      return null;
    }

    throw new Error(data.error_description ? String(data.error_description) : error);
  }

  const data = (await response.json()) as any;
  return tokenResponseToData(data);
}

export async function revokeOAuthToken(args: {
  revocationUrl: string;
  token: string;
  tokenTypeHint?: "access_token" | "refresh_token";
  clientId?: string;
  clientSecret?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const body = new URLSearchParams({ token: args.token });
  if (args.tokenTypeHint) body.set("token_type_hint", args.tokenTypeHint);
  if (args.clientId) body.set("client_id", args.clientId);
  if (args.clientSecret) body.set("client_secret", args.clientSecret);

  const response = await fetch(args.revocationUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: args.signal,
  });

  if (!response.ok) {
    throw new Error(`Token revocation failed: ${response.status} ${await response.text()}`);
  }
}
