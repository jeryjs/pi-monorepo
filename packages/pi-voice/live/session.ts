/**
 * LiveSession: owns one Gemini Live WebSocket and keeps a *logical* session
 * alive across the server's ~10 minute connection resets via session resumption.
 *
 * Responsibilities kept here (and only here):
 *   - open/setup the socket, parse server messages
 *   - auto-reconnect with backoff, resuming from the last resumption handle
 *   - upstream gating (streaming vs. sleeping) without dropping the session
 *   - tool-call, transcription, interruption, usage and GoAway signals
 */

import { Emitter, backoffDelay, log, sleep, warn } from "../util.ts";
import {
    audioInputMessage,
    clientContentMessage,
    decodePcmBase64,
    durationToMs,
    liveSocketUrl,
    parseServerMessage,
    toolResponseMessage,
    type FunctionResponse,
    type ServerMessage,
} from "./protocol.ts";

export type LiveState = "idle" | "connecting" | "live" | "sleeping" | "reconnecting" | "closed" | "error";

export interface ToolCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
}

export interface LiveSessionEvents {
    audio: Uint8Array;
    transcript: { side: "user" | "model"; text: string; final: boolean };
    toolCall: ToolCall;
    toolCancel: string[];
    interrupted: undefined;
    turnComplete: undefined;
    idle: undefined;
    /** Retry with a fresh session: the stored resumption handle was rejected. */
    handleInvalid: undefined;
    /**
     * The socket is gone and will not be retried automatically: the caller should
     * go back to wake-word listening, where the wake phrase reconnects. Sent for a
     * bare "Session closed" and after the retry budget is spent.
     */
    dormant: { reason: string };
    state: LiveState;
    resumption: string;
    goAway: number;
    usage: { total: number; prompt: number; response: number };
    error: Error;
    inputActivity: "start" | "end";
}

export interface LiveSessionOptions {
    apiKey: string;
    /** Build the `setup` object; the session passes the current resumption handle. */
    buildSetup: (resumptionHandle: string | undefined) => Record<string, unknown>;
    /** Start with the mic gated (always-on wake-word mode). */
    startSleeping?: boolean;
    /**
     * A wake word can reconnect on demand. When true, closes that are pointless to
     * retry (the server's own "Session closed", retries exhausted) go *dormant*
     * instead of fatal, so saying the wake phrase opens a fresh socket.
     */
    wakeAvailable?: boolean;
}

interface WebSocketLike {
    readyState: number;
    /** Gemini sends server messages as binary frames; force ArrayBuffer delivery. */
    binaryType?: string;
    send(data: string | Uint8Array): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: string, listener: (event: { data?: unknown; code?: number; reason?: string; message?: string }) => void): void;
}

const OPEN = 1;
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Close reasons that will never succeed by retrying. Retrying a quota/billing
 * refusal is what turns one 1011 into a storm of rejected Live sessions.
 */
const FATAL_REASONS = [
    /quota/i,
    /exceeded your current quota/i,
    /billing/i,
    /resource_exhausted/i,
    /api key not valid/i,
    /api_key_invalid/i,
    /permission_denied/i,
    /unauthenticated/i,
    /thinking level must be specified/i,
];

export function isFatalClose(code: number | undefined, reason: string | undefined): boolean {
    // 1007 = invalid argument: the setup itself is wrong, retrying cannot help.
    if (code === 1007) {
        return true;
    }

    // 1008 = policy violation, but the same code carries the server's plain
    // "Session closed" when it ends an idle session. That one is recoverable, and
    // treating it as fatal is what left voice dead until Pi was restarted.
    if (code === 1008) {
        return !isDormantClose(code, reason);
    }

    const detail = reason ?? "";

    return FATAL_REASONS.some((pattern) => pattern.test(detail));
}

/**
 * A close that means "this socket is finished" rather than "this setup is broken".
 *
 * Gemini ends an idle or long-lived session with `1008: Session closed`; the right
 * response is to stop talking to a socket that is gone and wait to be woken, not to
 * mark the voice unusable.
 */
