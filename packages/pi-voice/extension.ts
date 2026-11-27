/**
 * pi-voice extension entry.
 *
 * Wires the voice controller into a Pi session, gates risky tool calls through
 * spoken approval, and exposes a `voice` tool so the main agent can talk back.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadVoiceConfig, patchVoiceConfig, saveVoiceConfig, type VoiceConfig } from "./config.ts";
import { VoiceController, type StartResult } from "./controller.ts";
import { describeStart, registerVoiceCommands, type VoiceRuntime } from "./commands.ts";
import { diagnoseLive } from "./probe.ts";
import { resolveGeminiKey, type KeyRegistry } from "./keychain.ts";
import { getController, removeController, setController } from "./registry.ts";
import { liveModelIds } from "./capabilities.ts";
import { buildSystemInstruction } from "./bridge/prompt.ts";
import { functionDeclarations } from "./bridge/tools.ts";
import { createSetupBuilder } from "./live/setup.ts";
import {
    VOICE_ANSWER_CHANNEL,
    VOICE_QUESTION_ACCEPTED_CHANNEL,
    VOICE_QUESTION_CHANNEL,
    VOICE_QUESTION_WITHDRAW_CHANNEL,
    parseQuestionRequest,
    questionsFromArgs,
} from "./question.ts";
import { NativeTransport } from "./audio/native.ts";
import { debugFromEnv, redactSecrets, setDebug, warn } from "./util.ts";

/** Commands that should never run without a human saying yes. */
const RISKY: { pattern: RegExp; label: string }[] = [
    { pattern: /\brm\s+-[a-z]*[rf]/i, label: "recursive delete" },
    { pattern: /\bgit\s+push\b/i, label: "push to a remote" },
    { pattern: /\bgit\s+reset\s+--hard\b/i, label: "hard reset" },
    { pattern: /\bgit\s+clean\s+-[a-z]*f/i, label: "clean untracked files" },
    { pattern: /\bsudo\b/i, label: "sudo" },
    { pattern: /\bnpm\s+publish\b/i, label: "publish a package" },
    { pattern: /\bdrop\s+(table|database)\b/i, label: "drop a database object" },
    { pattern: /\bdel\s+\/[sqf]/i, label: "forced delete" },
    { pattern: /\bRemove-Item\b[\s\S]*-Recurse/i, label: "recursive delete" },
    { pattern: /\bshutdown\b/i, label: "shutdown" },
    { pattern: /\bformat\s+[a-z]:/i, label: "format a drive" },
    { pattern: /\|\s*(ba)?sh\b/, label: "pipe into a shell" },
];

/**
 * Native audio preflight for `/voice diagnose`.
 *
 * The ffmpeg failure path points the user here, and ffmpeg/ffplay are exactly what
 * goes missing on a fresh machine — a diagnose that only reported the Gemini key
 * sent people to the wrong place.
 */
function nativeDiagnosis(config: VoiceConfig): string {
    if (NativeTransport.available(config)) {
        const input = config.nativeInput.trim() || "auto-detected";

        return `audio: ffmpeg + ffplay ok · input: ${input} · echo: ${config.nativeAec}`;
    }

    const missing = NativeTransport.describeMissing(config);

    return `audio: MISSING ${missing.join(", ")} — install ffmpeg (it ships ffplay)`;
}

function commandOf(input: unknown): string {
    if (!input || typeof input !== "object") {
        return "";
    }

    const record = input as Record<string, unknown>;

    return typeof record.command === "string" ? record.command : "";
}

function riskOf(toolName: string, input: unknown): string | undefined {
    if (toolName !== "bash" && toolName !== "powershell") {
        return undefined;
    }

    const command = commandOf(input);

    for (const rule of RISKY) {
        if (rule.pattern.test(command)) {
            // This summary is handed to the voice model with "ask the user to allow or
            // deny" — the model reads it back out loud and the whole prompt goes to
            // Gemini. A command line carrying a token was therefore transmitted and
            // spoken; redact before it leaves the process.
            return `${rule.label}: ${redactSecrets(command.slice(0, 160))}`;
        }
    }

    return undefined;
}

