/**
 * `/voice` command surface. No arguments opens the settings TUI; subcommands
 * remain for scripting and quick actions.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { micVerdict, probeMic } from "./audio/native.ts";
import { capabilitiesFor, describeModels, liveModelIds } from "./capabilities.ts";
import { completeVoiceArguments } from "./completions.ts";
import type { VoiceConfig } from "./config.ts";
import type { VoiceRuntime } from "./runtime.ts";
import { ASR_MODEL, asrModelStatus, downloadAsrModel, resolvedAsrModelDir, sherpaStatus, setupSherpaWake } from "./sherpa.ts";
import { debugState, recentWarnings } from "./util.ts";
import { PREBUILT_VOICES } from "./voices.ts";

export type { VoiceRuntime } from "./runtime.ts";

function say(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
    try {
        ctx.ui.notify(message, type);
    } catch {
        // Non-interactive modes may not have UI; the message is still in logs.
    }
}

function statusText(runtime: VoiceRuntime): string {
    const config = runtime.getConfig();
    const controller = runtime.controller();
    const capabilities = capabilitiesFor(config.model);

    const lines = [
        `voice: ${controller?.running ? controller.liveState : "off"}`,
        `model: ${config.model} (${capabilities.label})`,
        `voice name: ${config.voice}${config.language ? ` · lang ${config.language}` : ""}`,
        `key: ${config.apiKey ? "config" : controller?.keySource ?? "not resolved"}`,
        `always-on: ${config.alwaysOn ? "on" : "off"} · engine ${config.wakeEngine}`,
        `wake: ${sherpaStatus(config.kwsModelDir).detail}`
            + `${asrModelStatus(resolvedAsrModelDir(config.asrModelDir)).ok ? " · asr model installed" : ""}`,
        `start: ${config.alwaysOn && config.connectOnWake
            ? "asleep — connects on the wake phrase (connectOnWake)"
            : "connects at startup (connectOnWake off)"}`,
        `autonomy: ${config.autonomy}${config.voiceApprovals ? " (voice approvals)" : ""}`,
        `tools: ${capabilities.asyncTools ? "async" : "sync"} function calling · search ${config.searchGrounding ? "on" : "off"}`,
        `VAD: ${config.vadSilenceMs}ms silence, ${config.vadPrefixMs}ms prefix · barge-in ${config.bargeIn ? "on" : "off"}`,
        `idle sleep: ${Math.round(config.idleSleepMs / 1000)}s · digest ${config.digestTurns} turns`,
        // Nothing is written to stderr unless asked for, so state the quiet mode and
        // whether anything was withheld (`warn()` still records every warning).
        `logging: ${debugState().enabled ? "debug on" : "quiet (warnings still recorded)"}`,
    ];

    lines.push(`wake: ${config.alwaysOn ? "on" : "off (enable with /voice always-on on)"}`);

    if (controller?.running) {
        const stats = controller.wakeStats;

        lines.push(`wake engine running: ${controller.wakeEngineActive}`);
        lines.push(
            stats.count === 0
                ? "wake hits: 0 — never fired. Run /voice mic to check the input before blaming the phrase."
                : `wake hits: ${stats.count} · last ${new Date(stats.lastAt).toLocaleTimeString()} from ${stats.source}`,
        );

        if (controller.micSilent) {
            lines.push("mic: NO SIGNAL in the last 8s (the device is delivering silence) — /voice mic");
        }
    }

    if (controller?.lastError) {
        lines.push(`last error: ${controller.lastError}`);
    }

    const warnings = recentWarnings(3);

    if (warnings.length > 0) {
        lines.push("recent warnings (hidden from stderr while debug is off):");

        for (const entry of warnings) {
            lines.push(`  ${new Date(entry.at).toLocaleTimeString()} [${entry.scope}] ${entry.text.slice(0, 160)}`);
        }
    }

    return lines.join("\n");
}

export function registerVoiceCommands(pi: ExtensionAPI, runtime: VoiceRuntime): void {
    pi.registerCommand("voice", {
        description: "Control the Gemini Live voice assistant (status, on, off, listen, sleep, always-on, model, voice, wake, sherpa, asr, mic, key, debug)",
        getArgumentCompletions: (prefix: string) => {
            try {
                return completeVoiceArguments(prefix, {
                    models: liveModelIds().map((id) => ({ id, label: capabilitiesFor(id).label })),
                    voices: PREBUILT_VOICES,
                    currentModel: runtime.getConfig().model,
                    currentVoice: runtime.getConfig().voice,
                    running: runtime.controller()?.running ?? false,
                });
            } catch {
                return [];
            }
        },
        handler: async (args: string, ctx: ExtensionCommandContext) => {
            const trimmed = args.trim();

            if (!trimmed) {
                if (ctx.mode === "tui") {
                    // Lazy: keep the extension entry light and only load the TUI
                    // when the settings screen is actually opened.
                    const { openVoiceTui } = await import("./tui.ts");
                    const action = await openVoiceTui(runtime, ctx);

                    switch (action) {
                        case "restart":
                            await runtime.stop();

                            try {
                                await runtime.start();
                                say(ctx, "voice restarted", "info");
                            } catch (error) {
                                say(ctx, `voice failed to start: ${String(error)}`, "error");
                            }
                            return;

                        case "stop":
                            await runtime.stop();
                            say(ctx, "voice off", "info");
                            return;

                        case "diagnose": {
                            say(ctx, "probing the Live API with your key…", "info");

                            try {
                                say(ctx, await runtime.diagnose(), "info");
                            } catch (error) {
                                say(ctx, `diagnose failed: ${String(error)}`, "error");
                            }
                            return;
                        }

                        default:
                            say(ctx, "voice settings saved", "info");
                            return;
                    }
                }

                say(ctx, statusText(runtime), "info");

                return;
            }

            const [sub, ...rest] = trimmed.split(/\s+/);
            const value = rest.join(" ").trim();

            switch (sub) {
                case "status":
                    say(ctx, statusText(runtime), "info");
                    return;

                case "mic":
                case "mic-test": {
                    // Splits "the wake word never fires" into "the mic is silent"
                    // versus "the mic is fine, the detector is not firing".
                    const config = runtime.getConfig();
                    const running = runtime.controller()?.running ?? false;

                    say(ctx, `recording ${value ? `${value}s` : "3s"} from the input... speak now`, "info");

                    const seconds = Math.min(10, Math.max(1, Number.parseFloat(value) || 3));
                    const probe = await probeMic(config, seconds);
                    const verdict = micVerdict(probe);

                    const lines = [
                        `device: ${probe.device || "(default)"}`,
                        `captured: ${(probe.samples / 16_000).toFixed(1)}s · peak ${probe.peak.toFixed(4)} · rms ${probe.rms.toFixed(4)}`,
                        verdict,
                    ];

                    if (running) {
                        lines.push("(voice is running and holding the device; a second reader can fail on Windows)");
                    }

                    const silent = !probe.error && probe.peak < 0.0005;

                    say(ctx, lines.join("\n"), silent || probe.error ? "error" : "info");
                    return;
                }

                case "on":
                case "start": {
                    try {
                        await runtime.start();
                        say(ctx, "voice on", "info");
                    } catch (error) {
                        say(ctx, `voice failed to start: ${String(error)}`, "error");
                    }
                    return;
                }

                case "off":
                case "stop":
                    await runtime.stop();
                    say(ctx, "voice off", "info");
                    return;

                case "restart": {
                    // A restart must always report what happened: stop() is now
                    // idempotent and start() may legitimately fail (lock, key, device).
                    try {
                        await runtime.stop();
                        await runtime.start();
                        say(ctx, "voice restarted", "info");
                    } catch (error) {
                        say(ctx, `voice failed to restart: ${String(error)}`, "error");
                    }
                    return;
                }

                case "listen":
                case "wake":
                    runtime.controller()?.wake();
                    say(ctx, "listening", "info");
                    return;

                case "sleep":
                    runtime.controller()?.sleep("command");
                    say(ctx, "asleep", "info");
                    return;

                case "always-on":
                case "alwaysOn": {
                    const enabled = value ? /^(on|true|yes|1)$/i.test(value) : !runtime.getConfig().alwaysOn;
                    runtime.patch({ alwaysOn: enabled });
                    runtime.controller()?.setAlwaysOn(enabled);
                    say(ctx, `always-on ${enabled ? "on" : "off"}`, "info");
                    return;
                }

                case "model": {
                    if (!value) {
                        say(ctx, `models:\n  ${describeModels()}\ncurrent: ${runtime.getConfig().model}`, "info");
                        return;
                    }

                    if (!liveModelIds().includes(value)) {
                        say(ctx, `unknown model ${value}\nmodels:\n  ${describeModels()}`, "warning");
                        return;
                    }

                    runtime.patch({ model: value });
                    say(ctx, `model set to ${value}. Restart voice to apply: /voice restart`, "info");
                    return;
                }

                case "voice-name":
                case "voicename":
                    if (!value) {
                        say(ctx, `voice name: ${runtime.getConfig().voice}`, "info");
                        return;
                    }
                    runtime.patch({ voice: value });
                    say(ctx, `voice name set to ${value}. Restart to apply.`, "info");
                    return;

                case "autonomy": {
                    const level = value.toLowerCase();

                    if (!["concierge", "steer", "approvals"].includes(level)) {
                        say(ctx, "autonomy: concierge | steer | approvals", "warning");
                        return;
                    }

                    runtime.patch({ autonomy: level as VoiceConfig["autonomy"] });
                    say(ctx, `autonomy: ${level}`, "info");
                    return;
                }

                case "wake-engine":
                case "wakeengine": {
                    const engine = value.toLowerCase();

                    if (!["auto", "asr", "sherpa", "energy"].includes(engine)) {
                        say(ctx, "wake engine: auto | asr | sherpa | energy", "warning");
                        return;
                    }

                    runtime.patch({ wakeEngine: engine as VoiceConfig["wakeEngine"] });
                    say(ctx, `wake engine: ${engine}`, "info");
                    return;
                }

                case "sherpa":
                case "wake-install": {
                    // Offline phrase wake: install the runtime + model on demand. The
                    // TUI wake-engine picker runs the same function.
                    const status = sherpaStatus(runtime.getConfig().kwsModelDir);

                    if (status.ready && value !== "force") {
                        say(ctx, `wake word already set up: ${status.detail}`, "info");
                        return;
                    }

                    const wasRunning = runtime.controller()?.running ?? false;

                    say(ctx, `${status.detail}. Installing what is missing (a few tens of MB)...`, "info");

                    const result = await setupSherpaWake({
                        modelDir: runtime.getConfig().kwsModelDir,
                        onLine: (line) => say(ctx, line, "info"),
                        confirm: async (title, message) => {
                            try {
                                return await ctx.ui.confirm(title, message);
                            } catch {
                                // No interactive UI available: never install silently.
                                return false;
                            }
                        },
                    });

                    if (!result.ok) {
                        say(ctx, `sherpa setup: ${result.detail}`, "warning");
                        return;
                    }

                    if (runtime.getConfig().wakeEngine === "energy") {
                        runtime.patch({ wakeEngine: "sherpa" });
                    }

                    if (wasRunning) {
                        try {
                            await runtime.stop();
                            await runtime.start();
                        } catch (error) {
                            say(ctx, `installed, but restarting voice failed: ${String(error)}`, "warning");
                            return;
                        }
                    }

                    say(
                        ctx,
                        `sherpa wake ready: ${result.detail}`
                            + (wasRunning ? " (voice restarted)" : ". Start voice with /voice on"),
                        "info",
                    );
                    return;
                }

                case "asr": {
                    // Wake word by speech recognition, for voices the 3.3M keyword
                    // spotter cannot hear at any threshold. Matching is on *text*, so
                    // `wakePhrases` finally means something in native mode.
                    const target = runtime.getConfig().asrModelDir;
                    const dir = resolvedAsrModelDir(target);
                    const installed = asrModelStatus(dir);

                    if (installed.ok && value !== "force") {
                        runtime.patch({ wakeEngine: "asr" });
                        say(ctx, `asr wake already installed (${dir}); engine set to asr`, "info");
                        return;
                    }

                    const wasRunning = runtime.controller()?.running ?? false;

                    say(
                        ctx,
                        `Installing the ASR wake model (${(ASR_MODEL.bytes / 1024 / 1024).toFixed(0)} MB). `
                        + "It recognises words rather than acoustics, so it works on voices the phrase spotter misses.",
                        "info",
                    );

                    const downloaded = await downloadAsrModel((line) => say(ctx, line, "info"), target || undefined);

                    if (!downloaded.ok) {
                        say(ctx, `asr model: ${downloaded.detail}`, "warning");
                        return;
                    }

                    runtime.patch({ wakeEngine: "asr" });

                    if (wasRunning) {
                        try {
                            await runtime.stop();
                            await runtime.start();
                        } catch (error) {
                            say(ctx, `installed, but restarting voice failed: ${String(error)}`, "warning");
                            return;
                        }
                    }

                    say(
                        ctx,
                        `asr wake ready: ${downloaded.detail}`
                            + (wasRunning ? " (voice restarted)" : ". Start voice with /voice on"),
                        "info",
                    );
                    return;
                }

                case "key":
                    if (!value) {
                        const controller = runtime.controller();
                        const source = runtime.getConfig().apiKey
                            ? "config (pi-voice.json)"
                            : controller?.keySource ?? "not resolved (auth.json → env → Pi provider)";
                        say(ctx, `api key: ${source}`, "info");
                        return;
                    }
                    if (value === "clear") {
                        runtime.patch({ apiKey: "" });
                        say(ctx, "stored key cleared; auth.json / env will be used", "info");
                        return;
                    }
                    runtime.patch({ apiKey: value });
                    say(ctx, "api key saved", "info");
                    return;

                case "announce": {
                    const enabled = value ? /^(on|true|yes|1)$/i.test(value) : !runtime.getConfig().announce;
                    runtime.patch({ announce: enabled });
                    say(ctx, `announce ${enabled ? "on" : "off"}`, "info");
                    return;
                }

                case "debug": {
                    const enabled = value ? /^(on|true|yes|1)$/i.test(value) : !runtime.getConfig().debug;
                    runtime.patch({ debug: enabled });
                    say(ctx, `debug ${enabled ? "on" : "off"} (PI_VOICE_DEBUG)`, "info");
                    return;
                }

                case "set": {
                    if (!value) {
                        say(ctx, "usage: /voice set {\"alwaysOn\":true}", "warning");
                        return;
                    }

                    try {
                        const patch = JSON.parse(value) as Partial<VoiceConfig>;
                        runtime.patch(patch);
                        say(ctx, "config updated", "info");
                    } catch (error) {
                        say(ctx, `bad json: ${String(error)}`, "error");
                    }
                    return;
                }

                case "help":
                    say(
                        ctx,
                        "subcommands:\n"
                        + "  status · diagnose · on · off · restart · listen · sleep\n"
                        + "  always-on [on|off] · announce [on|off] · debug [on|off]\n"
                        + "  model <id> · voice-name <name> · autonomy <level>\n"
                        + "  wake-engine <engine> · sherpa · asr · mic [seconds]\n"
                        + "  key [<key>|clear] · set <json>",
                        "info",
                    );
                    return;

                case "diagnose":
                case "doctor": {
                    say(ctx, "probing the Live API with your key…", "info");

                    try {
                        say(ctx, await runtime.diagnose(), "info");
                    } catch (error) {
                        say(ctx, `diagnose failed: ${String(error)}`, "error");
                    }
                    return;
                }

                default:
                    say(ctx, "unknown subcommand. Try /voice help", "warning");
            }
        },
    });
}