import type {
	AuthConfig,
	OAuth2AuthConfig,
	OAuth2PkceAuthConfig,
	OAuth2TokenData,
	OAuthDeviceCodeAuthConfig,
	ProviderConfigRecord,
	ResolvedAuth,
} from "./types.ts";
import { isSecretRef, type SecretStore } from "./secret-store.ts";

const EXPIRY_BUFFER_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mergeHeaders(a?: Record<string, string>, b?: Record<string, string>): Record<string, string> | undefined {
	if (!a && !b) return undefined;
	return { ...(a ?? {}), ...(b ?? {}) };
}

function mergeQuery(a?: Record<string, string>, b?: Record<string, string>): Record<string, string> | undefined {
	if (!a && !b) return undefined;
	return { ...(a ?? {}), ...(b ?? {}) };
}

function mergeBody(a?: Record<string, unknown>, b?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!a && !b) return undefined;
	return { ...(a ?? {}), ...(b ?? {}) };
}

function tokenFromUnknown(value: unknown): OAuth2TokenData | undefined {
	if (!isRecord(value)) return undefined;
	const accessToken = asString(value.accessToken);
	if (!accessToken) return undefined;
	const refreshToken = asString(value.refreshToken);
	const tokenType = asString(value.tokenType) ?? "Bearer";
	const expiresAt = typeof value.expiresAt === "number" ? value.expiresAt : undefined;
	const scope = asString(value.scope);
	return { accessToken, refreshToken, tokenType, expiresAt, scope };
}

function parseOAuthToken(raw?: string): OAuth2TokenData | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw);
		const token = tokenFromUnknown(parsed);
		if (token) return token;
	} catch {
		// Treat raw value as access token fallback.
	}
	return { accessToken: raw, tokenType: "Bearer" };
}

function shouldRefresh(token: OAuth2TokenData): boolean {
	if (!token.expiresAt) return false;
	return Date.now() >= token.expiresAt - EXPIRY_BUFFER_MS;
}

function tokenEndpoint(
	auth: OAuth2AuthConfig | OAuth2PkceAuthConfig | OAuthDeviceCodeAuthConfig,
): string {
	return auth.tokenUrl;
}

async function refreshOAuthToken(
	auth: OAuth2AuthConfig | OAuth2PkceAuthConfig | OAuthDeviceCodeAuthConfig,
	token: OAuth2TokenData,
): Promise<OAuth2TokenData> {
	if (!token.refreshToken) return token;
	const body = new URLSearchParams();
	body.set("grant_type", "refresh_token");
	body.set("refresh_token", token.refreshToken);
	body.set("client_id", auth.clientId);
	if ("clientSecret" in auth && auth.clientSecret) {
		body.set("client_secret", auth.clientSecret);
	}
	const response = await fetch(tokenEndpoint(auth), {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});
	if (!response.ok) {
		throw new Error(`OAuth refresh failed (${response.status})`);
	}
	const data = await response.json();
	if (!isRecord(data) || !asString(data.access_token)) {
		throw new Error("OAuth refresh response missing access_token");
	}
	const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined;
	return {
		accessToken: asString(data.access_token)!,
		refreshToken: asString(data.refresh_token) ?? token.refreshToken,
		tokenType: asString(data.token_type) ?? token.tokenType ?? "Bearer",
		expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : token.expiresAt,
		scope: asString(data.scope) ?? token.scope,
	};
}

async function resolveSecretString(
	value: string | undefined,
	secretStore: SecretStore,
	kind: "api-key" | "generic",
): Promise<string | undefined> {
	const normalized = asString(value);
	if (!normalized) return undefined;
	if (!isSecretRef(normalized)) return normalized;
	if (kind === "api-key") return secretStore.getApiKey(normalized);
	return secretStore.getGeneric(normalized);
}