export function isDormantClose(code: number | undefined, reason: string | undefined): boolean {
    if (code !== 1008) {
        return false;
    }

    const detail = (reason ?? "").trim();

    return detail === "" || /session\s+(is\s+)?closed|^closed$|expired|goaway/i.test(detail);
}

/** A rejected resumption handle: recoverable by starting a fresh session. */
export function isStaleHandleClose(code: number | undefined, reason: string | undefined): boolean {
    if (code !== 1007 && code !== 1008) {
        return false;
    }

    return /session not found|invalid argument/i.test(reason ?? "");
}

export function friendlyCloseError(code: number | undefined, reason: string | undefined): string {
    const detail = (reason ?? "").trim();

    if (/quota|billing|exceeded/i.test(detail)) {
        return `Gemini Live quota/billing refused the session: ${detail} `
            + "Wait for the per-minute window, check billing for this project in AI Studio, or switch model "
            + "with /voice model. Run /voice diagnose to test the key.";
    }

    if (code === 1007) {
        return `Gemini rejected the session setup: ${detail || "invalid argument"}. Run /voice diagnose.`;
    }

    if (/api key|permission|unauthenticated/i.test(detail)) {
        return `Gemini authentication failed: ${detail}. Check /voice key.`;
    }

    return `Gemini Live closed ${code ?? ""}${detail ? ": " + detail : ""}`;
}

function createWebSocket(url: string): WebSocketLike {
    const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;

    if (!Ctor) {
        throw new Error("Global WebSocket is unavailable (Node >= 22 required).");
    }

    const socket = new Ctor(url);
    // Live API frames are JSON delivered as binary; without this they arrive as Blob.
    socket.binaryType = "arraybuffer";

    return socket;
}

function asText(data: unknown): string | undefined {
    if (typeof data === "string") {
        return data;
    }

    if (data instanceof ArrayBuffer) {
        return Buffer.from(data).toString("utf8");
    }

    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    }

    return undefined;
}

export class LiveSession extends Emitter<LiveSessionEvents> {
    #ws: WebSocketLike | undefined;
    #state: LiveState = "idle";
    #handle: string | undefined;
    /** True only when the handle came from persisted state, not from this connection. */
    #handleFromStore = false;
    #attempt = 0;
    #generation = 0;
    #closedByUser = false;
    #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    #streaming: boolean;
    #setupComplete = false;
    #outbox: string[] = [];

    /** Cap on held text so a long outage cannot grow unbounded. */
    static readonly OUTBOX_LIMIT = 64;
    #lastActivity = Date.now();
    #fatal = false;

    readonly #options: LiveSessionOptions;

    constructor(options: LiveSessionOptions) {
        super();
        this.#options = options;
        this.#streaming = !options.startSleeping;
    }

    private get options(): LiveSessionOptions {
        return this.#options;
    }

    get state(): LiveState {
        return this.#state;
    }

    get resumptionHandle(): string | undefined {
        return this.#handle;
    }

    /** Seed the handle to resume on the next connect (from persisted session state). */
    setResumptionHandle(handle: string | undefined): void {
        this.#handle = handle;
        this.#handleFromStore = Boolean(handle);
    }

    get streaming(): boolean {
        return this.#streaming;
    }

    get idleMs(): number {
        return Date.now() - this.#lastActivity;
    }

    /** True when the last failure cannot be fixed by reconnecting. */
    get fatal(): boolean {
        return this.#fatal;
    }

    /** Whether mic audio will reach the model right now. */
    get acceptsMic(): boolean {
        return this.#streaming && this.#state === "live" && this.#setupComplete;
    }

