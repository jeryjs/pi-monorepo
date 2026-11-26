/**
 * `/voice` command surface. No arguments opens the settings TUI; subcommands
 * remain for scripting and quick actions.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { capabilitiesFor, describeModels, liveModelIds } from "./capabilities.ts";
import { completeVoiceArguments } from "./completions.ts";
import type { VoiceConfig } from "./config.ts";
import type { VoiceRuntime } from "./runtime.ts";
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
        `always-on: ${config.alwaysOn ? "on" : "off"} · engine ${config.wakeEngine} · compute ${config.compute}`,
        `audio: ${config.audio}`,
        `autonomy: ${config.autonomy}${config.voiceApprovals ? " (voice approvals)" : ""}`,
        `tools: ${capabilities.asyncTools ? "async" : "sync"} function calling · search ${config.searchGrounding ? "on" : "off"}`,
        `VAD: ${config.vadSilenceMs}ms silence, ${config.vadPrefixMs}ms prefix · barge-in ${config.bargeIn ? "on" : "off"}`,
        `idle sleep: ${Math.round(config.idleSleepMs / 1000)}s · digest ${config.digestTurns} turns`,
    ];

    if (controller?.running) {
        lines.push(`page: ${controller.url}`);
        lines.push(`pages connected: ${controller.peerCount}`);
    }

    lines.push(`wake: ${config.alwaysOn ? "on" : "off (enable with /voice always-on on or the page toggle)"}`);

    if (controller?.lastError) {
        lines.push(`last error: ${controller.lastError}`);
    }

    return lines.join("\n");
}

export function registerVoiceCommands(pi: ExtensionAPI, runtime: VoiceRuntime): void {
    pi.registerCommand("voice", {
        description: "Control the Gemini Live voice assistant (status, on, off, url, listen, sleep, always-on, model, voice, autonomy, wake, compute, key, debug)",
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

                        case "open": {
                            const controller = runtime.controller();

                            if (!controller?.running || !controller.url) {
                                say(ctx, "browser transport is off: set Transport to browser", "warning");
                                return;
                            }

                            controller.openPage();
                            say(ctx, controller.url, "info");
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

                case "on":
                case "start": {
                    try {
                        await runtime.start();
                        const controller = runtime.controller();
                        say(ctx, `voice on\npage: ${controller?.url ?? "starting"}`, "info");
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

                case "restart":
                    await runtime.stop();
                    await runtime.start();
                    say(ctx, "voice restarted", "info");
                    return;

                case "url": {
                    const controller = runtime.controller();

                    if (!controller?.running) {
                        say(ctx, "voice is off: /voice on", "warning");
                        return;
                    }

                    say(ctx, controller.url ?? "", "info");
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

                    if (!["auto", "sherpa", "webspeech", "energy"].includes(engine)) {
                        say(ctx, "wake engine: auto | sherpa | webspeech | energy", "warning");
                        return;
                    }

                    runtime.patch({ wakeEngine: engine as VoiceConfig["wakeEngine"] });
                    say(ctx, `wake engine: ${engine}`, "info");
                    return;
                }

                case "compute": {
                    const backend = value.toLowerCase();

                    if (!["auto", "cpu", "webgpu", "webnn"].includes(backend)) {
                        say(ctx, "compute: auto | cpu | webgpu | webnn", "warning");
                        return;
                    }

                    runtime.patch({ compute: backend as VoiceConfig["compute"] });
                    say(ctx, `compute: ${backend} (webnn can use the NPU)`, "info");
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
                        + "  status · diagnose · on · off · restart · url · listen · sleep\n"
                        + "  always-on [on|off] · announce [on|off] · debug [on|off]\n"
                        + "  model <id> · voice-name <name> · autonomy <level>\n"
                        + "  wake-engine <engine> · compute <backend> · key [<key>|clear]\n"
                        + "  set <json>",
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