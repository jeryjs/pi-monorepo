/**
 * `/voice` settings screen.
 *
 * A themed, searchable `SettingsList` (Pi's own `/settings` pattern) covering
 * every option, with text/number fields opened as submenus and audio
 * actions on control keys. Changes persist immediately.
 */

import { readFileSync } from "node:fs";
import {
    DynamicBorder,
    getSelectListTheme,
    getSettingsListTheme,
    type ExtensionContext,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import {
    Container,
    Input,
    Loader,
    SelectList,
    SettingsList,
    Text,
    matchesKey,
    type SettingItem,
    type TUI,
} from "@earendil-works/pi-tui";
import { liveModelIds } from "./capabilities.ts";
import type { VoiceConfig } from "./config.ts";
import type { VoiceRuntime } from "./runtime.ts";
import { KWS_MODEL, managedDepsDir, sherpaStatus, setupSherpaWake } from "./sherpa.ts";
import { PREBUILT_VOICES } from "./voices.ts";

export type VoiceTuiAction = "close" | "restart" | "stop" | "diagnose";

const VERSION: string = (() => {
    try {
        const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version?: string };

        return pkg.version ?? "0.0.0";
    } catch {
        return "0.0.0";
    }
})();

const BOOLEAN_IDS = new Set<string>([
    "enabled", "autoStart", "alwaysOn", "connectOnWake",
    "searchGrounding", "inputTranscription", "outputTranscription", "proactiveAudio",
    "proactiveVideo", "affectiveDialog", "bargeIn", "voiceApprovals",
    "announce", "debug",
]);

