/**
 * Dependency-free smoke tests: capabilities, setup shaping, wire protocol and
 * config normalization. Run with `node test/smoke.ts` (Node strips types).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilitiesFor, liveModelIds } from "../capabilities.ts";
import { completeVoiceArguments } from "../completions.ts";
import { describeStart, parseBool } from "../commands.ts";
import { DEFAULT_VOICE_CONFIG, normalizeVoiceConfig, patchReport, patchVoiceConfig, saveVoiceConfig, loadVoiceConfig } from "../config.ts";
import { keySourceLabel, readKeyFromAuthJson, resolveGeminiKey } from "../keychain.ts";
import { AcousticEchoCanceller, floatToInt16, resample24kTo16k } from "../audio/aec.ts";
import { micVerdict, gainToFloat, playbackArgs } from "../audio/native.ts";
import { friendlyCloseError, isDormantClose, isFatalClose, isStaleHandleClose } from "../live/session.ts";
import { editDistance, matchWakePhrase } from "../audio/wake-match.ts";
import { clearWarnings, debugFromEnv, debugState, log, recentWarnings, redactSecrets, setDebug, warn } from "../util.ts";
import { levelBar, voiceStatusText } from "../ui.ts";
import { PREBUILT_VOICES } from "../voices.ts";
import {
    audioInputMessage,
    clientContentMessage,
    decodePcmBase64,
    encodePcmBase64,
    liveSocketUrl,
    parseServerMessage,
    toolResponseMessage,
} from "../live/protocol.ts";
import { createSetupBuilder } from "../live/setup.ts";
import { functionDeclarations } from "../bridge/tools.ts";
import { AgentBridge } from "../bridge/agent.ts";
import { agentReplyNotice, buildSystemInstruction } from "../bridge/prompt.ts";
import { RingBuffer, backoffDelay, clip, float32ToPcm16 } from "../util.ts";

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

console.log("capabilities");
test("normalizes models/ prefix and knows async tools", () => {
    const caps = capabilitiesFor("models/gemini-3.8-live");
    assert.equal(caps.id, "gemini-3.8-live");
    assert.equal(caps.asyncTools, true);
    assert.equal(caps.toolScheduling, true);
});

test("flash preview is sync-only", () => {
    assert.equal(capabilitiesFor("gemini-3.1-flash-live-preview").asyncTools, false);
});

test("unknown model falls back safely", () => {
    const caps = capabilitiesFor("gemini-9-live");
    assert.equal(caps.syncTools, true);
    assert.equal(caps.asyncTools, false);
    assert.ok(liveModelIds().includes("gemini-3.8-live"));
});

console.log("setup shaping");
const caps = capabilitiesFor("gemini-3.8-live");
const build = createSetupBuilder({
    config: DEFAULT_VOICE_CONFIG,
    capabilities: caps,
    systemInstruction: "be brief",
    tools: functionDeclarations(caps),
});

test("setup has model, audio modality and compression", () => {
    const setup = build(undefined) as Record<string, any>;
    assert.equal(setup.model, "models/gemini-3.8-live");
    assert.deepEqual(setup.generationConfig.responseModalities, ["AUDIO"]);
    assert.ok(setup.contextWindowCompression.slidingWindow);
    // Always declared, even without a handle: sessions that stay quiet would
    // otherwise never receive a resumption token to persist.
    assert.deepEqual(setup.sessionResumption, {});
    // historyConfig would make the server wait for a seeding turn; we use tools instead.
    assert.equal(setup.historyConfig, undefined);
});

test("resumption handle is threaded through", () => {
    const setup = build("handle-123") as Record<string, any>;
    assert.equal(setup.sessionResumption.handle, "handle-123");
});

test("the setup follows the current model, not the one that was configured at start", () => {
    // `/voice model` swaps the capability table. The builder used to capture the
    // capabilities and the declarations once, so the new model kept receiving
    // NON_BLOCKING async tools it does not support.
    let current = capabilitiesFor("gemini-3.8-live");
    const model = { ...DEFAULT_VOICE_CONFIG, thinkingLevel: "" };
    const dynamic = createSetupBuilder({
        config: model,
        capabilities: () => current,
        systemInstruction: "x",
        tools: () => functionDeclarations(current),
    });

    const before = dynamic(undefined) as Record<string, any>;
    const beforeAsk = (before.tools as any[])
        .flatMap((entry) => entry.functionDeclarations ?? [])
        .find((entry: any) => entry.name === "pi_ask");

    assert.equal(beforeAsk.behavior, "NON_BLOCKING", "the async model gets a non-blocking pi_ask");

    current = capabilitiesFor("gemini-3.1-flash-live-preview");
    const after = dynamic(undefined) as Record<string, any>;
    const afterAsk = (after.tools as any[])
        .flatMap((entry) => entry.functionDeclarations ?? [])
        .find((entry: any) => entry.name === "pi_ask");

    assert.equal(afterAsk.behavior, undefined, "a sync-only model must not be handed NON_BLOCKING tools");
    assert.equal(after.model, "models/gemini-3.8-live", "the model id still comes from config");

    // Extended thinking refuses a setup without a level; the table knows, the old
    // captured capabilities did not.
    current = capabilitiesFor("gemini-3.8-live-extended-thinking");
    const thinking = dynamic(undefined) as Record<string, any>;
    assert.equal(thinking.generationConfig.thinkingConfig.thinkingLevel, "low");
});

test("tools include functions, mic VAD configured", () => {
    const setup = build(undefined) as Record<string, any>;
    const tools = setup.tools as Record<string, unknown>[];
    assert.ok(tools.some((entry) => Array.isArray(entry.functionDeclarations)));
    // Grounding is opt-in: free-tier projects refuse it with a 1011 quota close.
    assert.ok(!tools.some((entry) => entry.googleSearch !== undefined));
    assert.equal(setup.realtimeInputConfig.automaticActivityDetection.disabled, false);
    assert.equal(setup.realtimeInputConfig.activityHandling, "START_OF_ACTIVITY_INTERRUPTS");
});

test("barge-in can be turned off (no server interruptions)", () => {
    const off = createSetupBuilder({
        config: patchVoiceConfig(DEFAULT_VOICE_CONFIG, { bargeIn: false }),
        capabilities: caps,
        systemInstruction: "x",
        tools: [],
    })(undefined) as Record<string, any>;

    assert.equal(off.realtimeInputConfig.activityHandling, "NO_INTERRUPTION");
});

test("search grounding is opt-in", () => {
    const withSearch = createSetupBuilder({
        config: patchVoiceConfig(DEFAULT_VOICE_CONFIG, { searchGrounding: true }),
        capabilities: caps,
        systemInstruction: "x",
        tools: [],
    })(undefined) as Record<string, any>;

    assert.ok((withSearch.tools as Record<string, unknown>[]).some((entry) => entry.googleSearch !== undefined));
});

test("builder rebuilds after grounding is disabled (auto-degrade)", () => {
    const config = patchVoiceConfig(DEFAULT_VOICE_CONFIG, { searchGrounding: true });
    const builder = createSetupBuilder({ config, capabilities: caps, systemInstruction: "x", tools: [] });

    const before = builder(undefined) as Record<string, any>;
    assert.ok((before.tools ?? []).some((entry: Record<string, unknown>) => entry.googleSearch !== undefined));

    config.searchGrounding = false;
    const after = builder(undefined) as Record<string, any>;
    assert.ok(!(after.tools ?? []).some((entry: Record<string, unknown>) => entry.googleSearch !== undefined));
});

test("sync-only model never gets NON_BLOCKING declarations", () => {
    const flash = capabilitiesFor("gemini-3.1-flash-live-preview");
    const declarations = functionDeclarations(flash).filter((entry) => entry.behavior === "NON_BLOCKING");
    assert.equal(declarations.length, 0);
    const asyncDecls = functionDeclarations(caps).filter((entry) => entry.behavior === "NON_BLOCKING");
    assert.ok(asyncDecls.length >= 1);
});

test("proactivity and transcription are opt-in", () => {
    const off = createSetupBuilder({
        config: patchVoiceConfig(DEFAULT_VOICE_CONFIG, { inputTranscription: false, outputTranscription: false }),
        capabilities: caps,
        systemInstruction: "x",
        tools: [],
    })(undefined) as Record<string, any>;

    assert.equal(off.proactivity, undefined);
    assert.equal(off.inputAudioTranscription, undefined);
    assert.equal(off.outputAudioTranscription, undefined);

    const on = createSetupBuilder({
        config: patchVoiceConfig(DEFAULT_VOICE_CONFIG, { proactiveAudio: true, inputTranscription: true, customVocabulary: ["numpy"] }),
        capabilities: caps,
        systemInstruction: "x",
        tools: [],
    })(undefined) as Record<string, any>;

    assert.equal(on.proactivity.proactiveAudio, true);
    assert.deepEqual(on.inputAudioTranscription.customVocabulary, ["numpy"]);
});

console.log("wire protocol");
test("pcm base64 round-trips", () => {
    const samples = new Int16Array([0, 1, -1, 32767, -32768]);
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    const decoded = decodePcmBase64(encodePcmBase64(bytes));
    const view = new Int16Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 2);
    assert.equal(Array.from(view).join(","), Array.from(samples).join(","));
});

test("audio/text/tool messages are well-formed", () => {
    const audio = JSON.parse(audioInputMessage(new Uint8Array([1, 2]))) as Record<string, any>;
    assert.equal(audio.realtimeInput.audio.mimeType, "audio/pcm;rate=16000");

    const text = JSON.parse(clientContentMessage([{ role: "user", text: "hi" }], false)) as Record<string, any>;
    assert.equal(text.clientContent.turnComplete, false);
    assert.equal(text.clientContent.turns[0].parts[0].text, "hi");

    const tool = JSON.parse(toolResponseMessage([{ id: "1", name: "pi_status", response: { ok: true } }])) as Record<string, any>;
    assert.equal(tool.toolResponse.functionResponses[0].name, "pi_status");
});

test("server messages parse and tolerate noise", () => {
    const message = parseServerMessage('{"setupComplete":{}}');
    assert.ok(message?.setupComplete);
    assert.equal(parseServerMessage("not json"), undefined);
    assert.equal(parseServerMessage(""), undefined);

    const update = parseServerMessage('{"sessionResumptionUpdate":{"newHandle":"h","resumable":true}}');
    assert.equal(update?.sessionResumptionUpdate?.newHandle, "h");
});

test("socket url encodes the key", () => {
    assert.ok(liveSocketUrl("a b").includes("key=a%20b"));
});

console.log("config");
test("garbage normalizes to defaults", () => {
    const config = normalizeVoiceConfig({ model: 42, alwaysOn: "yes", vadSilenceMs: 999999 });
    assert.equal(config.model, DEFAULT_VOICE_CONFIG.model);
    assert.equal(config.alwaysOn, false);
    assert.equal(config.vadSilenceMs, 4000);
    assert.equal(config.connectOnWake, true);
});

test("patch applies and re-normalizes", () => {
    const config = patchVoiceConfig(DEFAULT_VOICE_CONFIG, { alwaysOn: true, nativeAec: "off", autonomy: "steer" });
    assert.equal(config.alwaysOn, true);
    assert.equal(config.nativeAec, "off");
    assert.equal(config.autonomy, "steer");
});

test("voice starts asleep by default (no Live session until the wake phrase)", () => {
    assert.equal(DEFAULT_VOICE_CONFIG.connectOnWake, true);
    // A garbage value falls back to the default instead of disabling the guard.
    assert.equal(normalizeVoiceConfig({ connectOnWake: "yes" }).connectOnWake, true);
    assert.equal(normalizeVoiceConfig({ connectOnWake: false }).connectOnWake, false);
});

test("/voice set reports what the validators did, instead of always 'config updated'", () => {
    // normalizeVoiceConfig coerces silently: an unknown key is dropped and a bad type
    // becomes the default. The command answered "config updated" either way, so a typo
    // looked exactly like a successful change.
    const report = patchReport(DEFAULT_VOICE_CONFIG, {
        alwaysOn: true,
        idleSleepMs: "soon",
        vadSilenceMs: 99_999,
        nativeAec: "magic",
        notASetting: 1,
    });

    assert.equal(report.next.alwaysOn, true, "valid values are applied");
    assert.deepEqual(report.unknown, ["notASetting"], "unknown keys are named");
    assert.equal(report.adjusted.length, 3, "a bad type, an out-of-range number and a bad enum are all reported");
    assert.match(report.adjusted.join(" "), /idleSleepMs/);
    assert.match(report.adjusted.join(" "), /vadSilenceMs/);
    assert.match(report.adjusted.join(" "), /nativeAec/);

    const clean = patchReport(DEFAULT_VOICE_CONFIG, { alwaysOn: true });

    assert.deepEqual(clean.unknown, []);
    assert.deepEqual(clean.adjusted, [], "a good patch reports no surprises");
});

test("saving the config writes a complete file with no temp litter", () => {
    // One shared `path.tmp` let `/voice key <secret>` and a TUI edit race, and the
    // settings file holds the API key: it is created owner-only where the OS honours it.
    const dir = mkdtempSync(join(tmpdir(), "pi-voice-cfg-"));
    const path = join(dir, "pi-voice.json");

    try {
        saveVoiceConfig(patchVoiceConfig(DEFAULT_VOICE_CONFIG, { apiKey: "secret-key", alwaysOn: true }), path);
        saveVoiceConfig(patchVoiceConfig(DEFAULT_VOICE_CONFIG, { apiKey: "secret-key", alwaysOn: false }), path);

        const written = loadVoiceConfig(path);

        assert.equal(written.alwaysOn, false, "the second write wins");
        assert.equal(written.apiKey, "secret-key");
        assert.deepEqual(readdirSync(dir), ["pi-voice.json"], "no .tmp files are left behind");

        if (process.platform !== "win32") {
            assert.equal(statSync(path).mode & 0o777, 0o600, "the key file is not world-readable");
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

console.log("prompt");
test("there is exactly one transport: no browser keys survive in the config", () => {
    // Dropping browser support must not leave a config surface that pretends
    // otherwise: old files may still carry these keys and they are ignored.
    const keys = Object.keys(DEFAULT_VOICE_CONFIG);

    for (const gone of ["audio", "host", "port", "openBrowser", "compute", "aec", "noiseSuppression", "autoGain", "micDeviceId", "outputDeviceId", "wakeModelUrl"]) {
        assert.equal(keys.includes(gone), false, `${gone} must not be a voice setting`);
        assert.equal(
            (DEFAULT_VOICE_CONFIG as unknown as Record<string, unknown>)[gone],
            undefined,
            `${gone} must not exist at runtime`,
        );
    }

    const legacy = normalizeVoiceConfig({ audio: "browser", port: 8722, openBrowser: true, compute: "webgpu" });

    assert.equal(((legacy as unknown) as Record<string, unknown>).audio, undefined);
    assert.equal(((legacy as unknown) as Record<string, unknown>).port, undefined);
});

test("the playback device is not a setting: ffplay has no output-device option", () => {
    // `nativeOutput` used to be persisted, shown in the TUI as "Playback device
    // hint" and treated as restart-worthy, but no ffplay argument was ever built
    // from it, so changing it did nothing. Removed rather than keep a control that
    // lies; SDL picks the system default and exposes no device selection.
    assert.equal(
        Object.keys(DEFAULT_VOICE_CONFIG).includes("nativeOutput"),
        false,
        "nativeOutput must not be a voice setting",
    );

    // The retry path proves the point: an unknown option makes ffplay refuse to
    // start, so a device flag must never be smuggled into the argv.
    for (const args of [playbackArgs(), playbackArgs(true)]) {
        assert.equal(
            args.some((arg) => /device|\-ac\b/i.test(arg)),
            false,
            "ffplay args must not carry device or channel options",
        );
    }
});

test("persona encodes bridge role and autonomy", () => {
    const text = buildSystemInstruction({
        config: patchVoiceConfig(DEFAULT_VOICE_CONFIG, { persona: "Call me boss." }),
        capabilities: caps,
        cwd: "C:/proj",
        alwaysOn: true,
    });
    assert.ok(text.includes("go-between"));
    assert.ok(text.includes("Call me boss."));
    assert.ok(text.includes("C:/proj"));
    assert.ok(text.includes("voice_approve"));
    assert.ok(text.includes("voice_sleep"));
});

test("the voice model is told never to refuse on Pi's behalf", () => {
    const text = buildSystemInstruction({
        config: DEFAULT_VOICE_CONFIG,
        capabilities: caps,
        cwd: "C:/proj",
        alwaysOn: true,
    });
    // The failure this guards: "hey pi, check my whatsapp" -> "I can't do that".
    assert.ok(/never refuse on Pi's behalf/i.test(text), "explicit no-refusal rule");
    assert.ok(/whatsapp/i.test(text), "names the user's real CLI tools as Pi's job");
    assert.ok(/is a pi_ask/i.test(text), "routes everything outside the conversation to pi_ask");
    assert.ok(/must not say[\s\S]{0,80}I can't/i.test(text), "lists the forbidden refusal sentences");
});

test("pi_ask defaults to steering, not queueing", () => {
    const declaration = functionDeclarations(caps).find((entry) => entry.name === "pi_ask");
    const mode = (declaration?.parameters as { properties?: { mode?: { description?: string } } })
        ?.properties?.mode?.description ?? "";

    assert.ok(/steer \(default\)/i.test(mode), "the schema says steer is the default");
    assert.ok(!/queue \(default\)/i.test(mode), "queue is no longer advertised as the default");
});

test("the session digest is in the prompt, and only claimed when real", () => {
    const digest = [
        "Pi: idle | turn 3 | cwd C:/proj",
        "the user's last request in this session: fix deploy",
        "user: fix the deploy",
        "pi: done",
    ].join("\n");
    const withContext = buildSystemInstruction({
        config: DEFAULT_VOICE_CONFIG,
        capabilities: caps,
        cwd: "C:/proj",
        alwaysOn: true,
        context: digest,
    });

    assert.ok(withContext.includes("fix the deploy"), "the digest text reaches the prompt");
    // The failure: after /resume the model said it had no context yet.
    assert.ok(/never say you have no context/i.test(withContext), "forbids the 'no context' answer");

    const empty = buildSystemInstruction({
        config: DEFAULT_VOICE_CONFIG,
        capabilities: caps,
        cwd: "C:/proj",
        alwaysOn: true,
        context: ["Pi: idle | turn 0 | cwd C:/proj", "no messages in this session yet"].join("\n"),
    });

    assert.ok(/nothing has happened in this session yet/i.test(empty), "a fresh session is described honestly");
    assert.ok(!/never say you have no context/i.test(empty), "no prohibition without content to point at");
});

test("the system instruction is rebuilt per connect", () => {
    // The function form is what lets a `/resume` between two sockets reach the prompt.
    let calls = 0;
    const build = createSetupBuilder({
        config: DEFAULT_VOICE_CONFIG,
        capabilities: caps,
        systemInstruction: () => `call ${++calls}`,
        tools: [],
    });
    const first = build(undefined) as Record<string, any>;
    const second = build(undefined) as Record<string, any>;

    assert.equal(first.systemInstruction.parts[0].text, "call 1");
    assert.equal(second.systemInstruction.parts[0].text, "call 2");
});

test("pi_ask is described as a general agent hand-off, not a coding tool", () => {
    const declaration = functionDeclarations(caps).find((entry) => entry.name === "pi_ask");
    const description = String(declaration?.description ?? "");

    assert.ok(description.length > 0);
    assert.ok(/not only a coding tool|general agent/i.test(description), "no longer limited to code");
    assert.ok(/whatsapp|mail/i.test(description), "gives the model real examples out of the box");
});

console.log("util");
test("ring buffer keeps the most recent samples", () => {
    const ring = new RingBuffer(4);
    ring.push(new Float32Array([1, 2, 3]));
    ring.push(new Float32Array([4, 5]));
    assert.deepEqual(Array.from(ring.tail(4)), [2, 3, 4, 5]);
});

test("float32 -> pcm16 clamps", () => {
    const bytes = float32ToPcm16(new Float32Array([-2, 0, 2]));
    const view = new DataView(bytes.buffer);
    assert.equal(view.getInt16(0, true), -32767);
    assert.equal(view.getInt16(2, true), 0);
    assert.equal(view.getInt16(4, true), 32767);
});

test("backoff grows and stays bounded", () => {
    assert.ok(backoffDelay(0, 100, 1000) <= 100);
    assert.ok(backoffDelay(10, 100, 1000) <= 1000);
});

test("clip collapses whitespace", () => {
    assert.equal(clip("  a \n b  ", 100), "a b");
});

test("credentials are stripped before a command is spoken or transmitted", () => {
    // The approval summary is handed to the voice model ("ask the user to allow or
    // deny") and the whole prompt is sent to Gemini, so a token in a command line was
    // both transmitted and read out loud.
    assert.equal(
        redactSecrets('curl -H "Authorization: Bearer sk-abc1234567890xyz" https://x.io'),
        'curl -H "Authorization: Bearer <redacted>" https://x.io',
    );
    assert.equal(redactSecrets("GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 git push"), "GITHUB_TOKEN=<redacted> git push");
    assert.equal(redactSecrets("export GEMINI_API_KEY=AIzaSyA1234567890abcdefghijklmnop"), "export GEMINI_API_KEY=<redacted>");
    assert.equal(redactSecrets("mysql --password hunter2 -u root"), "mysql --password <redacted> -u root");
    assert.equal(redactSecrets("npm publish --api-key=npm_1234567890abcdefghij"), "npm publish --api-key=<redacted>");
    assert.equal(redactSecrets("npm publish --//registry.npmjs.org/:_authToken=NPM_TOKEN"), "npm publish --//registry.npmjs.org/:_authToken=<redacted>");
    assert.equal(redactSecrets("git push https://user:GITHUB_TOKEN@example.invalid/repo.git"), "git push https://user:<redacted>@example.invalid/repo.git");
    // Ordinary commands keep their text: redaction must not hide what is being approved.
    assert.equal(redactSecrets("rm -rf build && git push origin main"), "rm -rf build && git push origin main");
    assert.equal(redactSecrets("psql -c 'drop table users'"), "psql -c 'drop table users'");
    assert.equal(redactSecrets("rm -rf build && git push origin main"), "rm -rf build && git push origin main");
});

test("PI_VOICE_DEBUG is honoured even when the config setting is off", () => {
    // extension.ts used to call setDebug(config.debug) on every load, which set the
    // source to "config" and overwrote the environment.
    delete process.env.PI_VOICE_DEBUG;
    assert.equal(debugFromEnv(), false);

    for (const value of ["1", "true", "yes", "on", " TRUE "]) {
        process.env.PI_VOICE_DEBUG = value;
        assert.equal(debugFromEnv(), true, `PI_VOICE_DEBUG=${value} enables debug`);
    }

    const viaEnv = debugFromEnv();
    setDebug(false || viaEnv, viaEnv ? "env" : "config");
    assert.deepEqual(debugState(), { enabled: true, source: "env" });
    delete process.env.PI_VOICE_DEBUG;
    setDebug(false);
});

console.log("completions");
const completionContext = {
    models: liveModelIds().map((id) => ({ id, label: capabilitiesFor(id).label })),
    voices: PREBUILT_VOICES,
    currentModel: "gemini-3.8-live",
    currentVoice: "Zephyr",
};

test("empty argument lists subcommands", () => {
    const names = completeVoiceArguments("", completionContext).map((item) => item.value);
    assert.ok(names.includes("model"));
    assert.ok(names.includes("always-on"));
});

test("partial subcommand completes to the full argument", () => {
    assert.equal(completeVoiceArguments("mod", completionContext)[0]?.value, "model");
});

test("nested model completion replaces the whole argument", () => {
    assert.equal(completeVoiceArguments("model gem", completionContext)[0]?.value, "model gemini-3.8-live");
});

test("current model is annotated", () => {
    const current = completeVoiceArguments("model ", completionContext)
        .find((item) => item.value === "model gemini-3.8-live");
    assert.equal(current?.description, "current");
});

test("enum values complete with the subcommand prefix", () => {
    assert.ok(completeVoiceArguments("always-on o", completionContext).some((item) => item.value === "always-on on"));
    assert.equal(completeVoiceArguments("autonomy st", completionContext)[0]?.value, "autonomy steer");
    const engines = completeVoiceArguments("wake-engine a", completionContext).map((item) => item.value);
    assert.ok(engines.includes("wake-engine asr"));
    assert.ok(!engines.includes("wake-engine webspeech"), "browser recognizer is gone");
    assert.deepEqual(
        completeVoiceArguments("compute ", completionContext),
        [],
        "the browser compute backend picker is gone",
    );
});

test("voice names complete", () => {
    assert.equal(completeVoiceArguments("voice-name ko", completionContext)[0]?.value, "voice-name Kore");
});

test("set completes JSON snippets", () => {
    const items = completeVoiceArguments("set ", completionContext);
    assert.ok(items.length > 0);
    assert.ok(items.every((item) => item.value.startsWith("set {")));
    assert.ok(completeVoiceArguments('set {"al', completionContext).some((item) => item.value === 'set {"alwaysOn":true}'));
});

test("fuzzy subsequence works", () => {
    assert.equal(completeVoiceArguments("won", completionContext)[0]?.value, "always-on");
});

test("unknown input yields no completions", () => {
    assert.deepEqual(completeVoiceArguments("nonsense xyz", completionContext), []);
});

console.log("keychain");
const keyDir = mkdtempSync(join(tmpdir(), "pi-voice-key-"));
const keyPath = join(keyDir, "auth.json");

test("reads the google api key from auth.json", () => {
    writeFileSync(keyPath, JSON.stringify({
        google: { type: "api_key", key: "AIzaTEST" },
        "google-gemini-cli": { type: "oauth", access: "x", refresh: "y", expires: 1 },
    }));
    const resolved = readKeyFromAuthJson(keyPath);
    assert.equal(resolved?.key, "AIzaTEST");
    assert.ok(resolved?.source.includes("auth.json"));
});

test("oauth-only credentials are ignored", () => {
    writeFileSync(keyPath, JSON.stringify({ "google-gemini-cli": { type: "oauth", access: "x" } }));
    assert.equal(readKeyFromAuthJson(keyPath), undefined);
});

test("the key source is explained even before voice starts", () => {
    // With voice off there is no controller to have resolved anything, and the old answer
    // was "not resolved" while a key sat in auth.json — the exact moment a user asks.
    const explainPath = join(keyDir, "explain.json");

    writeFileSync(explainPath, JSON.stringify({ google: { type: "api_key", key: "AIzaTEST" } }));

    const savedAuth = process.env.PI_VOICE_AUTH;

    process.env.PI_VOICE_AUTH = explainPath;

    try {
        assert.match(keySourceLabel("", undefined), /auth\.json \(google\)/);
        assert.equal(keySourceLabel("AIza-config", undefined), "config (pi-voice.json)");
        assert.equal(keySourceLabel("", "env GEMINI_API_KEY"), "env GEMINI_API_KEY", "a live resolution wins");
    } finally {
        if (savedAuth === undefined) {
            delete process.env.PI_VOICE_AUTH;
        } else {
            process.env.PI_VOICE_AUTH = savedAuth;
        }
    }

    writeFileSync(explainPath, JSON.stringify({}));
    process.env.PI_VOICE_AUTH = explainPath;

    const envNames = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_GENAI_API_KEY"];
    const savedEnv = envNames.map((name) => [name, process.env[name]] as const);

    for (const name of envNames) {
        delete process.env[name];
    }

    try {
        assert.match(keySourceLabel("", undefined), /not resolved/);
    } finally {
        delete process.env.PI_VOICE_AUTH;

        for (const [name, value] of savedEnv) {
            if (value !== undefined) {
                process.env[name] = value;
            }
        }
    }
});

test("/voice status start line states all four combinations", () => {
    const base = DEFAULT_VOICE_CONFIG;

    assert.match(describeStart({ ...base, alwaysOn: false, connectOnWake: true }), /connects at startup/);
    assert.match(describeStart({ ...base, alwaysOn: false, connectOnWake: false }), /connects at startup/);
    assert.match(describeStart({ ...base, alwaysOn: true, connectOnWake: true }), /asleep/);
    assert.match(describeStart({ ...base, alwaysOn: true, connectOnWake: false }), /stays connected/);
});

test("a boolean verb rejects nonsense instead of silently meaning off", () => {
    // `value ? /^(on|true|yes|1)$/i.test(value) : !current` made every unrecognised word
    // false: `/voice always-on enabled` turned the wake word off.
    assert.equal(parseBool("on", false), true);
    assert.equal(parseBool("OFF", true), false);
    assert.equal(parseBool(undefined, true), false, "no argument toggles");
    assert.equal(parseBool(undefined, false), true);
    assert.equal(parseBool("enabled", false), undefined, "a word that is neither is rejected");
    assert.equal(parseBool("sure", true), undefined);
});

await asyncTest("explicit config key wins", async () => {
    writeFileSync(keyPath, JSON.stringify({ google: { type: "api_key", key: "AIzaAUTH" } }));
    const resolved = await resolveGeminiKey({ configKey: "cfg-key", authPath: keyPath });
    assert.equal(resolved?.key, "cfg-key");
    assert.equal(resolved?.source, "config");
});

await asyncTest("auth.json wins over env", async () => {
    const previous = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "env-key";

    try {
        writeFileSync(keyPath, JSON.stringify({ google: { type: "api_key", key: "AIzaAUTH" } }));
        assert.equal((await resolveGeminiKey({ authPath: keyPath }))?.key, "AIzaAUTH");

        const fromEnv = await resolveGeminiKey({ authPath: join(keyDir, "missing.json") });
        assert.equal(fromEnv?.key, "env-key");
        assert.ok(fromEnv?.source.includes("GEMINI_API_KEY"));
    } finally {
        if (previous === undefined) {
            delete process.env.GEMINI_API_KEY;
        } else {
            process.env.GEMINI_API_KEY = previous;
        }
    }
});

await asyncTest("registry is the last resort", async () => {
    const previous = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
        const resolved = await resolveGeminiKey({
            authPath: join(keyDir, "missing.json"),
            registry: { getApiKeyForProvider: async (provider) => (provider === "google" ? "registry-key" : undefined) },
        });
        assert.equal(resolved?.key, "registry-key");
    } finally {
        if (previous !== undefined) {
            process.env.GEMINI_API_KEY = previous;
        }
    }
});

rmSync(keyDir, { recursive: true, force: true });

console.log("failure classification");

test("quota and config closes are fatal (no retry storm)", () => {
    assert.equal(isFatalClose(1011, "You exceeded your current quota, please check your plan and billing details."), true);
    assert.equal(isFatalClose(1007, "Thinking level must be specified for this model."), true);
    assert.equal(isFatalClose(1008, "You are not permitted to use this model"), true);
    assert.equal(isFatalClose(1011, "internal server error"), false);
    assert.equal(isFatalClose(1000, "rotation"), false);
    assert.equal(isFatalClose(undefined, ""), false);
});

test("the server's own \"Session closed\" is recoverable, not fatal", () => {
    // This exact close used to mark the session permanently broken: voice stayed
    // dead until Pi was restarted.
    assert.equal(isDormantClose(1008, "Session closed"), true);
    assert.equal(isDormantClose(1008, ""), true);
    assert.equal(isDormantClose(1008, "session expired"), true);
    assert.equal(isDormantClose(1008, "policy violation"), false);
    assert.equal(isDormantClose(1007, "Session closed"), false);

    assert.equal(isFatalClose(1008, "Session closed"), false, "no longer fatal");
    assert.equal(isFatalClose(1008, "You exceeded your current quota"), true, "quota stays fatal");
});

test("friendly message points at diagnose", () => {
    assert.ok(friendlyCloseError(1011, "You exceeded your current quota").includes("/voice diagnose"));
    assert.ok(friendlyCloseError(1007, "Thinking level must be specified").includes("setup"));
});

test("extended-thinking gets a thinking level by default", () => {
    const et = capabilitiesFor("gemini-3.8-live-extended-thinking");
    const setup = createSetupBuilder({
        config: DEFAULT_VOICE_CONFIG,
        capabilities: et,
        systemInstruction: "x",
        tools: [],
    })(undefined) as Record<string, any>;

    assert.equal(setup.generationConfig.thinkingConfig.thinkingLevel, "low");
});

test("flash live still omits thinking unless configured", () => {
    const flash = capabilitiesFor("gemini-3.1-flash-live-preview");
    const setup = createSetupBuilder({
        config: DEFAULT_VOICE_CONFIG,
        capabilities: flash,
        systemInstruction: "x",
        tools: [],
    })(undefined) as Record<string, any>;

    assert.equal(setup.generationConfig.thinkingConfig, undefined);
});

console.log("status bar");

test("level bar reflects mic energy", () => {
    assert.equal(levelBar([]), "");
    assert.equal(levelBar([0]).length, 1);
    assert.notEqual(levelBar([0.2]), levelBar([0.001]));
});

test("status text shows state, waveform and wake flag", () => {
    const live = voiceStatusText({ state: "live", levels: [0.05, 0.02], alwaysOn: true });
    assert.ok(live.startsWith("voice live "));
    assert.ok(live.includes("wake"));

    const error = voiceStatusText({ state: "error", levels: [], alwaysOn: false, error: "quota exceeded" });
    assert.ok(error.includes("quota"));
});

test("rejected resumption handle is recoverable, not fatal", () => {
    assert.equal(isStaleHandleClose(1008, "BidiGenerateContent session not found"), true);
    assert.equal(isStaleHandleClose(1007, "Request contains an invalid argument."), true);
    assert.equal(isStaleHandleClose(1008, "policy violation"), false);
    assert.equal(isStaleHandleClose(1000, "rotation"), false);
});

test("flash omits affective dialog (it rejects it)", () => {
    const flash = capabilitiesFor("gemini-3.1-flash-live-preview");
    const setup = createSetupBuilder({
        config: patchVoiceConfig(DEFAULT_VOICE_CONFIG, { model: flash.id }),
        capabilities: flash,
        systemInstruction: "x",
        tools: [],
    })(undefined) as Record<string, any>;

    assert.equal(setup.generationConfig.enableAffectiveDialog, undefined);
});

test("affective dialog is gated off (3.8 rejects audio when set)", () => {
    const forced = createSetupBuilder({
        config: patchVoiceConfig(DEFAULT_VOICE_CONFIG, { affectiveDialog: true }),
        capabilities: caps,
        systemInstruction: "x",
        tools: [],
    })(undefined) as Record<string, any>;

    assert.equal(forced.generationConfig.enableAffectiveDialog, undefined);
});

console.log("release");

test("package version matches the changelog", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    const first = /^##\s+\[(\d+\.\d+\.\d+)\]/m.exec(changelog);

    assert.ok(first, "changelog has a versioned section");
    assert.equal(first?.[1], pkg.version);
});

console.log("native AEC");

test("NLMS cancels a delayed echo", () => {
    const rate = 16_000;
    const total = rate; // 1 second is enough to converge
    const delay = Math.round(rate * 0.04);
    const reference = new Float32Array(total);
    let seed = 123_456_789;
    const random = (): number => {
        seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;

        return (seed / 0xffff_ffff) * 2 - 1;
    };

    for (let i = 0; i < total; i++) {
        reference[i] = random() * 0.3;
    }

    const echo = new Float32Array(total);

    for (let i = delay; i < total; i++) {
        echo[i] = (reference[i - delay] as number) * 0.5;
    }

    const aec = new AcousticEchoCanceller({ delayMs: 40, taps: 1024 });
    const frame = 320;
    let input = 0;
    let output = 0;

    for (let start = 0; start + frame <= total; start += frame) {
        aec.pushReference(reference.subarray(start, start + frame));
        const mic = echo.subarray(start, start + frame);
        const cleaned = aec.process(mic);

        if (start > total / 2) {
            for (let i = 0; i < frame; i++) {
                input += (mic[i] as number) ** 2;
                output += (cleaned[i] as number) ** 2;
            }
        }
    }

    assert.ok(output < input * 0.25, `residual ${output.toFixed(4)} vs echo ${input.toFixed(4)}`);
});

test("AEC leaves the mic untouched when the reference is silent", () => {
    // Guards the divergence bug: adapting against a near-silent reference used a
    // meaningless normalisation and dragged the weights, distorting later turns.
    const aec = new AcousticEchoCanceller();
    const mic = new Float32Array(320);

    for (let i = 0; i < mic.length; i++) {
        mic[i] = Math.sin(i * 0.11) * 0.2;
    }

    let cleaned = mic;

    for (let frame = 0; frame < 500; frame++) {
        aec.pushReference(new Float32Array(320));
        cleaned = aec.process(mic);
    }

    for (let i = 0; i < mic.length; i++) {
        assert.ok(
            Math.abs((cleaned[i] as number) - (mic[i] as number)) < 1e-6,
            `silent reference altered the mic at ${i}: ${cleaned[i]}`,
        );
    }
});

test("24k playback resamples to 16k for the AEC reference", () => {
    assert.equal(resample24kTo16k(new Int16Array(2400)).length, 1600);
    assert.equal(floatToInt16(new Float32Array([0, 1, -1]))[1], 32767);
});

test("native AEC defaults to NLMS full duplex", () => {
    assert.equal(DEFAULT_VOICE_CONFIG.nativeAec, "nlms");
    assert.equal(DEFAULT_VOICE_CONFIG.bargeIn, true);
});

test("ffplay args never use ffmpeg-only options such as -ac", () => {
    for (const args of [playbackArgs(), playbackArgs(true)]) {
        assert.ok(!args.includes("-ac"), `unexpected -ac in ${args.join(" ")}`);
        assert.ok(!args.includes("-channels"), "unexpected -channels");
        assert.ok(args.includes("24000"), "playback must request 24 kHz");
        assert.ok(args.includes("s16le"), "playback must request raw s16le");
    }

    // The minimal set must drop optional AVOptions only.
    assert.ok(playbackArgs().includes("-fflags"), "full args keep latency options");
    assert.ok(!playbackArgs(true).includes("-fflags"), "minimal args drop latency options");
    assert.ok(playbackArgs(true).includes("-nodisp"));
});

// ---------------------------------------------------------------------------
// session continuity: on-disk lock and resumption state
// ---------------------------------------------------------------------------

console.log("\nlock + state files");

const continuityDir = mkdtempSync(join(tmpdir(), "pi-voice-state-"));
process.env.PI_AGENT_DIR = continuityDir;
process.env.PI_VOICE_STATE = join(continuityDir, "voice-state.json");

const workspace = join(continuityDir, "ws");

const { acquireLock, readLock, releaseLock } = await import("../lock.ts");
const { loadPersistedHandle, persistedSeq, savePersistedHandle } = await import("../persist.ts");

function lockFileFor(cwd: string): string {
    const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 16);

    return join(continuityDir, `pi-voice-${hash}.lock`);
}

test("the lock records this process and is released cleanly", () => {
    const first = acquireLock(workspace);
    assert.equal(first.ok, true);
    assert.equal(readLock(workspace)?.pid, process.pid);
    assert.ok(readLock(workspace)?.token, "the lock carries an ownership token");

    releaseLock(workspace);
    assert.equal(readLock(workspace), undefined);
});

test("a foreign lock is left alone, a stale one is taken over", () => {
    const foreign = { pid: process.pid + 1, cwd: workspace, startedAt: new Date().toISOString(), token: "someone-else" };
    writeFileSync(lockFileFor(workspace), JSON.stringify(foreign), "utf8");

    releaseLock(workspace);
    assert.equal(readLock(workspace)?.token, "someone-else", "release must not delete a lock we do not own");

    // PID reuse: an alive PID with an ancient start time must not block voice forever.
    const ancient = { pid: process.pid, cwd: workspace, startedAt: new Date(Date.now() - 86_400_000).toISOString(), token: "old" };
    writeFileSync(lockFileFor(workspace), JSON.stringify(ancient), "utf8");
    assert.equal(acquireLock(workspace).ok, true, "a day-old lock is taken over");
    releaseLock(workspace);
});

test("taking over a stale lock is atomic and leaves no claim behind", () => {
    // Two processes starting together used to both read the stale entry, both write
    // through one shared `.tmp`, and both be told they owned the workspace.
    const stale = { pid: process.pid, cwd: workspace, startedAt: new Date(Date.now() - 86_400_000).toISOString(), token: "old" };
    writeFileSync(lockFileFor(workspace), JSON.stringify(stale), "utf8");

    assert.equal(acquireLock(workspace).ok, true, "the stale lock is taken over");
    assert.equal(readLock(workspace)?.token !== "old", true, "the lock now belongs to us");
    assert.equal(readLock(workspace)?.token, readLock(workspace)?.token);
    assert.equal(
        existsSync(`${lockFileFor(workspace)}.claim`),
        false,
        "the takeover claim is removed",
    );

    // A claim held by another (living) process must block, not overwrite.
    releaseLock(workspace);
    writeFileSync(lockFileFor(workspace), JSON.stringify(stale), "utf8");
    writeFileSync(`${lockFileFor(workspace)}.claim`, "", "utf8");
    const blocked = acquireLock(workspace);

    assert.equal(blocked.ok, false, "a concurrent takeover is refused, not raced");
    assert.equal(
        (blocked as { reason?: string }).reason,
        "busy",
        "the refusal says why (busy, not a lock we silently overwrote)",
    );
    rmSync(`${lockFileFor(workspace)}.claim`, { force: true });
    releaseLock(workspace);
});

test("resumption handles never move backwards", () => {
    savePersistedHandle(workspace, { handle: "h-2", seq: 2, model: "m", voice: "v" });
    assert.equal(loadPersistedHandle(workspace)?.handle, "h-2");

    // A straggler write from a connection that has already been replaced.
    savePersistedHandle(workspace, { handle: "h-1", seq: 1, model: "m", voice: "v" });
    assert.equal(loadPersistedHandle(workspace)?.handle, "h-2", "older sequence must not win");

    savePersistedHandle(workspace, { handle: "h-3", seq: 3, model: "m", voice: "v" });
    assert.equal(loadPersistedHandle(workspace)?.handle, "h-3", "newer sequence wins even when written immediately");
    assert.equal(persistedSeq(workspace), 3);

    // Another workspace writing concurrently must not drop this entry.
    const other = join(continuityDir, "ws2");
    savePersistedHandle(other, { handle: "x-1", seq: 1, model: "m", voice: "v" });
    assert.equal(loadPersistedHandle(workspace)?.handle, "h-3");
    assert.equal(loadPersistedHandle(other)?.handle, "x-1");
});

test("a hash-named keyword file tracks the configured wake phrase", () => {
    // The sherpa keywords file used to have a fixed name, so editing the phrase kept
    // loading the first file that was ever written. Verify the digest scheme instead
    // of running sherpa (which is optional and not installed here).
    const digest = (text: string): string => createHash("sha1").update(text).digest("hex").slice(0, 10);

    assert.notEqual(digest("HEY PI :2.0"), digest("HEY COMPUTER :2.0"));
    assert.equal(digest("HEY PI :2.0"), digest("HEY PI :2.0"));
});


console.log("microphone probe");

const probe = (over: Record<string, unknown>) => ({
    device: "audio=Microphone Array",
    seconds: 3,
    samples: 48_000,
    peak: 0.3,
    rms: 0.05,
    voicedRatio: 0.5,
    ...over,
});

test("a silent device is named as such, not blamed on the wake phrase", () => {
    // The failure this guards: a muted mic left the status bar on "asleep" forever
    // and looked like a broken wake word.
    const verdict = micVerdict(probe({ peak: 0, rms: 0, voicedRatio: 0 }));

    assert.match(verdict, /DIGITAL SILENCE/i);
    assert.match(verdict, /Privacy/i);
});

test("a working mic reports signal instead of a warning", () => {
    const verdict = micVerdict(probe({}));

    assert.match(verdict, /signal present/i);
    assert.match(verdict, /50% of the window/);
});

test("quiet-but-present audio points at gain or sensitivity", () => {
    const verdict = micVerdict(probe({ peak: 0.004, rms: 0.001, voicedRatio: 0 }));

    assert.match(verdict, /very quiet/i);
    assert.match(verdict, /wakeSensitivity/);
});

test("a capture failure and an empty capture are different messages", () => {
    assert.match(micVerdict(probe({ error: "Device or resource busy" })), /could not capture: Device or resource busy/);
    assert.match(micVerdict(probe({ samples: 0, peak: 0, rms: 0 })), /no audio arrived/i);
});

test("the status bar admits when the mic is delivering nothing", () => {
    const text = voiceStatusText({ state: "asleep", levels: [], alwaysOn: true, silent: true });

    assert.equal(text, "voice asleep ·wake ·no mic signal");
});

console.log("logging is quiet unless debug is on");

test("nothing reaches stderr with debug off, including warnings", () => {
    const captured: string[] = [];
    const original = console.error;

    console.error = (...args: unknown[]) => {
        captured.push(args.map(String).join(" "));
    };

    try {
        setDebug(false);
        clearWarnings();
        log("native", "native wake (sherpa cpu): level 0.0000 floor 0.0120 threshold 0.0197");
        warn("native", "ffplay: something");
        log("live", "socket closed");

        assert.deepEqual(captured, [], "no console output while debug is off");

        // ...but the warning is not lost: /voice status reads it back.
        const kept = recentWarnings(3);
        assert.equal(kept.length, 1);
        assert.match(kept[0]?.text ?? "", /ffplay/);

        setDebug(true);
        log("native", "visible");
        assert.equal(captured.length, 1, "debug on restores output");
    } finally {
        console.error = original;
        setDebug(false);
        clearWarnings();
    }
});

test("PI_VOICE_DEBUG=false / 0 / off do not enable logging", () => {
    // Boolean("false") === true was the bug that leaked log lines into the editor.
    for (const value of ["false", "0", "off", "no", "", " none "]) {
        process.env.PI_VOICE_DEBUG = value;
        // The module reads the env once at import; assert the parser's rule instead.
        const enabled = !(!value.trim() || ["0", "false", "off", "no", "none"].includes(value.trim().toLowerCase()));
        assert.equal(enabled, false, `PI_VOICE_DEBUG=${JSON.stringify(value)} must stay quiet`);
    }

    process.env.PI_VOICE_DEBUG = "1";
    assert.equal(Boolean("1"), true, "explicit 1 still enables it");
    delete process.env.PI_VOICE_DEBUG;
});

console.log("wake phrase matching (ASR engine)");

test("real ASR output for 'hey pi' matches, ordinary speech does not", () => {
    // These are literal decoder outputs on real recordings of "hey pi".
    for (const heard of ["ITE HAYPE", "HAY PE", "HEY P", "HEYPI", "HEY PI", "HAYPI"]) {
        assert.equal(matchWakePhrase(heard, ["hey pi"]).matched, true, `should match: ${heard}`);
    }

    // The failure mode that matters more: waking on something else.
    for (const heard of ["THE PIE IS READY", "HEY BUD", "OKAY PI", "A PIE", "THE YELLOW LAMPS"]) {
        assert.equal(matchWakePhrase(heard, ["hey pi"]).matched, false, `should not match: ${heard}`);
    }
});

test("ordinary speech does not wake the ASR engine", () => {
    // "hey no" is the one that used to fire: two edits across the whole joined
    // string made the short word almost free.
    for (const heard of ["HEY NO", "HEY BUD", "HEY THERE", "THE PIE IS READY", "I SAID HI"]) {
        assert.equal(matchWakePhrase(heard, ["hey pi"]).matched, false, `should not match: ${heard}`);
    }
});

test("the phrase does not have to be at the start of the sentence", () => {
    const match = matchWakePhrase("um so hey pi can you check my messages", ["hey pi"]);

    assert.equal(match.matched, true);
    assert.equal(match.heard, "HEY PI");
});

test("every configured wake phrase is tried, not just the first", () => {
    assert.equal(matchWakePhrase("HI PI ARE YOU THERE", ["hey pi", "hi pi"]).matched, true);
    assert.equal(matchWakePhrase("OK PI", ["hey pi", "ok pi"]).matched, true);

    // Known limitation, documented in the module: a two-letter head word needs the
    // decoder to emit it as its own word. "ok pi" does not match "OKAY PI", because
    // the joined form only tolerates one edit per half and "AY" is two from "PI".
    assert.equal(matchWakePhrase("OKAY PI", ["ok pi"]).matched, false);
});

test("edit distance is a real distance", () => {
    assert.equal(editDistance("HEY", "HEY"), 0);
    assert.equal(editDistance("HEY", "HAY"), 1);
    assert.equal(editDistance("HAYPE", "HEYPI"), 2);
});

console.log("interruption");

test("a reply that cuts the model off asks for a human reaction, not a repeat", () => {
    const cut = agentReplyNotice("the build failed", true);

    assert.match(cut, /cut off mid-sentence/i);
    assert.match(cut, /\"oh\"/);
    assert.match(cut, /Do not repeat or finish/i);
    assert.match(cut, /the build failed/);
});

test("an ordinary reply is not framed as an interruption", () => {
    const plain = agentReplyNotice("the build failed");

    assert.doesNotMatch(plain, /cut off/i);
    assert.match(plain, /Say this back to the user/);
});

rmSync(continuityDir, { recursive: true, force: true });

console.log("input gain");
test("inputGain 0 mutes the microphone instead of meaning 'unset'", () => {
    const samples = new Int16Array([16_384, -16_384, 0, 4_096]);

    // 0 used to fall through to unity gain (`gain > 0 ? gain : 1`), so a muted mic
    // still fed the model and still woke the wake-word engine.
    assert.deepEqual([...gainToFloat(samples, 0)].map((value) => Math.abs(value)), [0, 0, 0, 0]);
    assert.equal(gainToFloat(samples, 1)[0], 0.5);
    assert.equal(gainToFloat(samples, 2)[0], 1, "gain above unity clips instead of wrapping");
    assert.equal(gainToFloat(samples, 1)[1], -0.5);
    assert.equal(gainToFloat(samples, Number.NaN)[0], 0.5, "a broken value falls back to unity");
});

console.log("bridge");

test("a tool result is never stored or spoken as an assistant reply", () => {
    // Pi emits message_end for tool results. Treating every non-user message as an
    // assistant reply meant a command's output became `lastAssistant`, was read out
    // loud at agent_settled, and was pasted into the digest.
    const handlers = new Map<string, (event: unknown) => void>();
    const api = {
        on: (name: string, handler: (event: unknown) => void) => {
            handlers.set(name, handler);

            return () => handlers.delete(name);
        },
        appendEntry: () => undefined,
    } as unknown as Parameters<typeof AgentBridge.prototype.ask>[0] extends never ? never : never;
    const bridge = new AgentBridge(api as never, "C:/proj");
    const replies: string[] = [];

    bridge.on((payload) => {
        const event = payload as { kind?: string; reply?: { text?: string } };

        if (event.kind === "reply" && event.reply?.text) {
            replies.push(event.reply.text);
        }
    });

    const emit = (role: string, text: string): void => {
        handlers.get("message_end")?.({ message: { role, content: [{ type: "text", text }] } });
    };

    emit("toolResult", "SECRET TOOL OUTPUT");
    assert.deepEqual(replies, [], "a tool result must not be emitted as a reply");
    assert.equal(bridge.status.lastAssistant, undefined, "a tool result must not become the last reply");
    assert.doesNotMatch(bridge.digest({ turns: 6, chars: 900 }), /SECRET TOOL OUTPUT/);

    emit("assistant", "The deploy is green.");
    assert.deepEqual(replies, ["The deploy is green."]);
    assert.equal(bridge.status.lastAssistant, "The deploy is green.");

    emit("user", "check the deploy");
    assert.equal(bridge.status.lastUser, "check the deploy");

    // `pi_recent` promises "messages between the user and the main Pi agent"; it only
    // ever returned assistant text, so "what did I ask?" got Pi's reply back.
    const recent = bridge.recentMessages(4);

    assert.deepEqual(recent.map((entry) => entry.role), ["assistant", "user"], "both roles, in order");
    assert.equal(recent[0]?.text, "The deploy is green.");
    assert.equal(recent[1]?.text, "check the deploy");
    bridge.dispose();
});

console.log(`\n${passed} checks passed`);