/**
 * Configuration for pi-voice, stored in Pi's agent directory as
 * `pi-voice.json` under the `"voice"` namespace, so it survives restarts and
 * is easy to hand-edit. Unknown/garbage values fall back to defaults.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type WakeEngine = "auto" | "sherpa" | "webspeech" | "energy";
export type ComputeBackend = "auto" | "cpu" | "webgpu" | "webnn";
export type Autonomy = "concierge" | "steer" | "approvals";
export type ThinkingLevelOption = "" | "minimal" | "low" | "medium" | "high";
export type AudioTransport = "browser" | "native" | "both";

export interface VoiceConfig {
    /** Master switch: when false the extension loads but never opens a socket. */
    enabled: boolean;
    /** Start the audio endpoint and Live session at `session_start`. */
    autoStart: boolean;
    /** Gemini API key. Empty means: resolve from env / Pi's provider registry. */
    apiKey: string;
    model: string;
    voice: string;
    /** BCP-47 language code, "" = automatic. */
    language: string;
    /** Extra persona text appended to the built-in system instruction. */
    persona: string;
    temperature: number;

    // ---- wake word ----
    /** Always-on listener. Default OFF. */
    alwaysOn: boolean;
    /**
     * Start asleep: run the local wake spotter but open no Gemini socket until the
     * wake phrase fires. Keeps an idle Pi from holding a Live session (and its
     * context) open for hours. Only meaningful together with `alwaysOn`.
     */
    connectOnWake: boolean;
    wakePhrases: string[];
    wakeEngine: WakeEngine;
    /** sherpa-onnx-node KWS model directory for native wake. Empty = managed install. */
    kwsModelDir: string;
    /** Keywords for the KWS model, e.g. "HEY PI :2.0" (';' separates keywords). */
    kwsKeywords: string;
    /**
     * sherpa provider: cpu (default), or an accelerator to try before falling back to
     * cpu — directml, cuda, nnapi, xnnpack, trt. The published prebuilt runtime ships
     * no accelerator provider, so anything but cpu only works with a self-built sherpa.
     */
    sherpaProvider: string;
    /** sherpa-onnx keyword-spotter asset base URL (lazy-loaded, cached). */
    wakeModelUrl: string;
    /** 0..1, higher = easier to trigger. */
    wakeSensitivity: number;
    /** Local model compute: auto prefers WebNN (NPU) then WebGPU then CPU. */
    compute: ComputeBackend;

    // ---- audio ----
    aec: boolean;
    noiseSuppression: boolean;
    autoGain: boolean;
    inputGain: number;
    outputGain: number;
    micDeviceId: string;
    outputDeviceId: string;

    // ---- live features ----
    searchGrounding: boolean;
    inputTranscription: boolean;
    outputTranscription: boolean;
    customVocabulary: string[];
    /** Let the model ignore speech that is not addressed to it. */
    proactiveAudio: boolean;
    proactiveVideo: boolean;
    affectiveDialog: boolean;
    thinkingLevel: ThinkingLevelOption;
    /** 0 = model default. */
    thinkingBudget: number;
    /** ms of silence that ends a turn (server VAD). */
    vadSilenceMs: number;
    /** ms of audio kept before speech start so the first syllable is not clipped. */
    vadPrefixMs: number;
    /** Start of user speech interrupts the model (barge-in). */
    bargeIn: boolean;

    // ---- context / session ----
    digestTurns: number;
    digestChars: number;
    /** Stop streaming mic audio after this much idle time (session stays resumable). */
    idleSleepMs: number;
    /** Soft cap on a single Live session before a proactive resume. */
    maxSessionMs: number;

    // ---- endpoint ----
    /** browser = companion page (best AEC); native = headless ffmpeg; both = either. */
    audio: AudioTransport;
    /** ffmpeg input device (Windows: `audio=<name>`, macOS: `:0`, Linux: `default`). */
    nativeInput: string;
    /** ffplay output device hint (usually empty). */
    nativeOutput: string;
    ffmpegPath: string;
    ffplayPath: string;
    /** Native echo mitigation: NLMS AEC (full duplex), half-duplex mute, or off. */
    nativeAec: "nlms" | "half-duplex" | "off";
    host: string;
    port: number;
    openBrowser: boolean;

    // ---- behavior ----
    autonomy: Autonomy;
    /** Let the voice agent answer Pi's approval prompts. */
    voiceApprovals: boolean;
    /** Speak Pi's progress/completion out loud while you work. */
    announce: boolean;
    debug: boolean;
}

