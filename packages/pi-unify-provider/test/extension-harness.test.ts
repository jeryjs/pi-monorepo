import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestSession, type TestSession } from "@marcfargas/pi-test-harness";

function writeProviderDb(homeDir: string): string {
	const dbPath = join(homeDir, ".pi", "agent", "unify-providers-db.json");
	mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
	writeFileSync(
		dbPath,
		JSON.stringify(
			{
				version: 2,
				providers: [
					{
						type: "custom",
						name: "AIClient2API",
						baseUrl: "https://api.example.com/v1",
						api: "openai-completions",
						auth: { method: "api-key", apiKey: "sk-test" },
						models: [{ id: "model-original" }],
						autoFetchOfficialModels: false,
					},
				],
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

	let t: TestSession | undefined;
	try {
		process.env.HOME = fakeHome;
		process.env.USERPROFILE = fakeHome;
		const dbPath = writeProviderDb(fakeHome);

		const extModule = await import(`../index.ts?test=${Date.now()}`);
		const registerExtension = extModule.default as (pi: unknown) => void;

		t = await createTestSession({
			cwd: workspace,
			extensionFactories: [registerExtension],
			mockUI: {
				editor: "alpha\nbeta",
			},
		});

		await t.session.prompt("/unify-export");
		await (t.session.agent as any).waitForIdle();
		assert.ok(t.events.uiCallsFor("setEditorText").length > 0);

		await t.session.prompt("/unify-models AIClient2API");
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
	} finally {
		t?.dispose();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		rmSync(workspace, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	}
});