async function resolveOAuthToken(
	tokenRaw: string | undefined,
	secretStore: SecretStore,
): Promise<{ token?: OAuth2TokenData; tokenRef?: string }> {
	const tokenValue = asString(tokenRaw);
	if (!tokenValue) return {};
	if (!isSecretRef(tokenValue)) {
		return { token: parseOAuthToken(tokenValue) };
	}
	return {
		token: secretStore.getOAuthToken(tokenValue),
		tokenRef: tokenValue,
	};
}

export async function resolveAuth(
	auth: AuthConfig,
	secretStore: SecretStore,
): Promise<ResolvedAuth> {
	switch (auth.method) {
		case "none":
			return {};
		case "api-key": {
			const apiKey = await resolveSecretString(auth.apiKey, secretStore, "api-key");
			if (!apiKey) throw new Error("API key auth is configured but key is missing");
			return { headers: { Authorization: `Bearer ${apiKey}` } };
		}
		case "bearer-token": {
			const token = await resolveSecretString(auth.token, secretStore, "generic");
			if (!token) throw new Error("Bearer auth is configured but token is missing");
			const headerName = auth.headerName?.trim() || "Authorization";
			const headerValue = headerName.toLowerCase() === "authorization" ? `Bearer ${token}` : token;
			return { headers: { [headerName]: headerValue } };
		}
		case "custom-header": {
			const headerName = auth.headerName.trim();
			if (!headerName) throw new Error("Custom header auth missing headerName");
			const value = await resolveSecretString(auth.headerValue, secretStore, "generic");
			if (!value) throw new Error("Custom header auth missing headerValue");
			return { headers: { [headerName]: value } };
		}
		case "query-param": {
			const paramName = auth.paramName.trim();
			if (!paramName) throw new Error("Query param auth missing paramName");
			const value = await resolveSecretString(auth.paramValue, secretStore, "generic");
			if (!value) throw new Error("Query param auth missing paramValue");
			return { query: { [paramName]: value } };
		}
		case "browser-session": {
			const cookie = await resolveSecretString(auth.cookieHeader, secretStore, "generic");
			if (!cookie) throw new Error("Browser session auth missing cookieHeader");
			return { headers: { Cookie: cookie } };
		}
		case "oauth2":
		case "oauth2-pkce":
		case "oauth-device-code": {
			const refreshAuth = "clientSecret" in auth
				? {
					...auth,
					clientSecret: await resolveSecretString(auth.clientSecret, secretStore, "generic"),
				}
				: auth;
			const { token, tokenRef } = await resolveOAuthToken(auth.token, secretStore);
			if (!token?.accessToken) throw new Error(`${auth.method} auth missing access token`);
			const next = shouldRefresh(token) ? await refreshOAuthToken(refreshAuth, token) : token;
			if (tokenRef && next !== token) {
				secretStore.setOAuthToken(tokenRef, next);
			}
			return {
				headers: {
					Authorization: `${next.tokenType ?? "Bearer"} ${next.accessToken}`,
				},
			};
		}
	}
}

export async function resolveProviderAuth(
	provider: ProviderConfigRecord,
	secretStore: SecretStore,
): Promise<ResolvedAuth> {
	const auth = await resolveAuth(provider.auth, secretStore);
	return {
		headers: mergeHeaders(provider.extraHeaders, auth.headers),
		query: mergeQuery(provider.extraQuery, auth.query),
		body: mergeBody(provider.extraBody, auth.body),
	};
}

export function applyResolvedAuthToPayload(payload: unknown, resolved: ResolvedAuth): unknown {
	if (!isRecord(payload)) return payload;
	const next: Record<string, unknown> = { ...payload };

	const headers = isRecord(next.headers) ? (next.headers as Record<string, string>) : undefined;
	const body = isRecord(next.body) ? (next.body as Record<string, unknown>) : undefined;

	next.headers = mergeHeaders(headers, resolved.headers);
	next.body = mergeBody(body, resolved.body);

	if (typeof next.url === "string" && resolved.query) {
		const url = new URL(next.url);
		for (const [key, value] of Object.entries(resolved.query)) {
			url.searchParams.set(key, value);
		}
		next.url = url.toString();
	}

	return next;
}