export const VOICE_SETTINGS_NAMESPACE = "voice";
export const VOICE_CONFIG_FILE = "pi-voice.json";

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
    enabled: true,
    autoStart: false,
    apiKey: "",
    model: "gemini-3.8-live",
    voice: "Zephyr",
    language: "",
    persona: "",
    temperature: 1,

    alwaysOn: false,
    // Start asleep by default: a voice session that was never spoken to costs
    // nothing and touches no context.
    connectOnWake: true,
    wakePhrases: ["hey pi", "hi pi", "ok pi"],
    wakeEngine: "auto",
    kwsModelDir: "",
    kwsKeywords: "HEY PI :2.0",
    sherpaProvider: "auto",
    wakeModelUrl: "",
    wakeSensitivity: 0.5,
    // CPU is the safe default for the local wake-word model; "auto" prefers
    // WebNN (NPU) then WebGPU, which can be slower to start or unsupported.
    compute: "cpu",

    aec: true,
    noiseSuppression: true,
    autoGain: true,
    inputGain: 1,
    outputGain: 1,
    micDeviceId: "",
    outputDeviceId: "",

    // Live API grounding refuses free-tier projects with a 1011 quota close,
    // so it is opt-in. With billing, set it true or /voice set {"searchGrounding":true}.
    searchGrounding: false,
    inputTranscription: true,
    outputTranscription: true,
    customVocabulary: [],
    proactiveAudio: false,
    proactiveVideo: false,
    affectiveDialog: false,
    thinkingLevel: "",
    thinkingBudget: 0,
    vadSilenceMs: 500,
    vadPrefixMs: 40,
    bargeIn: true,

    digestTurns: 6,
    digestChars: 900,
    idleSleepMs: 45_000,
    maxSessionMs: 9 * 60_000,

    host: "127.0.0.1",
    port: 8722,
    openBrowser: true,

    audio: "native",
    nativeInput: "",
    nativeOutput: "",
    ffmpegPath: "ffmpeg",
    ffplayPath: "ffplay",
    nativeAec: "nlms",

    autonomy: "approvals",
    voiceApprovals: true,
    announce: true,
    debug: false,
};

export function voiceConfigPath(): string {
    // Explicit override wins; otherwise match Pi's default agent directory.
    if (process.env.PI_VOICE_CONFIG) {
        return process.env.PI_VOICE_CONFIG;
    }

    const agentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");

    return join(agentDir, VOICE_CONFIG_FILE);
}

function bool(key: keyof VoiceConfig) {
    return (value: unknown) => (typeof value === "boolean" ? (value as boolean) : DEFAULT_VOICE_CONFIG[key] as boolean);
}

function str(key: keyof VoiceConfig) {
    return (value: unknown) => (typeof value === "string" ? (value as string) : DEFAULT_VOICE_CONFIG[key] as string);
}

function num(key: keyof VoiceConfig, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
    return (value: unknown) => {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return DEFAULT_VOICE_CONFIG[key] as number;
        }

        return Math.min(max, Math.max(min, value));
    };
}

function oneOf<T extends string>(key: keyof VoiceConfig, allowed: readonly T[]) {
    return (value: unknown) => (
        typeof value === "string" && (allowed as readonly string[]).includes(value)
            ? (value as T)
            : DEFAULT_VOICE_CONFIG[key]
    );
}

function stringList(key: keyof VoiceConfig) {
    return (value: unknown) => {
        if (!Array.isArray(value)) {
            return DEFAULT_VOICE_CONFIG[key] as string[];
        }

        return value.filter((each): each is string => typeof each === "string" && each.trim().length > 0);
    };
}

