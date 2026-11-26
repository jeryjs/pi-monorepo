/**
 * `/voice` settings screen.
 *
 * A themed, searchable `SettingsList` (Pi's own `/settings` pattern) covering
 * every option, with text/number fields opened as submenus and transport
 * actions on control keys. Changes persist immediately.
 */

import { readFileSync } from "node:fs";
import {
    DynamicBorder,
    getSettingsListTheme,
    type ExtensionContext,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import {
    Container,
    Input,
    SettingsList,
    Text,
    matchesKey,
    type SettingItem,
    type TUI,
} from "@earendil-works/pi-tui";
import { liveModelIds } from "./capabilities.ts";
import type { VoiceConfig } from "./config.ts";
import type { VoiceRuntime } from "./runtime.ts";
import { PREBUILT_VOICES } from "./voices.ts";

export type VoiceTuiAction = "close" | "restart" | "stop" | "diagnose" | "open";

const VERSION: string = (() => {
    try {
        const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version?: string };

        return pkg.version ?? "0.0.0";
    } catch {
        return "0.0.0";
    }
})();

const BOOLEAN_IDS = new Set<string>([
    "enabled", "autoStart", "alwaysOn", "aec", "noiseSuppression", "autoGain",
    "searchGrounding", "inputTranscription", "outputTranscription", "proactiveAudio",
    "proactiveVideo", "affectiveDialog", "bargeIn", "openBrowser", "voiceApprovals",
    "announce", "debug",
]);

const NUMBER_IDS = new Set<string>([
    "temperature", "wakeSensitivity", "thinkingBudget", "vadSilenceMs", "vadPrefixMs",
    "idleSleepMs", "maxSessionMs", "digestTurns", "digestChars", "port",
    "inputGain", "outputGain",
]);

const LIST_IDS = new Set<string>(["wakePhrases", "customVocabulary"]);

function boolItem(id: string, label: string, description: string, current: boolean): SettingItem {
    return {
        id,
        label,
        description,
        currentValue: current ? "On" : "Off",
        values: ["On", "Off"],
    };
}

function enumItem(id: string, label: string, description: string, current: string, values: string[]): SettingItem {
    return {
        id,
        label,
        description,
        currentValue: values.includes(current) ? current : values[0] ?? current,
        values,
    };
}

/** Single-line editor shown as a submenu; Enter saves, Esc leaves unchanged. */
class TextField extends Container {
    #input: Input;
    #focused = false;

    constructor(value: string, prompt: string, theme: Theme, tui: TUI, done: (next?: string) => void) {
        super();
        this.addChild(new Text(theme.fg("muted", prompt), 1, 0));
        this.#input = new Input({ placeholder: value });
        this.#input.setValue(value);
        this.#input.focused = true;
        this.#input.onSubmit = (next) => {
            done(next);
            tui.requestRender();
        };
        this.#input.onEscape = () => {
            done(undefined);
            tui.requestRender();
        };
        this.addChild(this.#input);
    }

    get focused(): boolean {
        return this.#focused;
    }

    set focused(value: boolean) {
        this.#focused = value;
        this.#input.focused = value;
    }

    handleInput(data: string): void {
        this.#input.handleInput(data);
    }
}

function textItem(
    id: string,
    label: string,
    description: string,
    current: string,
    theme: Theme,
    tui: TUI,
): SettingItem {
    return {
        id,
        label,
        description,
        currentValue: current,
        submenu: (currentValue, done) => new TextField(currentValue, description, theme, tui, (next) => {
            if (next === undefined) {
                done();

                return;
            }

            done(next);
        }),
    };
}