const NUMBER_IDS = new Set<string>([
    "temperature", "wakeSensitivity", "thinkingBudget", "vadSilenceMs", "vadPrefixMs",
    "idleSleepMs", "maxSessionMs", "digestTurns", "digestChars",
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

const WAKE_ENGINES = ["auto", "asr", "sherpa", "energy"] as const;

/**
 * Wake-engine picker that installs what the offline phrase spotter needs.
 *
 * Picking `sherpa` without `sherpa-onnx-node` (or without the KWS model) shows a
 * one-keystroke install prompt instead of silently falling back to energy VAD.
 */
class WakeEngineSubmenu extends Container {
    readonly #runtime: VoiceRuntime;
    readonly #theme: Theme;
    readonly #tui: TUI;
    readonly #done: (value?: string) => void;

    readonly #head: Text;
    readonly #detail: Text;
    readonly #loader: Loader;

    #mode: "pick" | "offer" | "busy" | "result" = "pick";
    #list: SelectList | undefined;
    #result: { ok: boolean; detail: string } | undefined;
    #tail: string[] = [];
    /** Engine the pick list was showing before we jumped into the install view. */
    #previousEngine = "auto";
    /** Set when the screen closes; stops UI work while an install finishes. */
    #closed = false;

    constructor(
        runtime: VoiceRuntime,
        theme: Theme,
        tui: TUI,
        current: string,
        done: (value?: string) => void,
    ) {
        super();
        this.#runtime = runtime;
        this.#theme = theme;
        this.#tui = tui;
        this.#done = done;
        this.#head = new Text("", 1, 0);
        this.#detail = new Text("", 1, 0);
        this.#loader = new Loader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), "working…");
        this.addChild(this.#head);
        this.addChild(this.#detail);
        this.#showPick(current);
    }

    #status() {
        return sherpaStatus(this.#runtime.getConfig().kwsModelDir);
    }

    #showPick(current: string): void {
        this.#mode = "pick";
        this.#stopLoader();
        this.#head.setText(this.#theme.fg("accent", " Wake engine"));

        if (this.#list) {
            this.removeChild(this.#list);
        }

        const status = this.#status();

        this.#detail.setText(this.#theme.fg(
            "muted",
            status.ready
                ? `offline phrase wake ready — ${status.detail}`
                : `offline phrase wake not installed — ${status.detail}`,
        ));

        this.#list = new SelectList(
            WAKE_ENGINES.map((engine) => ({
                value: engine,
                label: engine,
                description: engine === "sherpa"
                    ? (status.ready ? "offline keyword spotter (ready)" : "offline keyword spotter (needs a one-time install)")
                    : engine === "asr"
                        ? "streaming recognizer + phrase match (install with /voice asr)"
                        : engine === "auto"
                            ? "asr when installed, else sherpa, else energy VAD"
                            : "wake on any loud-enough speech",
            })),
            6,
            getSelectListTheme(),
        );
        this.#list.onSelect = (item) => void this.#pick(item.value, current);
        this.#list.onCancel = () => this.#done(undefined);

        const index = WAKE_ENGINES.indexOf(current as (typeof WAKE_ENGINES)[number]);

        if (index >= 0) {
            this.#list.setSelectedIndex(index);
        }

        this.addChild(this.#list);
        this.#tui.requestRender();
    }

    async #pick(engine: string, current: string): Promise<void> {
        if (engine !== "sherpa") {
            this.#done(engine);

            return;
        }

        if (this.#status().ready) {
            this.#done("sherpa");

            return;
        }

        this.#previousEngine = current;
        this.#showOffer();
    }

    #showOffer(): void {
        this.#mode = "offer";
        this.#stopLoader();

        const status = this.#status();

        this.#head.setText(this.#theme.fg("accent", " Install the offline wake word"));
        this.#detail.setText([
            this.#theme.fg("muted", status.packageInstalled
                ? "sherpa-onnx-node is installed; the wake model is missing."
                : "sherpa-onnx-node is not installed."),
            "",
            this.#theme.fg("muted", `One-time, prebuilt download into ${managedDepsDir()}`),
            this.#theme.fg("muted", `(about 23 MB runtime + ${(KWS_MODEL.bytes / 1024 / 1024).toFixed(1)} MB model). Your project is not modified.`),
            "",
            `${this.#theme.fg("accent", "Enter")} install now    ${this.#theme.fg("accent", "Esc")} back`,
        ].join("\n"));
        this.#tui.requestRender();
    }

    async #install(): Promise<void> {
        this.#mode = "busy";
        this.#tail = [];
        this.#head.setText(this.#theme.fg("accent", " Installing the offline wake word"));
        this.#startLoader("installing sherpa-onnx-node…");

        const onLine = (line: string): void => {
            this.#tail.push(line);

            if (this.#tail.length > 6) {
                this.#tail.shift();
            }

            if (this.#closed) {
                return;
            }

            this.#loader.setMessage(line);
            this.#detail.setText(this.#theme.fg("muted", this.#tail.join("\n")));
            this.#tui.requestRender();
        };

        const result = await setupSherpaWake({
            modelDir: this.#runtime.getConfig().kwsModelDir,
            onLine,
            // The user already accepted the install by pressing Enter here.
            confirm: async () => true,
        });

        if (this.#closed) {
            // The settings screen went away (Ctrl-R, Esc); the install itself is
            // still valid, it just has nobody to report to.
            return;
        }

        this.#stopLoader();
        this.#result = { ok: result.ok, detail: result.detail };
        this.#showResult();
    }

    /**
     * Everything the spotter needs is now on disk. Point `kwsModelDir` at the
     * managed model (only when it is empty, so an explicit choice is respected):
     * that config change is what rebuilds the audio side, so voice picks the
     * spotter up without a second manual restart.
     */
    #apply(): void {
        if (this.#runtime.getConfig().kwsModelDir.trim().length === 0) {
            this.#runtime.patch({ kwsModelDir: sherpaStatus("").modelDir });
        }

        this.#done("sherpa");
    }

    #showResult(): void {
        this.#mode = "result";
        const result = this.#result ?? { ok: false, detail: "no result" };

        this.#head.setText(this.#theme.fg(result.ok ? "accent" : "error", result.ok ? " Wake word ready" : " Wake word setup incomplete"));
        this.#detail.setText([
            result.detail,
            "",
            this.#theme.fg("muted", result.ok
                ? `Phrase: ${this.#runtime.getConfig().kwsKeywords}. Voice restarts to start listening.`
                : "Voice keeps working with the energy fallback; you can retry from wake engine → sherpa."),
            "",
            result.ok
                ? `${this.#theme.fg("accent", "Enter")} / ${this.#theme.fg("accent", "Esc")} done (voice restarts)`
                : `${this.#theme.fg("accent", "Enter")} back`,
        ].join("\n"));
        this.#tui.requestRender();
    }

    #startLoader(message: string): void {
        if (!this.children.includes(this.#loader)) {
            this.addChild(this.#loader);
        }

        this.#loader.setMessage(message);
        this.#loader.start();
    }

    #stopLoader(): void {
        this.#loader.stop();

        if (this.children.includes(this.#loader)) {
            this.removeChild(this.#loader);
        }
    }

    dispose(): void {
        this.#closed = true;
        this.#stopLoader();
    }

    handleInput(data: string): void {
        if (this.#mode === "pick") {
            this.#list?.handleInput(data);

            return;
        }

        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
            if (this.#mode === "result" && this.#result?.ok) {
                this.#apply();

                return;
            }

            if (this.#mode === "busy") {
                return;
            }

            this.#showPick(this.#previousEngine);

            return;
        }

        if (!matchesKey(data, "return")) {
            return;
        }

        if (this.#mode === "offer") {
            void this.#install();

            return;
        }

        if (this.#mode === "result") {
            if (this.#result?.ok) {
                this.#apply();

                return;
            }

            this.#showPick(this.#previousEngine);
        }
    }
}

