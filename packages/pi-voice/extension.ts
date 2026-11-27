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
import { registerVoiceCommands, type VoiceRuntime } from "./commands.ts";
import { diagnoseLive } from "./probe.ts";
import { resolveGeminiKey, type KeyRegistry } from "./keychain.ts";
import { getController, removeController, setController } from "./registry.ts";
import { liveModelIds } from "./capabilities.ts";
import { buildSystemInstruction } from "./bridge/prompt.ts";
import { functionDeclarations } from "./bridge/tools.ts";
import { createSetupBuilder } from "./live/setup.ts";
import { setDebug, warn } from "./util.ts";

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
            return `${rule.label}: ${command.slice(0, 160)}`;
        }
    }

    return undefined;
}

export default function voiceExtension(pi: ExtensionAPI): void {
    let config = loadVoiceConfig();
    let context: ExtensionContext | undefined;
    let controller: VoiceController | undefined;

    setDebug(config.debug);

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
            controller = new VoiceController(pi, context, config);
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

        setDebug(config.debug);

        const result = controller?.updateConfig(config);
        refreshStatus();

        // Transport-level settings (input device, port, AEC mode, wake engine) only
        // exist inside the rebuilt process side: server, ffmpeg capture, player. That
        // result used to be discarded, so those settings silently did nothing until
        // the next manual restart.
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

            if (!resolved) {
                return "no Gemini key found (pi-voice.json → auth.json → env → Pi provider)";
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

            return lines.join("\n");
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
        setDebug(config.debug);
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
                    `model: ${config.model}`,
                    `wake engine: ${controller?.wakeEngineActive ?? "off"}`,
                    `always-on: ${config.alwaysOn}`,
                    `start: ${config.alwaysOn && config.connectOnWake ? "asleep until the wake phrase" : "connected"}`,
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

                controller.speak(text);

                return { content: [{ type: "text", text: "spoken" }] };
            }

            if (action === "listen") {
                controller.wake();

                return { content: [{ type: "text", text: "listening" }] };
            }

            if (action === "sleep") {
                controller.sleep("agent");

                return { content: [{ type: "text", text: "asleep" }] };
            }

            if (action === "always_on") {
                const enabled = params.enabled === true;
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