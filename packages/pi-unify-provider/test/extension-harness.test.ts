import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestSession, type TestSession } from "@marcfargas/pi-test-harness";

type ProviderFixture = {
	type: string;
	name: string;
	baseUrl: string;
	api: string;
	auth: Record<string, unknown>;
	models: Array<{ id: string }>;
	autoFetchOfficialModels?: boolean;
};

function writeProviderDb(homeDir: string, providers: ProviderFixture[]): string {
	const dbPath = join(homeDir, ".pi", "agent", "unify-providers-db.json");
	mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
	writeFileSync(
		dbPath,
		JSON.stringify(
			{
				version: 2,
				providers,
			},
			null,
			"\t",
		),
		"utf8",
	);
	return dbPath;
}

test("extension works in pi-test-harness command flow", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "unify-harness-ws-"));
	const fakeHome = mkdtempSync(join(tmpdir(), "unify-harness-home-"));
	const originalHome = process.env.HOME;
	const originalUserProfile = process.env.USERPROFILE;
	const originalFetch = globalThis.fetch;

	let t: TestSession | undefined;
	try {
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ data: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});

		process.env.HOME = fakeHome;
		process.env.USERPROFILE = fakeHome;
		const dbPath = writeProviderDb(fakeHome, [
			{
				type: "custom",
				name: "AIClient2API",
				baseUrl: "https://api.example.com/v1",
				api: "openai-completions",
				auth: { method: "api-key", apiKey: "sk-test" },
				models: [{ id: "model-original" }],
				autoFetchOfficialModels: false,
			},
		]);

		const extModule = await import(`../index.ts?test=${Date.now()}`);
		const registerExtension = extModule.default as (pi: unknown) => void;

		t = await createTestSession({
			cwd: workspace,
			extensionFactories: [registerExtension],
			mockUI: {
				editor: (title) =>
					title.includes("Paste provider import JSON")
						? JSON.stringify(
							{
								providers: [
									{
										type: "custom",
										name: "AIClient2API",
										baseUrl: "https://api.example.com/v1",
										api: "openai-completions",
										auth: { method: "api-key", apiKey: "sk-test" },
										models: [{ id: "alpha" }, { id: "beta" }],
										autoFetchOfficialModels: false,
									},
								],
							},
						)
						: "",
			},
		});

		await t.session.prompt("/unify-export");
		await (t.session.agent as any).waitForIdle();
		assert.ok(t.events.uiCallsFor("setEditorText").length > 0);

		await t.session.prompt("/unify-import");
		await (t.session.agent as any).waitForIdle();

		const db = JSON.parse(readFileSync(dbPath, "utf8")) as {
			providers: Array<{ name: string; models: Array<{ id: string }> }>;
		};
		const provider = db.providers.find((p) => p.name === "AIClient2API");
		assert.ok(provider);
		assert.deepEqual(provider?.models.map((m) => m.id), ["alpha", "beta"]);

		await t.session.prompt("/unify-refresh");
		await (t.session.agent as any).waitForIdle();
		const notifyTexts = t.events.uiCallsFor("notify").map((call) => String(call.args[0] ?? ""));
		assert.ok(notifyTexts.some((text) => text.includes("refreshed")));

		await t.session.prompt("/unify-add");
		await (t.session.agent as any).waitForIdle();

		const dbAfterAdd = JSON.parse(readFileSync(dbPath, "utf8")) as {
			providers: Array<{ name: string; baseUrl: string; api: string }>;
		};
		const together = dbAfterAdd.providers.find((p) => p.name === "Together AI");
		assert.ok(together);
		assert.equal(together?.baseUrl, "https://api.together.xyz/v1");
		assert.equal(together?.api, "openai-completions");

		assert.equal(t.events.uiCallsFor("input").length, 0);
	} finally {
		t?.dispose();
		globalThis.fetch = originalFetch;
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		rmSync(workspace, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	}
});
