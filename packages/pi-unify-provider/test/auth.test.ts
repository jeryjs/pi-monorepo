import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAuth } from "../auth.ts";
import { SecretStore } from "../secret-store.ts";

test("resolveAuth reads api-key from secret ref", async () => {
	const temp = mkdtempSync(join(tmpdir(), "unify-auth-test-"));
	try {
		const secrets = new SecretStore(join(temp, "secrets.json"));
		const ref = secrets.createRef();
		secrets.setApiKey(ref, "sk-test-123");

		const resolved = await resolveAuth({ method: "api-key", apiKey: ref }, secrets);
		assert.equal(resolved.headers?.Authorization, "Bearer sk-test-123");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("resolveAuth resolves query-param from secret ref", async () => {
	const temp = mkdtempSync(join(tmpdir(), "unify-auth-test-"));
	try {
		const secrets = new SecretStore(join(temp, "secrets.json"));
		const ref = secrets.createRef();
		secrets.setGeneric(ref, "qp-secret");

		const resolved = await resolveAuth(
			{ method: "query-param", paramName: "api_key", paramValue: ref },
			secrets,
		);
		assert.equal(resolved.query?.api_key, "qp-secret");
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("resolveAuth refreshes expired oauth token from secret ref", async () => {
	const temp = mkdtempSync(join(tmpdir(), "unify-auth-test-"));
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

		const secrets = new SecretStore(join(temp, "secrets.json"));
		const tokenRef = secrets.createRef();
		secrets.setOAuthToken(tokenRef, {
			accessToken: "expired-token",
			refreshToken: "refresh-token",
			expiresAt: Date.now() - 10_000,
			tokenType: "Bearer",
		});

		const resolved = await resolveAuth(
			{
				method: "oauth2",
				tokenUrl: "https://auth.example.com/token",
				clientId: "client-id",
				token: tokenRef,
			},
			secrets,
		);

		assert.equal(resolved.headers?.Authorization, "Bearer new-access-token");
		assert.equal(secrets.getOAuthToken(tokenRef)?.accessToken, "new-access-token");
	} finally {
		globalThis.fetch = originalFetch;
		rmSync(temp, { recursive: true, force: true });
	}
});