    connect(): void {
        this.#closedByUser = false;

        if (this.#ws) {
            return;
        }

        const generation = ++this.#generation;
        this.#setupComplete = false;
        this.#fatal = false;
        this.#setState(this.#attempt === 0 ? "connecting" : "reconnecting");

        let socket: WebSocketLike;

        try {
            socket = createWebSocket(liveSocketUrl(this.options.apiKey));
        } catch (error) {
            this.#fail(error instanceof Error ? error : new Error(String(error)));
            return;
        }

        this.#ws = socket;

        socket.addEventListener("open", () => {
            if (generation !== this.#generation) {
                return;
            }

            log("live", "socket open; sending setup");
            socket.send(JSON.stringify({ setup: this.options.buildSetup(this.#handle) }));
        });

        socket.addEventListener("message", (event) => {
            if (generation !== this.#generation) {
                return;
            }

            this.#handleData(event.data, generation);
        });

        socket.addEventListener("error", (event) => {
            if (generation !== this.#generation) {
                return;
            }

            const detail = event.message ?? "socket error";
            log("live", detail);
            this.emit("error", new Error(detail));
        });

        socket.addEventListener("close", (event) => {
            if (generation !== this.#generation) {
                return;
            }

            this.#ws = undefined;
            this.#setupComplete = false;
            log("live", "socket closed", event.code, event.reason);

            if (this.#closedByUser) {
                this.#setState("closed");
                return;
            }

            this.#scheduleReconnect(event.code, event.reason);
        });
    }

    /** Gate mic audio on/off without dropping the logical session. */
    setStreaming(streaming: boolean): void {
        if (this.#streaming === streaming) {
            return;
        }

        this.#streaming = streaming;

        if (streaming) {
            this.#lastActivity = Date.now();
            this.#setState(this.#setupComplete ? "live" : this.#state);
        } else {
            // No audioStreamEnd: it is only valid with manual VAD, and we use
            // automatic VAD. Stopping the frames is enough to gate upstream.
            this.#setState("sleeping");
        }
    }

    /** Send a raw 16 kHz mono PCM frame (already int16LE bytes). */
    sendMic(bytes: Uint8Array): void {
        if (!this.acceptsMic) {
            return;
        }

        this.#lastActivity = Date.now();
        this.#send(audioInputMessage(bytes));
    }

    /** Inject text into the live conversation (triggers a model turn). */
    sendText(text: string): void {
        this.#lastActivity = Date.now();
        this.#send(clientContentMessage([{ role: "user", text }], true), true);
    }

    /** Seed conversation history without triggering a model call (cheap context). */
    injectContext(turns: { role: "user" | "model"; text: string }[], turnComplete = true): void {
        this.#send(clientContentMessage(turns, turnComplete), true);
    }

    /** Resolve a function call. */
    sendToolResult(responses: FunctionResponse[]): void {
        this.#send(toolResponseMessage(responses), true);
    }

    /** Cut the model off locally. Server-side barge-in is driven by mic audio. */
    interrupt(): void {
        if (this.#state !== "live") {
            return;
        }

        // activityStart/activityEnd are only valid with manual VAD; sending them
        // under automatic VAD is rejected (1007). The page flushes playback.
        this.emit("interrupted", undefined);
    }

    /** Force a fresh connection now, resuming from the current handle. */
    reconnectNow(): void {
        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = undefined;
        }

        const socket = this.#ws;
        this.#ws = undefined;
        this.#generation++;

        if (socket) {
            try {
                socket.close(1000, "resume");
            } catch {
                // ignore
            }
        }

        // Let the server release the old Live session before opening a new one;
        // overlapping sessions are what trips the concurrent-session quota.
        setTimeout(() => {
            if (!this.#closedByUser) {
                this.connect();
            }
        }, 400).unref?.();
    }

    close(): void {
        this.#closedByUser = true;
        this.#generation++;

        if (this.#reconnectTimer) {
            clearTimeout(this.#reconnectTimer);
            this.#reconnectTimer = undefined;
        }

        const socket = this.#ws;
        this.#ws = undefined;
        this.#setupComplete = false;

        if (socket) {
            try {
                socket.close(1000, "shutdown");
            } catch {
                // ignore
            }
        }

        this.#setState("closed");
    }

    // -----------------------------------------------------------------------

    #send(payload: string, queueable = false): void {
        const socket = this.#ws;

        // Audio is worthless once late, so it is dropped while reconnecting. Text
        // (approval prompts, notices, tool results) is held instead: losing it was
        // how a spoken approval question never reached the model.
        if (!socket || socket.readyState !== OPEN || !this.#setupComplete) {
            if (queueable && this.#outbox.length < LiveSession.OUTBOX_LIMIT) {
                this.#outbox.push(payload);
            }

            return;
        }

        try {
            socket.send(payload);
        } catch (error) {
            log("live", "send failed", error);
        }
    }

    #setState(state: LiveState): void {
        if (this.#state === state) {
            return;
        }

        this.#state = state;
        this.emit("state", state);
    }

    #fail(error: Error): void {
        warn("live", error.message);
        this.#setState("error");
        this.emit("error", error);
        // -1, not undefined: `undefined` is treated as a clean 1000 rotation, which
        // meant a failing connect retried every 300 ms forever without backoff.
        this.#scheduleReconnect(-1, error.message);
    }

    /** Deliver anything held while the socket was coming up. */
    #flushOutbox(): void {
        if (this.#outbox.length === 0) {
            return;
        }

        const pending = this.#outbox.splice(0, this.#outbox.length);
        log("live", `flushing ${pending.length} queued message(s)`);

        for (const payload of pending) {
            this.#send(payload);
        }
    }