function buildItems(runtime: VoiceRuntime, theme: Theme, tui: TUI): SettingItem[] {
    const config = runtime.getConfig();

    return [
        boolItem("enabled", "Voice enabled", "Load and allow the voice session", config.enabled),
        boolItem("autoStart", "Start automatically", "Start voice when a Pi session begins", config.autoStart),
        boolItem("alwaysOn", "Always-on wake word", "Listen for the wake phrase without pressing to talk", config.alwaysOn),

        enumItem("audio", "Audio transport", "native = headless ffmpeg (no tab); browser = companion page with AEC", config.audio, ["native", "browser", "both"]),
        enumItem("model", "Live model", "Gemini Live model (restart to apply)", config.model, liveModelIds()),
        enumItem("voice", "Voice", "Prebuilt Gemini voice", config.voice, [...PREBUILT_VOICES]),
        enumItem("autonomy", "Autonomy", "concierge = talk/queue; steer = +interrupt; approvals = +voice approvals", config.autonomy, ["concierge", "steer", "approvals"]),
        boolItem("voiceApprovals", "Voice approvals", "Ask out loud before risky shell commands", config.voiceApprovals),
        boolItem("announce", "Announce results", "Speak Pi's completions and failures", config.announce),

        enumItem("wakeEngine", "Wake engine", "Browser only: sherpa (offline KWS), Web Speech, or energy VAD", config.wakeEngine, ["auto", "sherpa", "webspeech", "energy"]),
        textItem("wakeSensitivity", "Wake sensitivity", "0-1; higher = easier to trigger", String(config.wakeSensitivity), theme, tui),
        enumItem("compute", "Compute", "Wake-model backend: cpu, auto (NPU/GPU), webgpu, webnn", config.compute, ["cpu", "auto", "webgpu", "webnn"]),
        textItem("wakeModelUrl", "Wake model URL", "Browser: module exporting createKeywordSpotter", config.wakeModelUrl, theme, tui),
        textItem("wakePhrases", "Wake phrases", "Comma-separated (default: hey pi)", config.wakePhrases.join(", "), theme, tui),

        textItem("language", "Language", "BCP-47 code, empty = automatic", config.language, theme, tui),
        textItem("temperature", "Temperature", "0-2", String(config.temperature), theme, tui),

        boolItem("searchGrounding", "Google Search grounding", "Requires a billed project; auto-dropped otherwise", config.searchGrounding),
        boolItem("inputTranscription", "Input transcription", "Transcribe the user's speech", config.inputTranscription),
        boolItem("outputTranscription", "Output transcription", "Transcribe the model's speech", config.outputTranscription),
        textItem("customVocabulary", "Custom vocabulary", "Comma-separated words to bias recognition", config.customVocabulary.join(", "), theme, tui),
        boolItem("proactiveAudio", "Proactive audio", "Let the model ignore speech not addressed to it", config.proactiveAudio),
        boolItem("proactiveVideo", "Proactive video", "Let the model ignore irrelevant video", config.proactiveVideo),
        boolItem("bargeIn", "Barge-in", "Off: echo and noise cannot cut the model off mid-sentence", config.bargeIn),
        enumItem("thinkingLevel", "Thinking level", "Level for models that accept it (default = model default)", config.thinkingLevel || "Default", ["Default", "minimal", "low", "medium", "high"]),
        textItem("thinkingBudget", "Thinking budget", "Tokens; 0 = model default", String(config.thinkingBudget), theme, tui),

        textItem("vadSilenceMs", "Turn silence (ms)", "How long a pause ends a turn", String(config.vadSilenceMs), theme, tui),
        textItem("vadPrefixMs", "Turn prefix (ms)", "Audio kept before speech starts", String(config.vadPrefixMs), theme, tui),
        textItem("idleSleepMs", "Idle sleep (ms)", "Stop streaming the mic after this much silence", String(config.idleSleepMs), theme, tui),
        textItem("maxSessionMs", "Max session (ms)", "Soft cap before a proactive resume", String(config.maxSessionMs), theme, tui),
        textItem("digestTurns", "Digest turns", "Recent Pi exchanges summarised for the voice model", String(config.digestTurns), theme, tui),
        textItem("digestChars", "Digest chars", "Characters kept per message", String(config.digestChars), theme, tui),

        textItem("nativeInput", "Native input device", "ffmpeg device: audio=<name> (Win), :0 (mac), default (Linux); empty = auto-detect", config.nativeInput, theme, tui),
        textItem("nativeOutput", "Native output device", "Playback device hint", config.nativeOutput, theme, tui),
        enumItem("nativeAec", "Native echo", "half-duplex mutes the mic while the model speaks; off", config.nativeAec, ["half-duplex", "off"]),
        textItem("ffmpegPath", "ffmpeg path", "Binary used for native capture", config.ffmpegPath, theme, tui),
        textItem("ffplayPath", "ffplay path", "Binary used for native playback", config.ffplayPath, theme, tui),

        textItem("host", "Browser host", "Loopback address for the companion page", config.host, theme, tui),
        textItem("port", "Browser port", "0 = random; falls back to random if busy", String(config.port), theme, tui),
        boolItem("openBrowser", "Open page", "Browser transport: open the companion page on start", config.openBrowser),
        boolItem("aec", "Browser AEC", "WebRTC echo cancellation", config.aec),
        boolItem("noiseSuppression", "Noise suppression", "Browser microphone processing", config.noiseSuppression),
        boolItem("autoGain", "Auto gain", "Browser microphone processing", config.autoGain),
        textItem("micDeviceId", "Mic device id", "Browser: exact deviceId (empty = default)", config.micDeviceId, theme, tui),
        textItem("outputDeviceId", "Output device id", "Browser: exact output device (empty = default)", config.outputDeviceId, theme, tui),

        textItem("persona", "Persona", "Extra instructions appended to the voice system prompt", config.persona, theme, tui),
        boolItem("debug", "Debug logging", "PI_VOICE_DEBUG output", config.debug),
    ];
}

