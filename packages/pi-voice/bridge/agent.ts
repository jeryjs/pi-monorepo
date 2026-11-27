/**
 * AgentBridge: the Pi-facing half of the voice assistant.
 *
 * It watches the session (turns, tools, messages), produces a *compact* digest
 * the voice model can hold in context, forwards spoken requests into Pi, and
 * mediates voice approvals.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clip, log } from "../util.ts";

export interface RecentMessage {
    role: "user" | "assistant";
    text: string;
    at: number;
}

export interface AgentStatus {
    busy: boolean;
    activeTool?: string;
    turnIndex: number;
    lastAssistant?: string;
    lastUser?: string;
    messagesSeen: number;
}

export interface ApprovalRequest {
    toolCallId: string;
    toolName: string;
    summary: string;
}

export interface AgentBridgeEvents {
    /** Pi started/finished a turn or a tool; used for spoken announcements. */
    activity: { kind: "start" | "settled"; text: string };
    /** Pi produced a final assistant message. */
    reply: { text: string };
    turnEnd: { turnIndex: number };
}

type Listener = (payload: never) => void;

function textOf(message: unknown): string {
    if (!message || typeof message !== "object") {
        return "";
    }

    const content = (message as { content?: unknown }).content;

    if (typeof content === "string") {
        return content;
    }

    if (!Array.isArray(content)) {
        return "";
    }

    const parts: string[] = [];

    for (const part of content) {
        if (typeof part === "string") {
            parts.push(part);
            continue;
        }

        if (part && typeof part === "object") {
            const text = (part as { text?: unknown }).text;

            if (typeof text === "string" && text.trim()) {
                parts.push(text);
            }
        }
    }

    return parts.join(" ").trim();
}

/**
 * Conversation role, or `undefined` for anything that is not the conversation.
 *
 * Pi emits `message_end` for tool results and system messages too. Treating every
 * non-user message as an assistant reply meant a tool result was stored as
 * `lastAssistant`, spoken aloud at `agent_settled`, and pasted into the digest —
 * a shell command's output read out as if the agent had said it.
 */
function roleOf(message: unknown): "user" | "assistant" | undefined {
    const role = (message as { role?: unknown } | undefined)?.role;

    return role === "user" ? "user" : role === "assistant" ? "assistant" : undefined;
}

export class AgentBridge {
    readonly #recent: RecentMessage[] = [];
    #status: AgentStatus = { busy: false, turnIndex: 0, messagesSeen: 0 };
    #listeners = new Set<Listener>();
    #pending = new Map<string, (allow: boolean | undefined) => void>();
    #unsubscribes: (() => void)[] = [];
    #approvalSeq = 0;

    readonly #pi: ExtensionAPI;
    readonly #cwd: string;
    readonly #keepMessages: number;

    constructor(pi: ExtensionAPI, cwd: string, keepMessages = 24) {
        this.#pi = pi;
        this.#cwd = cwd;
        this.#keepMessages = keepMessages;
        this.#subscribe();
    }

    private get pi(): ExtensionAPI {
        return this.#pi;
    }

    private get cwd(): string {
        return this.#cwd;
    }

    private get keepMessages(): number {
        return this.#keepMessages;
    }

    get status(): AgentStatus {
        return this.#status;
    }

    on(listener: Listener): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    #emit(payload: unknown): void {
        for (const listener of [...this.#listeners]) {
            try {
                (listener as (value: unknown) => void)(payload);
            } catch (error) {
                log("bridge", "listener threw", error);
            }
        }
    }

    #subscribe(): void {
        // Idempotent: start() after a stop re-attaches the same bridge instance.
        if (this.#unsubscribes.length > 0) {
            return;
        }

        const pi = this.pi;
        // Every subscription is tracked: a restart builds a new bridge, and without
        // this the old handlers stayed attached and kept firing (status flicker,
        // duplicate replies, stale approvals) for the life of the process.
        const track = (off: () => void): void => {
            this.#unsubscribes.push(off);
        };

        track(pi.on("agent_start", () => {
            this.#status = { ...this.#status, busy: true, activeTool: undefined };
            this.#emit({ kind: "activity", activity: { kind: "start", text: "" } });
        }));

        track(pi.on("agent_settled", () => {
            this.#status = { ...this.#status, busy: false, activeTool: undefined };
            const last = this.#status.lastAssistant;
            this.#emit({ kind: "activity", activity: { kind: "settled", text: last ?? "" } });
        }));