const VALIDATORS: { [K in keyof VoiceConfig]: (value: unknown) => VoiceConfig[K] } = {
    enabled: bool("enabled"),
    autoStart: bool("autoStart"),
    apiKey: str("apiKey"),
    model: str("model"),
    voice: str("voice"),
    language: str("language"),
    persona: str("persona"),
    temperature: num("temperature", 0, 2),
    alwaysOn: bool("alwaysOn"),
    connectOnWake: bool("connectOnWake"),
    wakePhrases: stringList("wakePhrases"),
    wakeEngine: oneOf("wakeEngine", ["auto", "sherpa", "webspeech", "energy"] as const),
    kwsModelDir: str("kwsModelDir"),
    kwsKeywords: str("kwsKeywords"),
    sherpaProvider: str("sherpaProvider"),
    wakeModelUrl: str("wakeModelUrl"),
    wakeSensitivity: num("wakeSensitivity", 0, 1),
    compute: oneOf("compute", ["auto", "cpu", "webgpu", "webnn"] as const),
    aec: bool("aec"),
    noiseSuppression: bool("noiseSuppression"),
    autoGain: bool("autoGain"),
    inputGain: num("inputGain", 0, 8),
    outputGain: num("outputGain", 0, 8),
    micDeviceId: str("micDeviceId"),
    outputDeviceId: str("outputDeviceId"),
    searchGrounding: bool("searchGrounding"),
    inputTranscription: bool("inputTranscription"),
    outputTranscription: bool("outputTranscription"),
    customVocabulary: stringList("customVocabulary"),
    proactiveAudio: bool("proactiveAudio"),
    proactiveVideo: bool("proactiveVideo"),
    affectiveDialog: bool("affectiveDialog"),
    thinkingLevel: oneOf("thinkingLevel", ["", "minimal", "low", "medium", "high"] as const),
    thinkingBudget: num("thinkingBudget", 0, 65_536),
    vadSilenceMs: num("vadSilenceMs", 80, 4000),
    vadPrefixMs: num("vadPrefixMs", 0, 1000),
    bargeIn: bool("bargeIn"),
    digestTurns: num("digestTurns", 0, 40),
    digestChars: num("digestChars", 200, 8000),
    idleSleepMs: num("idleSleepMs", 5_000, 60 * 60_000),
    maxSessionMs: num("maxSessionMs", 60_000, 60 * 60_000),
    host: str("host"),
    port: num("port", 0, 65_535),
    openBrowser: bool("openBrowser"),
    audio: oneOf("audio", ["browser", "native", "both"] as const),
    nativeInput: str("nativeInput"),
    nativeOutput: str("nativeOutput"),
    ffmpegPath: str("ffmpegPath"),
    ffplayPath: str("ffplayPath"),
    nativeAec: oneOf("nativeAec", ["nlms", "half-duplex", "off"] as const),
    autonomy: oneOf("autonomy", ["concierge", "steer", "approvals"] as const),
    voiceApprovals: bool("voiceApprovals"),
    announce: bool("announce"),
    debug: bool("debug"),
};

// (validator table is defined below; every field falls back to its default)

export function normalizeVoiceConfig(value: unknown): VoiceConfig {
    const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const out = {} as VoiceConfig;

    for (const key of Object.keys(VALIDATORS) as (keyof VoiceConfig)[]) {
        out[key] = VALIDATORS[key](input[key]) as never;
    }

    return out;
}

function readSettingsFile(path: string): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));

        return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
        return {};
    }
}

export function loadVoiceConfig(path = voiceConfigPath()): VoiceConfig {
    return normalizeVoiceConfig(readSettingsFile(path)[VOICE_SETTINGS_NAMESPACE]);
}

export function saveVoiceConfig(config: VoiceConfig, path = voiceConfigPath()): void {
    const data = readSettingsFile(path);
    data[VOICE_SETTINGS_NAMESPACE] = config;
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
}

/** Apply a sparse patch on top of a config, normalizing the result. */
export function patchVoiceConfig(config: VoiceConfig, patch: Partial<VoiceConfig>): VoiceConfig {
    return normalizeVoiceConfig({ ...config, ...patch });
}