function applyChange(runtime: VoiceRuntime, id: string, value: string): void {
    const key = id as keyof VoiceConfig;
    let next: unknown = value;

    if (BOOLEAN_IDS.has(id)) {
        next = value === "On";
    } else if (NUMBER_IDS.has(id)) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return;
        }

        next = number;
    } else if (LIST_IDS.has(id)) {
        next = value.split(",").map((entry) => entry.trim()).filter(Boolean);
    } else if (id === "thinkingLevel") {
        next = value === "Default" ? "" : value;
    }

    runtime.patch({ [key]: next } as Partial<VoiceConfig>);
}

function headerText(runtime: VoiceRuntime, theme: Theme): string {
    const config = runtime.getConfig();
    const controller = runtime.controller();
    const state = controller?.running ? controller.liveState : "off";
    const key = controller?.keySource ?? "not resolved";
    const pages = controller?.peerCount ?? 0;

    return [
        theme.style(`Pi Voice ${VERSION}`, { fg: "accent", bold: true }),
        theme.fg("muted", `state ${state} · transport ${config.audio} · model ${config.model} · wake ${config.alwaysOn ? "on" : "off"}`),
        theme.fg("dim", `key ${key} · pages ${pages} · voice ${config.voice}`),
    ].join("\n");
}

function hintText(runtime: VoiceRuntime, theme: Theme): string {
    const browser = runtime.getConfig().audio !== "native";

    return theme.fg(
        "dim",
        "↑↓ move · Enter change · type to search · Ctrl-R restart · Ctrl-T stop · Ctrl-D diagnose"
        + (browser ? " · Ctrl-O page" : "")
        + " · Esc close",
    );
}

class VoiceSettingsComponent extends Container {
    readonly #list: SettingsList;
    readonly #finish: (action: VoiceTuiAction) => void;

    constructor(runtime: VoiceRuntime, theme: Theme, tui: TUI, done: (action: VoiceTuiAction) => void) {
        super();
        this.#finish = done;

        this.addChild(new DynamicBorder());
        this.addChild(new Text(headerText(runtime, theme), 1, 0));
        this.addChild(new DynamicBorder());

        this.#list = new SettingsList(
            buildItems(runtime, theme, tui),
            16,
            getSettingsListTheme(),
            (id, value) => applyChange(runtime, id, value),
            () => done("close"),
            { enableSearch: true },
        );
        this.addChild(this.#list);

        this.addChild(new DynamicBorder());
        this.addChild(new Text(hintText(runtime, theme), 1, 0));
    }

    handleInput(data: string): void {
        if (matchesKey(data, "ctrl+r")) {
            this.#finish("restart");
            return;
        }

        if (matchesKey(data, "ctrl+t")) {
            this.#finish("stop");
            return;
        }

        if (matchesKey(data, "ctrl+d")) {
            this.#finish("diagnose");
            return;
        }

        if (matchesKey(data, "ctrl+o")) {
            this.#finish("open");
            return;
        }

        this.#list.handleInput(data);
    }
}

/** Open the voice settings screen. Resolves with the action to run afterwards. */
export async function openVoiceTui(runtime: VoiceRuntime, ctx: ExtensionContext): Promise<VoiceTuiAction> {
    if (ctx.mode !== "tui") {
        return "close";
    }

    return await ctx.ui.custom<VoiceTuiAction>((tui, theme, _keybindings, done) =>
        new VoiceSettingsComponent(runtime, theme, tui, done)
    );
}