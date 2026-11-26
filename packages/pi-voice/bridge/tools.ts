/**
 * The functions the voice model may call to drive Pi (and to control its own
 * listening behaviour). Declarations are filtered by model capability.
 */

import type { ModelCapabilities } from "../capabilities.ts";
import type { VoiceConfig } from "../config.ts";
import type { FunctionDeclaration, FunctionResponse } from "../live/protocol.ts";
import type { ToolCall } from "../live/session.ts";
import type { AgentBridge } from "./agent.ts";

export interface VoiceControl {
    /** Stop streaming/responding until the wake phrase (or an explicit wake). */
    sleep(reason?: string): void;
    /** Resume listening immediately. */
    wake(): void;
    /** Enable/disable the always-on wake listener. */
    setAlwaysOn(value: boolean): void;
    /** Interrupt the main Pi agent. */
    interruptAgent(): void;
    /** Resolve a pending voice approval. */
    answerApproval(id: string, allow: boolean, reason?: string): boolean;
}

export interface ToolDeps {
    config: VoiceConfig;
    capabilities: ModelCapabilities;
    bridge: AgentBridge;
    control: VoiceControl;
}

const obj = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
});

export function functionDeclarations(capabilities: ModelCapabilities): FunctionDeclaration[] {
    const ask: FunctionDeclaration = {
        name: "pi_ask",
        description:
            "Send a request, question or instruction to the main Pi coding agent. Use this for anything "
            + "that needs Pi's own tools, files, terminal or models. You keep talking while Pi works; you "
            + "will be told when Pi replies.",
        parameters: obj(
            {
                message: { type: "string", description: "What Pi should do, phrased as the user would phrase it." },
                mode: {
                    type: "string",
                    enum: ["queue", "steer"],
                    description: "queue (default) sends it as the next message; steer interrupts Pi's current run.",
                },
            },
            ["message"],
        ),
    };

    if (capabilities.asyncTools) {
        ask.behavior = "NON_BLOCKING";
    }

    const declarations: FunctionDeclaration[] = [
        {
            name: "pi_status",
            description:
                "Check what the main Pi agent is doing right now (idle, working, which tool, latest result). "
                + "Call this before answering questions about Pi's progress.",
            parameters: obj({}),
        },
        {
            name: "pi_recent",
            description: "Read the most recent messages between the user and the main Pi agent.",
            parameters: obj({ count: { type: "integer", minimum: 1, maximum: 10, description: "How many recent messages." } }),
        },
        ask,
        {
            name: "pi_stop",
            description: "Stop the main Pi agent's current work immediately.",
            parameters: obj({}),
        },
        {
            name: "voice_sleep",
            description:
                "Stop listening until the wake phrase. Call this when the user signals they are done talking "
                + "(finished, leaving, goodnight, “we can stop”, “that's all”), after one short goodbye.",
            parameters: obj({ reason: { type: "string" } }),
        },
        {
            name: "voice_always_on",
            description: "Turn the always-on wake-word listener on or off.",
            parameters: obj({ enabled: { type: "boolean" } }, ["enabled"]),
        },
        {
            name: "voice_approve",
            description:
                "Answer a pending tool-approval request from Pi. Only use the id you were given when asking "
                + "the user to approve or deny.",
            parameters: obj(
                {
                    id: { type: "string", description: "The approval request id." },
                    allow: { type: "boolean", description: "true to allow, false to deny." },
                    reason: { type: "string" },
                },
                ["id", "allow"],
            ),
        },
        {
            name: "voice_note",
            description: "Save a short note into the Pi session so it is not lost.",
            parameters: obj({ text: { type: "string" } }, ["text"]),
        },
    ];

    return declarations;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];

    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
    const value = args[key];

    return typeof value === "boolean" ? value : undefined;
}

export async function dispatchTool(call: ToolCall, deps: ToolDeps): Promise<FunctionResponse> {
    const { bridge, control, config } = deps;
    const respond = (response: Record<string, unknown>): FunctionResponse => ({ id: call.id, name: call.name, response });

    switch (call.name) {
        case "pi_status": {
            const status = bridge.status;
            const digest = bridge.digest({ turns: config.digestTurns, chars: config.digestChars });

            return respond({
                state: status.busy ? "working" : "idle",
                active_tool: status.activeTool ?? null,
                turn: status.turnIndex,
                last_assistant: status.lastAssistant ? status.lastAssistant.slice(0, 600) : null,
                digest,
            });
        }

        case "pi_recent": {
            const count = typeof call.args.count === "number" ? Math.min(10, Math.max(1, call.args.count)) : 3;
            const text = bridge.recentAssistant(count);

            return respond({ messages: text.map((entry) => entry.slice(0, 600)) });
        }

        case "pi_ask": {
            const message = stringArg(call.args, "message");

            if (!message) {
                return respond({ error: "message is required" });
            }

            const mode = stringArg(call.args, "mode") === "steer" ? "steer" : "queue";

            if (!bridge.ask(message, mode)) {
                return respond({ error: "could not deliver the message to Pi; tell the user it did not go through" });
            }

            return respond({ status: mode === "steer" ? "steering" : "sent" });
        }

        case "pi_stop": {
            if (config.autonomy === "concierge") {
                return respond({ error: "stopping Pi is disabled at the current autonomy level" });
            }

            // Really aborts the running turn (ctx.abort) plus a steering message;
            // `control.interruptAgent()` owns both, so it is not repeated here.
            control.interruptAgent();

            return respond({ status: "stopping" });
        }

        case "voice_sleep": {
            control.sleep(stringArg(call.args, "reason"));

            return respond({ status: "sleeping" });
        }

        case "voice_always_on": {
            const enabled = booleanArg(call.args, "enabled");

            if (enabled === undefined) {
                return respond({ error: "enabled is required" });
            }

            control.setAlwaysOn(enabled);

            return respond({ always_on: enabled });
        }

        case "voice_approve": {
            const id = stringArg(call.args, "id");
            const allow = booleanArg(call.args, "allow");

            if (!id || allow === undefined) {
                return respond({ error: "id and allow are required" });
            }

            const known = control.answerApproval(id, allow, stringArg(call.args, "reason"));

            return respond({ status: known ? "recorded" : "unknown_id" });
        }

        case "voice_note": {
            const text = stringArg(call.args, "text");

            if (!text) {
                return respond({ error: "text is required" });
            }

            bridge.note(text);

            return respond({ status: "saved" });
        }

        default:
            return respond({ error: `unknown function: ${call.name}` });
    }
}