        track(pi.on("turn_start", (event) => {
            this.#status = { ...this.#status, turnIndex: event.turnIndex };
        }));

        track(pi.on("turn_end", (event) => {
            this.#emit({ kind: "turnEnd", turnEnd: { turnIndex: event.turnIndex } });
        }));

        track(pi.on("tool_execution_start", (event) => {
            const name = (event as { toolName?: unknown }).toolName;
            this.#status = { ...this.#status, activeTool: typeof name === "string" ? name : undefined };
        }));

        track(pi.on("tool_execution_end", () => {
            this.#status = { ...this.#status, activeTool: undefined };
        }));

        track(pi.on("message_end", (event) => {
            const text = textOf((event as { message?: unknown }).message);

            if (!text) {
                return;
            }

            const role = roleOf((event as { message?: unknown }).message);

            if (!role) {
                return;
            }

            this.#recent.push({ role, text, at: Date.now() });

            if (this.#recent.length > this.keepMessages) {
                this.#recent.splice(0, this.#recent.length - this.keepMessages);
            }

            this.#status = {
                ...this.#status,
                messagesSeen: this.#status.messagesSeen + 1,
                lastAssistant: role === "assistant" ? text : this.#status.lastAssistant,
                lastUser: role === "user" ? text : this.#status.lastUser,
            };

            if (role === "assistant") {
                this.#emit({ kind: "reply", reply: { text } });
            }
        }));
    }

    /**
     * Detach from Pi. Called on restart and on `/reload`, so the discarded bridge
     * never keeps receiving events or leaves an approval promise hanging. The
     * digest history is kept: the same bridge is re-attached by the next start().
     */
    dispose(): void {
        this.detach();
        this.#listeners.clear();
    }

    /** Drop every Pi subscription and resolve pending approvals with `undefined`. */
    detach(): void {
        for (const off of this.#unsubscribes.splice(0, this.#unsubscribes.length)) {
            try {
                off();
            } catch (error) {
                log("bridge", "unsubscribe failed", error);
            }
        }

        this.cancelPending();
    }

    /**
     * Re-attach after a stop. Without this, `/voice off` followed by `/voice on`
     * left the voice agent blind: teardown detached the bridge and nothing
     * subscribed again, so status, replies and approvals never reached it.
     */
    attach(): void {
        this.#subscribe();
    }

    /** Carry digest + status across a `/reload` rebuild of the bridge. */
    adoptFrom(other: AgentBridge): void {
        this.#recent.splice(0, this.#recent.length, ...other.#recent);
        this.#status = { ...other.#status };
    }

    /**
     * Fill the digest from Pi's existing transcript.
     *
     * `message_end` only fires for messages sent while the extension is running, so
     * after `/resume` (or a `/switch`) the bridge knew nothing and the voice model
     * told the user it had no context yet. The transcript Pi is showing is the
     * context; take the tail of it.
     */
    seedTranscript(messages: readonly unknown[]): number {
        const seeded: RecentMessage[] = [];

        for (const message of messages) {
            const text = textOf(message);

            if (!text) {
                continue;
            }

            const role = (message as { role?: unknown })?.role;

            // Only the conversation itself: tool results and system messages would
            // drown the digest in noise the voice model cannot act on anyway.
            if (role !== "user" && role !== "assistant") {
                continue;
            }
            seeded.push({ role, text, at: Date.now() });
        }

        if (seeded.length === 0) {
            return 0;
        }

        // Merge, don't duplicate: `/reload` adopts the previous digest and then
        // seeds from the same transcript.
        const known = new Set(this.#recent.map((entry) => `${entry.role}\u0000${entry.text}`));
        const fresh = seeded.filter((entry) => !known.has(`${entry.role}\u0000${entry.text}`));

        if (fresh.length === 0) {
            return 0;
        }

        this.#recent.push(...fresh);

        if (this.#recent.length > this.keepMessages) {
            this.#recent.splice(0, this.#recent.length - this.keepMessages);
        }

        const lastUser = [...fresh].reverse().find((entry) => entry.role === "user");
        const lastAssistant = [...fresh].reverse().find((entry) => entry.role === "assistant");

        this.#status = {
            ...this.#status,
            messagesSeen: this.#status.messagesSeen + fresh.length,
            lastUser: lastUser?.text ?? this.#status.lastUser,
            lastAssistant: lastAssistant?.text ?? this.#status.lastAssistant,
        };

        return fresh.length;
    }

    /** Resolve every pending approval with `undefined` (caller decides how to treat it). */
    cancelPending(): void {
        const pending = [...this.#pending.values()];
        this.#pending.clear();

        for (const resolve of pending) {
            resolve(undefined);
        }
    }

    // -----------------------------------------------------------------------

    /** Compact, token-cheap description of what Pi is doing right now. */
    digest(opts: { turns: number; chars: number }): string {
        const lines: string[] = [];
        const status = this.#status;

        lines.push(
            `Pi: ${status.busy ? "working" : "idle"}`
                + (status.activeTool ? ` (running ${status.activeTool})` : "")
                + ` | turn ${status.turnIndex}`
                + ` | cwd ${this.cwd}`,
        );

        // The one thing the voice model must never be vague about: what the user
        // actually asked for in the session it is attached to.
        if (status.lastUser) {
            lines.push(`the user's last request in this session: ${clip(status.lastUser, opts.chars)}`);
        }

        const recent = this.#recent.slice(-Math.max(2, opts.turns * 2));

        if (recent.length === 0) {
            lines.push("no messages in this session yet");
        }

        for (const message of recent) {
            const who = message.role === "user" ? "user" : "pi";
            lines.push(`${who}: ${clip(message.text, opts.chars)}`);
        }

        return lines.join("\n");
    }

    recentAssistant(limit = 1): string[] {
        return this.#recent
            .filter((message) => message.role === "assistant")
            .slice(-limit)
            .map((message) => message.text);
    }

    /** Send a spoken request into Pi. `steer` injects mid-run; `queue` waits for the turn to end. */
    ask(message: string, mode: "queue" | "steer" = "steer"): boolean {
        // Both names on purpose. The extension API documents `deliverAs`, but the
        // session validates `streamingBehavior` and throws when neither is present:
        // "Agent is already processing. Specify streamingBehavior...". Because the
        // extension API runs this in the background and only reports the rejection as
        // an extension error, `pi_ask` used to answer "sent" for a message that never
        // reached Pi — every voice request made while Pi was busy was silently lost.
        // `queue` is `followUp` (deliver when the current turn ends), `steer` is steer.
        const behavior = mode === "queue" ? "followUp" : "steer";
        const options = { deliverAs: behavior, streamingBehavior: behavior };

        try {
            // The options shape is intentionally loose across Pi versions.
            (this.pi.sendUserMessage as (content: string, options?: unknown) => void)(message, options);

            return true;
        } catch (error) {
            log("bridge", "sendUserMessage failed", error);

            return false;
        }
    }

    /** Ask Pi's model to stop; implemented as a steering instruction. */
    interrupt(): void {
        this.ask("Stop what you are doing and wait for further instructions.", "steer");
    }

    /** Save a note into the Pi session. Returns false when the entry could not be written. */
    note(text: string): boolean {
        try {
            this.pi.appendEntry("voice.note", { text, at: new Date().toISOString() });

            return true;
        } catch (error) {
            log("bridge", "appendEntry failed", error);

            return false;
        }
    }

    // ---- approvals ----------------------------------------------------------

    /**
     * Ask the voice channel to approve a risky tool call. Resolves with
     * `true`/`false`, or `undefined` on timeout (caller should then defer to
     * Pi's normal flow rather than block forever).
     */
    requestApproval(request: Omit<ApprovalRequest, "toolCallId">, timeoutMs = 20_000): Promise<boolean | undefined> {
        const id = `voice-${++this.#approvalSeq}`;
        const payload = { ...request, toolCallId: id };

        return new Promise<boolean | undefined>((resolve) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                resolve(undefined);
            }, timeoutMs);

            (timer as { unref?: () => void }).unref?.();

            this.#pending.set(id, (allow) => {
                clearTimeout(timer);
                this.#pending.delete(id);
                resolve(allow);
            });

            this.#emit({ kind: "approval", approval: payload });
        });
    }

    /** Called when the voice model answers an approval. */
    answerApproval(id: string, allow: boolean): boolean {
        const resolver = this.#pending.get(id);

        if (!resolver) {
            return false;
        }

        resolver(allow);

        return true;
    }

    get hasPendingApproval(): boolean {
        return this.#pending.size > 0;
    }
}
