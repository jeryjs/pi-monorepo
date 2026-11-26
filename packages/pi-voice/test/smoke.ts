/**
 * Dependency-free smoke tests: capabilities, setup shaping, wire protocol and
 * config normalization. Run with `node test/smoke.ts` (Node strips types).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilitiesFor, liveModelIds } from "../capabilities.ts";
import { completeVoiceArguments } from "../completions.ts";
import { DEFAULT_VOICE_CONFIG, normalizeVoiceConfig, patchVoiceConfig } from "../config.ts";
import { readKeyFromAuthJson, resolveGeminiKey } from "../keychain.ts";
import { friendlyCloseError, isFatalClose, isStaleHandleClose } from "../live/session.ts";
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
import { buildSystemInstruction } from "../bridge/prompt.ts";
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
    assert.equal(setup.sessionResumption, undefined);
    // historyConfig would make the server wait for a seeding turn; we use tools instead.
    assert.equal(setup.historyConfig, undefined);
});

test("resumption handle is threaded through", () => {
    const setup = build("handle-123") as Record<string, any>;
    assert.equal(setup.sessionResumption.handle, "handle-123");
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
    assert.equal(config.audio, "browser");
});

test("patch applies and re-normalizes", () => {
    const config = patchVoiceConfig(DEFAULT_VOICE_CONFIG, { alwaysOn: true, audio: "native", autonomy: "steer" });
    assert.equal(config.alwaysOn, true);
    assert.equal(config.audio, "native");
    assert.equal(config.autonomy, "steer");
});

console.log("prompt");
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
    const compute = completeVoiceArguments("compute web", completionContext).map((item) => item.value);
    assert.ok(compute.includes("compute webgpu"));
    assert.ok(compute.includes("compute webnn"));
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
    assert.equal(isFatalClose(1008, "policy"), true);
    assert.equal(isFatalClose(1011, "internal server error"), false);
    assert.equal(isFatalClose(1000, "rotation"), false);
    assert.equal(isFatalClose(undefined, ""), false);
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

console.log(`\n${passed} checks passed`);