export default function voiceExtension(pi: ExtensionAPI): void {
    let config = loadVoiceConfig();
    let context: ExtensionContext | undefined;
    let controller: VoiceController | undefined;
    // The extension API object is replaced on `/reload` (and the old one rejects
    // events), while the controller survives; the answer callback reads this.
    let livePi = pi;

    /**
     * Apply the debug switch: the config file *or* the environment.
     *
     * `setDebug(config.debug)` ran on every config load and overwrote the environment
     * unconditionally, so the documented `PI_VOICE_DEBUG=1` did nothing unless the
     * setting was also on in pi-voice.json.
     */
    const applyDebug = (from: VoiceConfig = config): void => {
        const viaEnv = debugFromEnv();

        setDebug(from.debug || viaEnv, viaEnv ? "env" : "config");
    };

    applyDebug();

    pi.registerFlag("voice", {
        description: "Start with voice enabled and always-on (waiting for the wake phrase)",
        type: "boolean",
        default: false,
    });

    const refreshStatus = (ctx: ExtensionContext | undefined = context): void => {
        try {
            if (controller?.running) {
                controller.refreshStatus(true);
            } else {
                ctx?.ui.setStatus("voice", undefined);
            }
        } catch {
            // status bar may not exist in every mode
        }
    };

    /**
     * Tell the user something that used to only reach stderr.
     *
     * With debug off there is no console output at all, so a failure that only called
     * `warn()` would be invisible — and "voice never started" is exactly the kind of
     * thing that must not be silent.
     */
    const notify = (kind: "info" | "warning" | "error", message: string): void => {
        try {
            context?.ui.notify(message, kind);
        } catch {
            // no UI in this mode; `recentWarnings()` still has it for /voice status
        }
    };

    const start = async (): Promise<StartResult> => {
        if (!context) {
            throw new Error("voice cannot start before a Pi session exists");
        }

        if (!config.enabled) {
            throw new Error('voice is disabled: /voice set {"enabled":true}');
        }

        if (!controller) {
            controller = new VoiceController(pi, context, config, {
                // The voice model's `voice_always_on` tool changes a setting from inside
                // the controller; persist it here so it survives the next start.
                onConfigChange: (next) => {
                    config = next;

                    try {
                        saveVoiceConfig(config);
                    } catch (error) {
                        warn("config", `could not save pi-voice.json: ${String(error)}`);
                    }
                },
                // A spoken answer goes back to whichever extension asked the question,
                // over the shared event bus (see question.ts). `livePi` and not `pi`:
                // the controller survives `/reload`, whose new API object rejects events
                // emitted through the old one.
                onQuestionAnswer: (result) => {
                    try {
                        livePi.events.emit(VOICE_ANSWER_CHANNEL, result);
                    } catch (error) {
                        warn("extension", `could not relay an answer: ${String(error)}`);
                    }
                },
            });
            // `pi_stop` must really abort the running turn; the context is replaced on
            // reload, so read it through the closure instead of capturing a value.
            controller.setAgentAbort(() => {
                try {
                    context?.abort();
                } catch (error) {
                    warn("extension", `abort failed: ${String(error)}`);
                }
            });
            setController(context.cwd, controller);
        } else {
            controller.updateConfig(config);
        }

        try {
            const result = await controller.start();
            refreshStatus();

            return result;
        } catch (error) {
            // A failed start (lock held, no ffmpeg, no key) must not leave a
            // half-registered controller behind.
            if (!controller.running) {
                removeController(context.cwd, controller);
                controller = undefined;
            }

            throw error;
        }
    };

    const stop = async (): Promise<void> => {
        await controller?.stop();

        if (context) {
            removeController(context.cwd, controller);
        }

        controller = undefined;
        refreshStatus();
    };

    /** Coalesces the automatic transport rebuild that some settings require. */
    let rebuilding: Promise<void> | undefined;

    const applyConfig = (patch: Partial<VoiceConfig>): VoiceConfig => {
        config = patchVoiceConfig(config, patch);

        // A read-only or locked settings file must not break the command.
        try {
            saveVoiceConfig(config);
        } catch (error) {
            warn("config", `could not save pi-voice.json: ${String(error)}`);
        }

        applyDebug(config);

        const result = controller?.updateConfig(config);
        refreshStatus();

        // Transport-level settings (input device, AEC mode, wake engine) only exist
        // inside the rebuilt process side: ffmpeg capture, player, wake spotter.
        // That result used to be discarded, so those settings silently did nothing
        // until the next manual restart.
        if (result?.restart && controller?.running && !rebuilding) {
            rebuilding = (async () => {
                try {
                    await stop();
                    await start();
                } catch (error) {
                    warn("extension", `restart after a settings change failed: ${String(error)}`);
                    notify("error", `Voice did not restart: ${String(error)}. Run /voice restart.`);
                } finally {
                    rebuilding = undefined;
                }
            })();
        }

        return config;
    };

    const runtime: VoiceRuntime = {
        getConfig: () => config,
        patch: applyConfig,
        controller: () => controller,
        start,
        stop,
        diagnose: async () => {
            const resolved = await resolveGeminiKey({
                configKey: config.apiKey,
                registry: context?.modelRegistry as unknown as KeyRegistry,
            });

            const native = nativeDiagnosis(config);

            if (!resolved) {
                return `no Gemini key found (pi-voice.json → auth.json → env → Pi provider)\n\n${native}`;
            }

            const configured = config.model;
            const alternates = liveModelIds().filter((id) => id !== configured).slice(0, 2);
            const results = await diagnoseLive(resolved.key, [configured, ...alternates], {
                thinkingLevel: config.thinkingLevel,
                // Probe the real setup, not a minimal one: grounding failures only
                // show up when the actual tools/generation config is sent.
                buildSetup: (caps) => {
                    const forModel = { ...config, model: caps.id };

                    return createSetupBuilder({
                        config: forModel,
                        capabilities: caps,
                        systemInstruction: buildSystemInstruction({
                            config: forModel,
                            capabilities: caps,
                            cwd: context?.cwd ?? process.cwd(),
                            alwaysOn: config.alwaysOn,
                        }),
                        tools: functionDeclarations(caps),
                    })(undefined);
                },
            });

            const lines = [`key: ${resolved.source} (${resolved.key.length} chars)`, ""];
            for (const result of results) {
                lines.push(`${result.ok ? "ok  " : "FAIL"} ${result.model.padEnd(42)} ${result.detail} (${result.ms}ms)`);
            }

            if (results.some((result) => !result.ok && /quota|billing/i.test(result.detail))) {
                lines.push("", "Quota/billing refusal: check this project's billing in AI Studio, or wait for the rate window.");
            }

            return [`${lines.join("\n")}`, "", native].join("\n");
        },
    };

    pi.on("session_start", async (event, ctx) => {
        context = ctx;
        config = loadVoiceConfig();

        // `pi --voice` starts enabled and listening for the wake phrase.
        const forced = pi.getFlag("voice") === true;

        if (forced) {
            config = patchVoiceConfig(config, { enabled: true, autoStart: true, alwaysOn: true });
        }

        const existing = getController(ctx.cwd);

        // `/reload` disposes the old runner but not the process. Reclaim the live
        // controller instead of resuming an already-closed Live session (1008) or
        // opening a duplicate.
        if (existing?.running && event.reason === "reload") {
            controller = existing;
            // Before rebind: it closes the pending prompts through the answer callback
            // above, which reads this variable.
            livePi = pi;
            controller.rebind(pi, ctx);

            // `/reload` deliberately keeps the running session, so transport-level
            // settings that changed on disk are reported rather than applied here.
            if (controller.updateConfig(config).restart) {
                warn("extension", "transport settings changed; run /voice restart to apply them");
                notify("warning", "Transport settings changed; run /voice restart to apply them.");
            }

            controller.setAgentAbort(() => {
                try {
                    context?.abort();
                } catch (error) {
                    warn("extension", `abort failed: ${String(error)}`);
                }
            });

            if (forced) {
                controller.setAlwaysOn(true);
            }

            refreshStatus(ctx);

            return;
        }

        if (existing) {
            await existing.stop();
            removeController(ctx.cwd, existing);
        }

        controller = undefined;
        applyDebug();
        refreshStatus(ctx);

        if (config.enabled && (config.autoStart || forced)) {
            try {
                await start();

                if (forced) {
                    controller?.setAlwaysOn(true);
                }
            } catch (error) {
                warn("extension", `auto-start failed: ${String(error)}`);
                // Silence here means "voice is not running and nothing said so".
                notify("error", `Voice did not start: ${String(error)}`);
            }
        }
    });

    pi.on("session_shutdown", async (event) => {
        // Keep the live controller across `/reload`; the reloaded module reclaims it.
        if (event.reason === "reload") {
            return;
        }

        await stop();
    });

    // Spoken answers for questions other extensions are blocked on.
    //
    // The protocol lives on `pi.events`, so any extension can offer a prompt to voice
    // without importing this package (see question.ts and the README). Registration
    // happens once, outside start(), because the controller comes and goes.
    pi.events.on(VOICE_QUESTION_CHANNEL, (payload) => {
        const request = parseQuestionRequest(payload);

        if (!request) {
            warn("extension", "ignored a malformed voice:question payload");

            // The provider is blocked on something nobody can answer: tell it, when the
            // id survived parsing, so a headless one fails instead of waiting.
            const id = (payload as { id?: unknown } | undefined)?.id;

            if (typeof id === "string" && id) {
                try {
                    livePi.events.emit(VOICE_QUESTION_ACCEPTED_CHANNEL, { id, spoken: false, rejected: true });
                } catch {
                    // Nothing listening; the provider keeps its own UI.
                }
            }

            return;
        }

        const spoken = controller?.presentQuestion(request) ?? false;

        // Let a provider that is waiting without a UI fail fast instead of timing out.
        try {
            livePi.events.emit(VOICE_QUESTION_ACCEPTED_CHANNEL, { id: request.id, spoken });
        } catch {
            // Nothing listening; the provider keeps its own UI.
        }
    });

    pi.events.on(VOICE_QUESTION_WITHDRAW_CHANNEL, (payload) => {
        const id = (payload as { id?: unknown } | undefined)?.id;

        if (typeof id === "string" && id) {
            controller?.withdrawQuestion(id);
        }
    });

    // Fallback for a tool that blocks on a human but never offered itself to voice.
    //
    // The provider emits its own `voice:question` from inside execute(), which runs a
    // moment after this event, so the notice is delayed just enough to be skipped when
    // the protocol already covered the same tool call. Without this, an unadopted
    // questionnaire left the voice model completely silent while Pi waited.
    const activeToolCalls = new Set<string>();

    pi.on("tool_execution_start", (event) => {
        const detail = event as { toolName?: string; toolCallId?: string; args?: unknown };
        const toolName = detail.toolName ?? "";
        const prompts = questionsFromArgs(detail.args);
        const toolCallId = detail.toolCallId;

        if (!prompts || !controller?.running) {
            return;
        }

        if (toolCallId) {
            if (activeToolCalls.size > 64) {
                activeToolCalls.clear();
            }

            activeToolCalls.add(toolCallId);
        }

        setTimeout(() => {
            // A tool that returned inside the delay is not waiting on anything; the
            // timer used to announce "Pi is blocked" moments after it finished.
            if (toolCallId && !activeToolCalls.has(toolCallId)) {
                return;
            }

            if (controller?.running && !controller.hasQuestionForToolCall(toolCallId)) {
                controller.announceWaitingForInput(toolName, prompts, toolCallId);
            }
        }, 250);
    });

    pi.on("tool_execution_end", (event) => {
        const toolCallId = (event as { toolCallId?: string }).toolCallId;

        if (toolCallId) {
            activeToolCalls.delete(toolCallId);
        }
    });

    // Spoken approval for risky shell commands.
    pi.on("tool_call", async (event, ctx) => {
        if (!config.enabled || !config.voiceApprovals || config.autonomy !== "approvals") {
            return;
        }

        if (!controller?.approvalAvailable) {
            return;
        }

        const toolName = (event as { toolName?: string }).toolName ?? "";
        const risk = riskOf(toolName, (event as { input?: unknown }).input);

        if (!risk) {
            return;
        }

        try {
            ctx.ui.setStatus("voice", "voice: asking approval");
        } catch {
            // ignore
        }

        const allow = await controller.requestApproval(toolName, risk);

        if (allow === false) {
            try {
                ctx.ui.notify("Voice: denied", "warning");
            } catch {
                // ignore
            }

            return { block: true, reason: "Denied by voice approval" };
        }

        if (allow === undefined) {
            // No answer (nobody listening, voice not running, prompt could not be
            // delivered). Proceed, but say so: voice approval is a convenience
            // here, never a hard gate.
            warn("extension", `no voice answer for ${toolName}; proceeding`);

            try {
                ctx.ui.notify("Voice: no answer, proceeding", "info");
            } catch {
                // ignore
            }
        }

        return;
    });

    // Let the main agent speak and steer the voice channel.
    pi.registerTool({
        name: "voice",
        label: "Voice",
        description:
            "Control the Pi voice channel: speak a line out loud, start/stop listening, put the always-on "
            + "listener to sleep, or read its status.",
        parameters: Type.Object({
            action: Type.Union(
                [
                    Type.Literal("speak"),
                    Type.Literal("listen"),
                    Type.Literal("sleep"),
                    Type.Literal("status"),
                    Type.Literal("always_on"),
                ],
                { description: "What to do." },
            ),
            text: Type.Optional(Type.String({ description: "Line to say (for action=speak)." })),
            enabled: Type.Optional(Type.Boolean({ description: "For action=always_on." })),
        }),
        async execute(_toolCallId, params) {
            const action = params.action as string;

            if (action === "status") {
                const lines = [
                    `running: ${controller?.running ?? false}`,
                    `state: ${controller?.liveState ?? "idle"}`,
                    // The socket state alone said "live" while the mic was muted by
                    // voice_sleep; the agent could not tell whether speaking is heard.
                    `mic: ${controller?.running ? (controller.micOpen ? "open (the model hears you)" : "muted — the wake phrase reopens it, or call voice_listen") : "off"}`,
                    `model: ${config.model}`,
                    `wake engine: ${controller?.wakeEngineActive ?? "off"}`,
                    `always-on: ${config.alwaysOn}`,
                    `start: ${describeStart(config)}`,
                ];

                return { content: [{ type: "text", text: lines.join("\n") }] };
            }

            if (!controller?.running) {
                return { content: [{ type: "text", text: "voice is off: ask the user to run /voice on" }] };
            }

            if (action === "speak") {
                const text = typeof params.text === "string" ? params.text.trim() : "";

                if (!text) {
                    return { content: [{ type: "text", text: "text is required for action=speak" }] };
                }

                // `speak` returns false when the session is reconnecting or closed;
                // answering "spoken" regardless told the main agent the user had heard
                // something they never heard.
                if (!controller.speak(text)) {
                    return { content: [{ type: "text", text: "the voice session could not speak right now (reconnecting or asleep); try again in a moment" }] };
                }

                return { content: [{ type: "text", text: "spoken" }] };
            }

            if (action === "listen") {
                controller.wake();

                return { content: [{ type: "text", text: "listening" }] };
            }

            if (action === "sleep") {
                controller.sleep("agent");

                return { content: [{ type: "text", text: "asleep — the microphone is muted until the wake phrase or a voice_listen call" }] };
            }

            if (action === "always_on") {
                // `params.enabled === true` made an omitted field mean "off": the agent
                // could mute the wake word by calling always_on with no value.
                if (typeof params.enabled !== "boolean") {
                    return { content: [{ type: "text", text: "enabled (true/false) is required for action=always_on" }] };
                }

                const enabled = params.enabled;
                config = patchVoiceConfig(config, { alwaysOn: enabled });

                try {
                    saveVoiceConfig(config);
                } catch (error) {
                    warn("config", `could not save pi-voice.json: ${String(error)}`);
                }

                controller.setAlwaysOn(enabled);

                return { content: [{ type: "text", text: `always-on ${enabled ? "on" : "off"}` }] };
            }

            return { content: [{ type: "text", text: "unknown action" }] };
        },
    });

    registerVoiceCommands(pi, runtime);
}

export { VoiceController } from "./controller.ts";
export { loadVoiceConfig, saveVoiceConfig, DEFAULT_VOICE_CONFIG } from "./config.ts";
export type { VoiceConfig } from "./config.ts";