function wakeEngineItem(
    config: VoiceConfig,
    runtime: VoiceRuntime,
    theme: Theme,
    tui: TUI,
    onSubmenu?: (submenu: { dispose?: () => void }) => void,
): SettingItem {
    const status = sherpaStatus(config.kwsModelDir);

    return {
        id: "wakeEngine",
        label: "Wake engine",
        description: "sherpa = offline phrase spotter (installs on demand); energy = any loud speech",
        currentValue: config.wakeEngine === "auto" && status.ready ? "auto (sherpa)" : config.wakeEngine,
        submenu: (currentValue, done) => {
            const value = currentValue.replace(" (sherpa)", "");
            const submenu = new WakeEngineSubmenu(runtime, theme, tui, value, done);

            onSubmenu?.(submenu);

            return submenu;
        },
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

function buildItems(
    runtime: VoiceRuntime,
    theme: Theme,
    tui: TUI,
    onSubmenu?: (submenu: { dispose?: () => void }) => void,
): SettingItem[] {
    const config = runtime.getConfig();

    return [
        boolItem("enabled", "Voice enabled", "Load and allow the voice session", config.enabled),
        boolItem("autoStart", "Start automatically", "Start voice when a Pi session begins", config.autoStart),
        boolItem("alwaysOn", "Always-on wake word", "Listen for the wake phrase without pressing to talk", config.alwaysOn),
        boolItem("connectOnWake", "Start asleep", "Open the Gemini session on the wake phrase instead of at startup", config.connectOnWake),

        enumItem("model", "Live model", "Gemini Live model (restart to apply)", config.model, liveModelIds()),
        enumItem("voice", "Voice", "Prebuilt Gemini voice", config.voice, [...PREBUILT_VOICES]),
        enumItem("autonomy", "Autonomy", "concierge = talk/queue; steer = +interrupt; approvals = +voice approvals", config.autonomy, ["concierge", "steer", "approvals"]),
        boolItem("voiceApprovals", "Voice approvals", "Ask out loud before risky shell commands", config.voiceApprovals),
        boolItem("announce", "Announce results", "Speak Pi's completions and failures", config.announce),

        wakeEngineItem(config, runtime, theme, tui, onSubmenu),
        textItem("wakePhrases", "Wake phrases", "Comma-separated (default: hey pi)", config.wakePhrases.join(", "), theme, tui),
        textItem("wakeSensitivity", "Wake sensitivity", "0-1; higher = easier to trigger (native energy + sherpa threshold)", String(config.wakeSensitivity), theme, tui),
        textItem("asrModelDir", "ASR model dir", "Empty = managed install (/voice asr)", config.asrModelDir, theme, tui),
        textItem("kwsModelDir", "Sherpa model dir", "Empty = managed install; set to use your own KWS model directory", config.kwsModelDir, theme, tui),
        textItem("kwsKeywords", "Sherpa keywords", "Phrase(s) to spot, e.g. 'HEY PI :2.0'; ';' separates several", config.kwsKeywords, theme, tui),
        enumItem("sherpaProvider", "Sherpa provider", "Inference backend; the prebuilt runtime is CPU-only (auto = cpu)", config.sherpaProvider, ["auto", "cpu", "directml", "cuda", "nnapi", "xnnpack", "trt"]),

        textItem("language", "Language", "BCP-47 code, empty = automatic", config.language, theme, tui),
        textItem("temperature", "Temperature", "0-2", String(config.temperature), theme, tui),

        boolItem("searchGrounding", "Google Search grounding", "Requires a billed project; auto-dropped otherwise", config.searchGrounding),
        boolItem("inputTranscription", "Input transcription", "Transcribe the user's speech", config.inputTranscription),
        boolItem("outputTranscription", "Output transcription", "Transcribe the model's speech", config.outputTranscription),
        textItem("customVocabulary", "Custom vocabulary", "Comma-separated words to bias recognition", config.customVocabulary.join(", "), theme, tui),
        boolItem("proactiveAudio", "Proactive audio", "Let the model ignore speech not addressed to it", config.proactiveAudio),
        boolItem("proactiveVideo", "Proactive video", "Let the model ignore irrelevant video", config.proactiveVideo),
        boolItem("bargeIn", "Barge-in", "Speech interrupts the model; needs good AEC, disable if it cuts", config.bargeIn),
        enumItem("thinkingLevel", "Thinking level", "Level for models that accept it (default = model default)", config.thinkingLevel || "Default", ["Default", "minimal", "low", "medium", "high"]),
        textItem("thinkingBudget", "Thinking budget", "Tokens; 0 = model default", String(config.thinkingBudget), theme, tui),

        textItem("vadSilenceMs", "Turn silence (ms)", "How long a pause ends a turn", String(config.vadSilenceMs), theme, tui),
        textItem("vadPrefixMs", "Turn prefix (ms)", "Audio kept before speech starts", String(config.vadPrefixMs), theme, tui),
        textItem("idleSleepMs", "Idle sleep (ms)", "Stop streaming the mic after this much silence", String(config.idleSleepMs), theme, tui),
        textItem("maxSessionMs", "Max session (ms)", "Soft cap before a proactive resume", String(config.maxSessionMs), theme, tui),
        textItem("digestTurns", "Digest turns", "Recent Pi exchanges summarised for the voice model", String(config.digestTurns), theme, tui),
        textItem("digestChars", "Digest chars", "Characters kept per message", String(config.digestChars), theme, tui),

        textItem("nativeInput", "Native input device", "ffmpeg device: audio=<name> (Win), :0 (mac), default (Linux); empty = auto-detect", config.nativeInput, theme, tui),
        enumItem("nativeAec", "Native echo", "nlms = full-duplex AEC; half-duplex mutes the mic; off", config.nativeAec, ["nlms", "half-duplex", "off"]),
        textItem("ffmpegPath", "ffmpeg path", "Binary used for native capture", config.ffmpegPath, theme, tui),
        textItem("ffplayPath", "ffplay path", "Binary used for native playback", config.ffplayPath, theme, tui),

        textItem("inputGain", "Input gain", "0-8 scale applied to the microphone before sending", String(config.inputGain), theme, tui),
        textItem("outputGain", "Output gain", "0-8 scale applied to the model's voice", String(config.outputGain), theme, tui),

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
    const sherpa = sherpaStatus(config.kwsModelDir);
    const wake = config.alwaysOn
        ? sherpa.ready
            ? `on · ${sherpa.version ? `sherpa ${sherpa.version}` : "sherpa"}`
            : `on · energy VAD (${sherpa.detail})`
        : "off";

    return [
        theme.style(`Pi Voice ${VERSION}`, { fg: "accent", bold: true }),
        theme.fg("muted", `state ${state} · model ${config.model} · wake ${wake}`),
        theme.fg("dim", `key ${key} · voice ${config.voice}`),
    ].join("\n");
}

function hintText(_runtime: VoiceRuntime, theme: Theme): string {
    return theme.fg(
        "dim",
        "↑↓ move · Enter change · type to search · Ctrl-R restart · Ctrl-T stop · Ctrl-D diagnose · Esc close",
    );
}

class VoiceSettingsComponent extends Container {
    readonly #list: SettingsList;
    readonly #finish: (action: VoiceTuiAction) => void;
    readonly #header: Text;
    readonly #runtime: VoiceRuntime;
    readonly #theme: Theme;
    /** Submenu currently open, so it can be shut down together with the screen. */
    #submenu: { dispose?: () => void } | undefined;

    constructor(runtime: VoiceRuntime, theme: Theme, tui: TUI, done: (action: VoiceTuiAction) => void) {
        super();
        this.#finish = done;
        this.#runtime = runtime;
        this.#theme = theme;

        this.addChild(new DynamicBorder());
        this.#header = new Text(headerText(runtime, theme), 1, 0);
        this.addChild(this.#header);
        this.addChild(new DynamicBorder());

        this.#list = new SettingsList(
            buildItems(runtime, theme, tui, (submenu) => {
                this.#submenu = submenu;
            }),
            16,
            getSettingsListTheme(),
            (id, value) => {
                applyChange(runtime, id, value);
                // The wake/sherpa status in the header depends on the config.
                this.#header.setText(headerText(this.#runtime, this.#theme));
                this.#header.invalidate();
            },
            () => done("close"),
            { enableSearch: true },
        );
        this.addChild(this.#list);

        this.addChild(new DynamicBorder());
        this.addChild(new Text(hintText(runtime, theme), 1, 0));
    }

    dispose(): void {
        this.#submenu?.dispose?.();

        for (const child of this.children) {
            (child as { dispose?: () => void }).dispose?.();
        }
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