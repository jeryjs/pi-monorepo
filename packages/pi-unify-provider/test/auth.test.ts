import assert from "node:assert/strict";
import test from "node:test";
import { resolveAuth } from "../auth.ts";

test("resolveAuth reads api-key directly", async () => {
	const resolved = await resolveAuth({ method: "api-key", apiKey: "sk-test-123" });
	assert.equal(resolved.headers?.Authorization, "Bearer sk-test-123");
});

test("resolveAuth resolves query-param directly", async () => {
	const resolved = await resolveAuth({ method: "query-param", paramName: "api_key", paramValue: "qp-secret" });
	assert.equal(resolved.query?.api_key, "qp-secret");
});

test("resolveAuth refreshes expired oauth token from raw json payload", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					access_token: "new-access-token",
					token_type: "Bearer",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const resolved = await resolveAuth({
			method: "oauth2",
			tokenUrl: "https://auth.example.com/token",
			clientId: "client-id",
			token: JSON.stringify({
				accessToken: "expired-token",
				refreshToken: "refresh-token",
				expiresAt: Date.now() - 10_000,
				tokenType: "Bearer",
			}),
		});

		assert.equal(resolved.headers?.Authorization, "Bearer new-access-token");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
