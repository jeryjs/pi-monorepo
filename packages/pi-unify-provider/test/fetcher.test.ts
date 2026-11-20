import assert from "node:assert/strict";
import test from "node:test";
import { OfficialModelsFetcher } from "../fetcher.ts";
import { getProviderPreset } from "../well-known.ts";
import type { ProviderConfigRecord } from "../types.ts";

test("fetcher parses provider payloads with models object map", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					models: {
						"model-a": {},
						"model-b": {},
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const provider: ProviderConfigRecord = {
			type: "fireworks",
			name: "Fireworks Test",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			api: "openai-completions",
			auth: { method: "api-key", apiKey: "sk-test" },
			models: [],
		};

		const fetcher = new OfficialModelsFetcher({ retries: 1, timeoutMs: 1_000 });
		const preset = getProviderPreset("fireworks");
		const models = await fetcher.fetchProviderModels({ provider, preset });
		const ids = models.map((m) => m.id).sort();

		assert.deepEqual(ids, ["model-a", "model-b"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("merge precedence keeps manual model overrides", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					data: [{ id: "sonar" }, { id: "sonar-pro" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const provider: ProviderConfigRecord = {
			type: "perplexity",
			name: "Perplexity Test",
			baseUrl: "https://api.perplexity.ai",
			api: "openai-completions",
			auth: { method: "api-key", apiKey: "sk-test" },
			models: [{ id: "sonar", name: "Manual Sonar Name" }],
		};

		const fetcher = new OfficialModelsFetcher({ retries: 1, timeoutMs: 1_000 });
		const preset = getProviderPreset("perplexity");
		const models = await fetcher.fetchProviderModels({ provider, preset });

		const sonar = models.find((m) => m.id === "sonar");
		assert.ok(sonar);
		assert.equal(sonar?.name, "Manual Sonar Name");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