    #scheduleReconnect(code: number | undefined, reason: string | undefined): void {
        if (this.#closedByUser || this.#reconnectTimer) {
            return;
        }

        // A resumption handle can be invalidated server-side (or belong to an
        // older project/key). Drop it and reconnect fresh instead of dying.
        if (this.#handleFromStore && this.#handle && isStaleHandleClose(code, reason)) {
            this.#handle = undefined;
            this.#attempt = 0;
            this.emit("handleInvalid", undefined);
            log("live", "resumption handle rejected; starting a fresh session");
            this.#setState("reconnecting");
            this.#reconnectTimer = setTimeout(() => {
                this.#reconnectTimer = undefined;
                this.connect();
            }, 300);
            (this.#reconnectTimer as { unref?: () => void }).unref?.();

            return;
        }

        if (isFatalClose(code, reason)) {
            this.#fatal = true;
            this.#setState("error");
            this.emit("error", new Error(friendlyCloseError(code, reason)));

            return;
        }

        // Nothing here is worth retrying on a loop when a wake word can open a
        // fresh socket on demand: the user is not left with a dead voice, and an
        // idle session that the server closed does not burn quota reconnecting.
        if (this.options.wakeAvailable && (isDormantClose(code, reason) || this.#attempt >= MAX_RECONNECT_ATTEMPTS)) {
            this.#setState("sleeping");
            this.emit("dormant", { reason: (reason ?? "").trim() || `closed ${code ?? "?"}` });

            return;
        }

        if (this.#attempt >= MAX_RECONNECT_ATTEMPTS) {
            this.#fatal = true;
            this.#setState("error");
            this.emit(
                "error",
                new Error(
                    `Gemini Live kept closing (${code ?? "?"}): ${(reason ?? "").trim() || "no reason"}. `
                    + "Stopped retrying; run /voice restart when it should work again.",
                ),
            );

            return;
        }

        // 1000 = clean server-side rotation: reconnect promptly, no failure count.
        const clean = code === 1000 || code === undefined;
        const delay = clean ? 300 : backoffDelay(this.#attempt, 800, 30_000);

        if (!clean) {
            this.#attempt++;
        }

        this.#setState("reconnecting");

        this.#reconnectTimer = setTimeout(() => {
            this.#reconnectTimer = undefined;
            this.connect();
        }, delay);

        // Do not keep the process alive just for a retry.
        (this.#reconnectTimer as { unref?: () => void }).unref?.();
    }

    #handleData(data: unknown, generation: number): void {
        const deliver = (text: string | undefined): void => {
            if (!text || generation !== this.#generation) {
                return;
            }

            const message = parseServerMessage(text);

            if (message) {
                this.#handleServer(message);
            }
        };

        // Defensive: a platform that ignores binaryType may still hand us a Blob.
        const BlobCtor = (globalThis as { Blob?: new (...args: never[]) => { text(): Promise<string> } }).Blob;

        if (BlobCtor && data instanceof BlobCtor) {
            void data.text().then(deliver).catch(() => undefined);

            return;
        }

        deliver(asText(data));
    }

    #handleServer(message: ServerMessage): void {
        if (message.setupComplete) {
            this.#setupComplete = true;
            this.#attempt = 0;
            this.#handleFromStore = false;
            this.#setState(this.#streaming ? "live" : "sleeping");
            log("live", "setup complete");
            this.#flushOutbox();

            return;
        }

        if (message.sessionResumptionUpdate?.newHandle) {
            const update = message.sessionResumptionUpdate;

            if (update.resumable !== false) {
                this.#handle = update.newHandle;
                this.emit("resumption", update.newHandle);
            }
        }

        if (message.goAway) {
            const ms = durationToMs(message.goAway.timeLeft) ?? 0;
            this.emit("goAway", ms);
            // Reconnect shortly before the server aborts the connection.
            const lead = Math.max(500, ms - 1500);
            setTimeout(() => {
                if (!this.#closedByUser && this.#ws) {
                    log("live", "proactive resume before GoAway");
                    this.reconnectNow();
                }
            }, lead).unref?.();
        }

        if (message.toolCall?.functionCalls) {
            for (const call of message.toolCall.functionCalls) {
                this.emit("toolCall", {
                    id: call.id ?? call.name ?? "",
                    name: call.name ?? "",
                    args: call.args ?? {},
                });
            }
        }

        if (message.toolCallCancellation?.ids) {
            this.emit("toolCancel", message.toolCallCancellation.ids);
        }

        if (message.usageMetadata) {
            this.emit("usage", {
                total: message.usageMetadata.totalTokenCount ?? 0,
                prompt: message.usageMetadata.promptTokenCount ?? 0,
                response: message.usageMetadata.responseTokenCount ?? 0,
            });
        }

        if (message.voiceActivity?.type) {
            const type = message.voiceActivity.type.toUpperCase();
            if (type.includes("START")) {
                this.emit("inputActivity", "start");
            } else if (type.includes("END")) {
                this.emit("inputActivity", "end");
            }
        }

        if (!message.serverContent) {
            return;
        }

        const content = message.serverContent;
        this.#lastActivity = Date.now();

        if (content.inputTranscription?.text) {
            this.emit("transcript", { side: "user", text: content.inputTranscription.text, final: false });
        }

        if (content.outputTranscription?.text) {
            this.emit("transcript", { side: "model", text: content.outputTranscription.text, final: false });
        }

        if (content.interrupted) {
            this.emit("interrupted", undefined);
        }

        if (content.modelTurn?.parts) {
            for (const part of content.modelTurn.parts) {
                const data = part.inlineData?.data;

                if (data) {
                    this.emit("audio", decodePcmBase64(data));
                }
            }
        }

        if (content.turnComplete) {
            // Finalise both sides: the server never marks user transcription final,
            // which left a "you" line stuck as interim in the page forever.
            this.emit("transcript", { side: "user", text: "", final: true });
            this.emit("transcript", { side: "model", text: "", final: true });
            this.emit("turnComplete", undefined);
        }

        if (content.interactionStatus === "IDLE") {
            this.emit("idle", undefined);
        }
    }
}

/** Convenience: wait until the session reaches a terminal setup state or times out. */
export async function waitForLive(session: LiveSession, timeoutMs = 15_000): Promise<boolean> {
    if (session.state === "live" || session.state === "sleeping") {
        return true;
    }

    return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
            off();
            resolve(false);
        }, timeoutMs);

        const off = session.on("state", (state) => {
            if (state === "live" || state === "sleeping") {
                clearTimeout(timer);
                off();
                resolve(true);
            } else if (state === "error" || state === "closed") {
                clearTimeout(timer);
                off();
                resolve(false);
            }
        });
    });
}

export { sleep };
