/**
 * Tests for the on-demand sherpa wake-word installer.
 *
 * Everything here is deterministic and offline: npm is replaced by a script we
 * control (through PI_VOICE_NPM_JS) and the model "download" is served by a local
 * HTTP server from a tarball we build with the real `tar -cjf`. That exercises
 * the same code path the TUI runs — fetch → extract → verify → move — without
 * depending on GitHub.
 *
 * The real path was verified by hand: `npm install sherpa-onnx-node` (2.0.3,
 * prebuilt, ~23 MB) plus the gigaspeech KWS model tarball, and the resulting
 * spotter detected "LOVELY CHILD" in the model's own test wav.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    KWS_MODEL,
    KWS_PACKAGE,
    modelStatus,
    parseKeywordSpec,
    resolvedModelDir,
    sherpaStatus,
    setupSherpaWake,
    tokenizeKeyword,
    downloadKwsModel,
    installSherpaPackage,
    managedDepsDir,
    managedModelDir,
    writeKeywordsFile,
} from "../sherpa.ts";

const sandbox = mkdtempSync(join(tmpdir(), "pi-voice-sherpa-"));
const depsDir = join(sandbox, "deps");
const modelsDir = join(sandbox, "models");
const modelDir = join(modelsDir, "test-kws-model");
const fakeNpm = join(sandbox, "fake-npm.cjs");

process.env.PI_VOICE_DEPS = depsDir;
process.env.PI_VOICE_MODELS = modelsDir;

let passed = 0;

function test(name: string, fn: () => void): void {
    fn();
    passed++;
    console.log("  ok  " + name);
}

async function asyncTest(name: string, fn: () => Promise<void>): Promise<void> {
    await fn();
    passed++;
    console.log("  ok  " + name);
}

// ---------------------------------------------------------------------------
// fixture: a model directory with tokens.txt + the three onnx files
// ---------------------------------------------------------------------------

const TOKENS = [
    "<blk> 0", "<sos/eos> 1", "<unk> 2",
    "S 3", "T 4", "\u2581THE 5", "\u2581HE 6", "Y 7", "\u2581PI 8",
    "\u2581LOVE 9", "LY 10", "\u2581CHI 11", "L 12", "D 13", "\u2581A 14",
];

function makeModelDir(dir: string, tokens = TOKENS): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tokens.txt"), tokens.join("\n") + "\n", "utf8");
    writeFileSync(join(dir, "encoder-epoch-1.int8.onnx"), "x", "utf8");
    writeFileSync(join(dir, "decoder-epoch-1.onnx"), "x", "utf8");
    writeFileSync(join(dir, "joiner-epoch-1.int8.onnx"), "x", "utf8");
}

makeModelDir(modelDir);

// ---------------------------------------------------------------------------
// keywords: BPE tokenisation against the model's tokens.txt
// ---------------------------------------------------------------------------

console.log("keyword tokenisation");

test("phrases are tokenised the way sherpa expects, not written raw", () => {
    const hey = tokenizeKeyword(modelDir, "HEY PI");
    assert.equal(hey.ok, true);
    assert.equal(hey.ok && hey.tokens, "\u2581HE Y \u2581PI");

    // Lower case input is normalised, and the same phrase is stable.
    assert.equal(tokenizeKeyword(modelDir, "hey pi").ok && tokenizeKeyword(modelDir, "hey pi").tokens, "\u2581HE Y \u2581PI");

    const lovely = tokenizeKeyword(modelDir, "LOVELY CHILD");
    assert.equal(lovely.ok && lovely.tokens, "\u2581LOVE LY \u2581CHI L D");

    // Longest match wins: ▁THE exists, so it must not degrade to  ▁ + T + HE.
    assert.equal(tokenizeKeyword(modelDir, "THE").ok && tokenizeKeyword(modelDir, "THE").tokens, "\u2581THE");
});

test("an uncoverable phrase fails with a useful reason", () => {
    const bad = tokenizeKeyword(modelDir, "ZZZ QQQ");

    assert.equal(bad.ok, false);
    assert.ok(bad.ok === false && /no token in tokens\.txt/.test(bad.reason), "reason names the missing token");
    assert.ok(bad.ok === false && /text2token/.test(bad.reason), "reason points at the manual tool");
});

test("keyword specs carry an optional per-keyword boost", () => {
    assert.deepEqual(parseKeywordSpec("HEY PI :2.0"), [{ phrase: "HEY PI", boost: 2 }]);
    assert.deepEqual(parseKeywordSpec("HEY PI"), [{ phrase: "HEY PI" }]);
    assert.deepEqual(parseKeywordSpec("HEY PI :1.5; OK PI"), [{ phrase: "HEY PI", boost: 1.5 }, { phrase: "OK PI" }]);
});

test("the keywords file is tokenised, digest-named and cached", () => {
    const first = writeKeywordsFile(modelDir, "HEY PI :2.0", join(modelsDir, "keywords"));

    assert.equal(first.ok, true);

    if (!first.ok) {
        return;
    }

    const lines = readFileSync(first.path, "utf8").trim().split("\n");

    assert.deepEqual(lines, ["\u2581HE Y \u2581PI :2"]);
    assert.ok(first.path.includes("\u2581") === false, "the file lives in our cache, not the model dir");

    const again = writeKeywordsFile(modelDir, "HEY PI :2.0", join(modelsDir, "keywords"));

    assert.equal(again.ok && again.path, first.path, "same spec reuses the same file");

    const changed = writeKeywordsFile(modelDir, "HEY PI :1.0", join(modelsDir, "keywords"));

    assert.notEqual(changed.ok && changed.path, first.path, "editing the phrase writes a new file");
});

// ---------------------------------------------------------------------------
// status: what is missing, and where things live
// ---------------------------------------------------------------------------

console.log("status");

test("an empty setup reports both pieces as missing", () => {
    const status = sherpaStatus("");

    assert.equal(status.packageInstalled, false);
    assert.equal(status.ready, false);
    assert.equal(status.modelDir, managedModelDir(), "empty config resolves to the managed dir");
    assert.ok(status.detail.includes(KWS_PACKAGE));

    const configured = sherpaStatus(join(sandbox, "my-own-model"));

    assert.equal(configured.modelDir, join(sandbox, "my-own-model"), "an explicit dir wins");
    assert.equal(configured.managed, false);
});

test("a complete model directory is recognised, and gaps are listed", () => {
    assert.deepEqual(modelStatus(modelDir), { ok: true, missing: [] });

    const partial = join(sandbox, "partial");
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, "tokens.txt"), "x 0\n", "utf8");
    writeFileSync(join(partial, "encoder-1.onnx"), "x", "utf8");

    const status = modelStatus(partial);

    assert.equal(status.ok, false);
    assert.deepEqual(status.missing, ["decoder*.onnx", "joiner*.onnx"]);

    // The int8 encoder must be preferred over the fp32 one.
    writeFileSync(join(partial, "encoder-1.int8.onnx"), "x", "utf8");
    assert.equal(modelStatus(partial).missing.includes("encoder*.onnx"), false);
});

test("an explicit model dir is used as-is, otherwise the managed one", () => {
    assert.equal(resolvedModelDir(""), managedModelDir());
    assert.equal(resolvedModelDir("  "), managedModelDir());
    assert.equal(resolvedModelDir("  D:/models/kws "), "D:/models/kws");
});

// ---------------------------------------------------------------------------
// install: the runtime package (fake npm, real spawning/streaming)
// ---------------------------------------------------------------------------

const npmScript = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const mode = process.env.FAKE_NPM_MODE || "ok";
const prefixIndex = args.indexOf("--prefix");
const prefix = prefixIndex >= 0 ? args[prefixIndex + 1] : undefined;
console.log("fake npm: " + args.join(" "));
if (mode === "fail") {
  console.error("npm ERR! 404 nope");
  process.exit(3);
}
const pkg = path.join(prefix, "node_modules", "${KWS_PACKAGE}");
fs.mkdirSync(pkg, { recursive: true });
fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "${KWS_PACKAGE}", version: "9.9.9", main: "index.js" }));
fs.writeFileSync(path.join(pkg, "index.js"), "module.exports = { KeywordSpotter: class {} };\\n");
console.log("added 2 packages");
`;

writeFileSync(fakeNpm, npmScript, "utf8");
process.env.PI_VOICE_NPM_JS = fakeNpm;

console.log("installer (runtime)");

await asyncTest("the installer runs npm with our prefix and reports the version", async () => {
    const lines: string[] = [];
    const result = await installSherpaPackage((line) => lines.push(line));

    assert.equal(result.ok, true, result.detail);
    assert.ok(result.detail.includes("9.9.9"), `detail reports the installed version: ${result.detail}`);
    assert.ok(existsSync(join(depsDir, "node_modules", KWS_PACKAGE, "package.json")));
    assert.ok(lines.some((line) => line.includes("added 2 packages")), "npm output is streamed to the caller");
    assert.ok(lines.some((line) => line.includes("--prefix")), "npm is invoked with the managed prefix");

    const status = sherpaStatus("");

    assert.equal(status.packageInstalled, true);
    assert.equal(status.version, "9.9.9", "status reads the version without executing the package");
});

await asyncTest("a failing npm is surfaced, not swallowed", async () => {
    process.env.FAKE_NPM_MODE = "fail";

    const before = sherpaStatus("").packageInstalled;
    assert.equal(before, true, "the previous install is still visible");

    const result = await installSherpaPackage(() => undefined);

    // Same version already present, so re-installing can only fail here.
    assert.equal(result.ok, false);
    assert.ok(result.detail.includes("404 nope"), `the npm error text is reported: ${result.detail}`);
    assert.ok(result.detail.includes("install it yourself"), "manual instructions are offered");

    delete process.env.FAKE_NPM_MODE;
});

// ---------------------------------------------------------------------------
// install: the model (real fetch + real tar against a local server)
// ---------------------------------------------------------------------------

console.log("installer (model)");

const tarAvailable = spawnSync("tar", ["--version"], { encoding: "utf8" }).status === 0;

if (!tarAvailable) {
    console.log("  --  skipped: no tar available to build the fixture archive");
} else {
    // Build a real .tar.bz2 with the same shape as the upstream release.
    const payloadRoot = join(sandbox, "payload");
    const payloadModel = join(payloadRoot, "model-src");

    makeModelDir(payloadModel);

    const archive = join(payloadRoot, `${KWS_MODEL.name}.tar.bz2`);
    const packed = spawnSync("tar", ["-cjf", `${KWS_MODEL.name}.tar.bz2`, "model-src"], { cwd: payloadRoot, encoding: "utf8" });

    assert.equal(packed.status, 0, `tar -cjf should build the fixture: ${packed.stderr}`);
    assert.ok(existsSync(archive));

    const served = await new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
        const server = createServer((req, res) => {
            // Only the model archive exists, so a wrong path is a real 404.
            if (req.url !== `/${KWS_MODEL.name}.tar.bz2`) {
                res.writeHead(404, { "content-type": "text/plain" }).end("not found");

                return;
            }

            const body = readFileSync(archive);

            res.writeHead(200, { "content-type": "application/x-bzip2", "content-length": String(body.length) });
            res.end(body);
        });

        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;

            resolve({ port, close: () => new Promise<void>((done) => server.close(() => done())) });
        });
    });

    const modelUrl = `http://127.0.0.1:${served.port}/${KWS_MODEL.name}.tar.bz2`;

    process.env.PI_VOICE_KWS_MODEL_URL = modelUrl;

    await asyncTest("the model installer downloads, extracts, verifies and moves it into place", async () => {
        assert.equal(existsSync(managedModelDir()), false, "starts empty");

        const lines: string[] = [];
        const result = await downloadKwsModel((line) => lines.push(line));

        assert.equal(result.ok, true, result.detail);
        assert.deepEqual(modelStatus(managedModelDir()), { ok: true, missing: [] }, "the required files are in place");
        assert.ok(lines.some((line) => line.includes("downloading")), "download progress is reported");
        assert.ok(lines.some((line) => line.includes("extracting")), "extraction is reported");

        // No staging or archive leftovers.
        assert.equal(existsSync(join(modelsDir, `.staging-${process.pid}`)), false, "staging dir is cleaned up");

        // A second call is a no-op, not a re-download.
        const again = await downloadKwsModel(() => undefined);

        assert.equal(again.ok, true);
        assert.ok(again.detail.includes("already installed"), again.detail);
    });

    await asyncTest("a broken download fails cleanly and leaves no partial model", async () => {
        const brokenModel = join(sandbox, "broken-models");
        const previousModels = process.env.PI_VOICE_MODELS;

        process.env.PI_VOICE_MODELS = brokenModel;
        process.env.PI_VOICE_KWS_MODEL_URL = `http://127.0.0.1:${served.port}/missing.tar.bz2`;

        try {
            const result = await downloadKwsModel(() => undefined);

            assert.equal(result.ok, false, result.detail);
            assert.ok(/404/.test(result.detail), `the HTTP status is reported: ${result.detail}`);
            assert.ok(result.detail.includes("Manual:"), "manual fallback instructions are offered");
            assert.equal(existsSync(join(brokenModel, `.staging-${process.pid}`)), false, "staging is cleaned up");
        } finally {
            process.env.PI_VOICE_MODELS = previousModels;
            process.env.PI_VOICE_KWS_MODEL_URL = modelUrl;
        }
    });

    // -----------------------------------------------------------------------
    // guided setup (what the TUI and /voice sherpa call)
    // -----------------------------------------------------------------------

    console.log("guided setup");

    await asyncTest("cancelling changes nothing and says so", async () => {
        const result = await setupSherpaWake({
            modelDir: join(sandbox, "somewhere-else"),
            onLine: () => undefined,
            confirm: async () => false,
        });

        assert.equal(result.ok, false);
        assert.ok(/cancelled/.test(result.detail), result.detail);
    });

    await asyncTest("a full guided run ends ready and asks for both pieces", async () => {
        const previousDeps = process.env.PI_VOICE_DEPS;
        const previousModels = process.env.PI_VOICE_MODELS;

        process.env.PI_VOICE_DEPS = join(sandbox, "guided-deps");
        process.env.PI_VOICE_MODELS = join(sandbox, "guided-models");

        try {
            const lines: string[] = [];
            const choices: string[] = [];
            const result = await setupSherpaWake({
                modelDir: "",
                onLine: (line) => lines.push(line),
                confirm: async (title) => {
                    choices.push(title);

                    return true;
                },
            });

            assert.equal(result.ok, true, result.detail);
            assert.equal(result.status.ready, true);
            assert.equal(choices.length, 2, `it asks once for the runtime and once for the model (${choices.join(" / ")})`);
            assert.ok(choices[0]?.includes(KWS_PACKAGE), choices[0]);
            assert.ok(choices[1]?.includes("model"), choices[1]);
            assert.ok(lines.some((line) => line.includes("added 2 packages")), "progress is streamed");
            assert.deepEqual(modelStatus(managedModelDir()), { ok: true, missing: [] }, "the model landed in the managed dir");

            // Everything present now: nothing to ask about.
            const again = await setupSherpaWake({ modelDir: "", onLine: () => undefined, confirm: async () => false });

            assert.equal(again.ok, true, "when everything is present nothing is asked");
        } finally {
            process.env.PI_VOICE_DEPS = previousDeps;
            process.env.PI_VOICE_MODELS = previousModels;
        }
    });

    await served.close();
}

// ---------------------------------------------------------------------------

rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${passed} sherpa checks passed`);
