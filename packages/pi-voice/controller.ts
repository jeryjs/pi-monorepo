/**
 * VoiceController: the conductor.
 *
 *   browser page  <-- Pcm/JSON -->  this  <-- WebSocket -->  Gemini Live
 *                                    |
 *                                    +--> Pi session (tools, approvals, digest)
 *
 * Keeping the Gemini socket in the Pi process means the API key never reaches
 * the browser, tool calls execute natively, and the loopback hop costs ~0.2 ms
 * against a 20-100 ms network RTT.
 */

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { capabilitiesFor, type ModelCapabilities } from "./capabilities.ts";
import type { VoiceConfig } from "./config.ts";
import { AgentBridge } from "./bridge/agent.ts";
import { agentReplyNotice, approvalNotice, buildSystemInstruction } from "./bridge/prompt.ts";
import { dispatchTool, functionDeclarations, type VoiceControl } from "./bridge/tools.ts";
import { startAudioServer, type AudioServer } from "./audio/server.ts";
import { NativeTransport } from "./audio/native.ts";
import type { WebSocketPeer } from "./audio/ws.ts";
import { LiveSession } from "./live/session.ts";
import { createSetupBuilder } from "./live/setup.ts";
import { persistVoiceState, readVoiceState } from "./state.ts";
import { resolveGeminiKey, type KeyRegistry } from "./keychain.ts";
import { setVoiceStatus, voiceStatusText } from "./ui.ts";
import { log, warn } from "./util.ts";

export interface StartResult {
    url: string;
    model: string;
    voice: string;
    resumed: boolean;
}

export class VoiceController implements VoiceControl {
    #config: VoiceConfig;
    /** Snapshot the setup builder reads; mutated in place when degrading features. */
    #setupConfig: VoiceConfig | undefined;
    #groundingDegraded = false;
    #bridge: AgentBridge;
    #capabilities: ModelCapabilities;
    #session: LiveSession | undefined;
    #native: NativeTransport | undefined;
    #server: AudioServer | undefined;
    #peers = new Set<WebSocketPeer>();
    #idleTimer: ReturnType<typeof setInterval> | undefined;
    #statsTimer: ReturnType<typeof setInterval> | undefined;
    #running = false;
    #lastAnnounce = 0;
    #lastAnnounceText = "";
    #lastPersist = 0;
    #tokens = 0;
    #keySource: string | undefined;
    #levels: number[] = [];
    #lastStatusAt = 0;
    #lastError: string | undefined;
    #startedAt = 0;

    readonly #pi: ExtensionAPI;
    readonly #ctx: ExtensionContext;

    constructor(pi: ExtensionAPI, ctx: ExtensionContext, config: VoiceConfig) {
        this.#pi = pi;
        this.#ctx = ctx;
        this.#config = config;
        this.#capabilities = capabilitiesFor(config.model);
        this.#bridge = new AgentBridge(pi, ctx.cwd);
    }

    private get pi(): ExtensionAPI {
        return this.#pi;
    }

    private get ctx(): ExtensionContext {
        return this.#ctx;
    }

    get running(): boolean {
        return this.#running;
    }

    get url(): string | undefined {
        return this.#server?.url;
    }

    get model(): string {
        return this.#config.model;
    }

    get capabilities(): ModelCapabilities {
        return this.#capabilities;
    }

    get peerCount(): number {
        return this.#peers.size;
    }

    get liveState(): string {
        return this.#session?.state ?? "idle";
    }

    /** Where the Gemini key came from (never the key itself). */
    get keySource(): string | undefined {
        return this.#keySource;
    }

    /** Last stream/fatal error, shown by /voice status. */
    get lastError(): string | undefined {
        return this.#lastError;
    }

    /** Push a mic RMS sample and refresh the status-bar waveform. */
    pushLevel(rms: number): void {
        this.#levels.push(Number.isFinite(rms) ? rms : 0);

        if (this.#levels.length > 24) {
            this.#levels.shift();
        }

        this.#renderStatus();
    }

    refreshStatus(force = true): void {
        this.#renderStatus(force);
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    async start(): Promise<StartResult> {
        if (this.#running) {
            return {
                url: this.#server?.url ?? "",
                model: this.#config.model,
                voice: this.#config.voice,
                resumed: Boolean(this.#session?.resumptionHandle),
            };
        }

        const apiKey = await this.#resolveApiKey();

        if (!apiKey) {
            throw new Error(
                "No Gemini API key. Pi looked in pi-voice.json, ~/.pi/agent/auth.json (google), "
                + "GEMINI_API_KEY, and Pi's provider registry. Connect Google in Pi's Providers, "
                + "or run /voice key <key>.",
            );
        }

        this.#capabilities = capabilitiesFor(this.#config.model);
        this.#setupConfig = { ...this.#config };

        const instruction = buildSystemInstruction({
            config: this.#config,
            capabilities: this.#capabilities,
            cwd: this.ctx.cwd,
            sessionName: this.#sessionName(),
            alwaysOn: this.#config.alwaysOn,
        });

        const token = randomBytes(16).toString("hex");

        this.#server = await startAudioServer({
            host: this.#config.host,
            port: this.#config.port,
            token,
            clientConfig: () => this.#clientConfig(),
            onPeer: (peer, attach) => {
                this.#peers.add(peer);
                attach((data, isBinary) => this.#onPeerData(peer, data, isBinary));
                this.#sendHello(peer);
            },
            onLog: (message) => log("audio", message),
        });

        const buildSetup = createSetupBuilder({
            config: this.#setupConfig,
            capabilities: this.#capabilities,
            systemInstruction: instruction,
            tools: functionDeclarations(this.#capabilities),
        });

        const session = new LiveSession({
            apiKey,
            buildSetup,
            startSleeping: this.#config.alwaysOn,
        });

        const previous = readVoiceState(this.ctx);
        const ageMs = previous.updatedAt ? Date.now() - Date.parse(previous.updatedAt) : Number.POSITIVE_INFINITY;

        if (previous.handle && previous.model === this.#config.model && ageMs < 2 * 60 * 60_000) {
            session.setResumptionHandle(previous.handle);
            log("controller", "resuming previous voice session");
        }

        this.#session = session;
        this.#wireSession(session);
        this.#wireBridge();

        session.connect();

        if (this.#config.audio !== "browser") {
            try {
                const native = new NativeTransport({
                    config: this.#config,
                    onMic: (bytes) => {
                        if (!this.#session) {
                            return;
                        }

                        if (!this.#session.streaming) {
                            this.#session.setStreaming(true);
                        }

                        this.#session.sendMic(bytes);
                    },
                    onWake: (source) => {
                        this.wake();
                        this.#broadcast({ t: "wake", source });
                    },
                    onLog: (message) => log("native", message),
                    onLevel: (value) => this.pushLevel(value),
                    onError: (message) => warn("native", message),
                });

                await native.start();
                this.#native = native;
                this.#native.setStreaming(!this.#config.alwaysOn);
            } catch (error) {
                warn("controller", `native audio unavailable: ${String(error)}`);
            }
        }
        this.#running = true;
        this.#startedAt = Date.now();
        this.#renderStatus(true);

        this.#idleTimer = setInterval(() => this.#tickIdle(), 2000);
        this.#statsTimer = setInterval(() => this.#broadcastStats(), 10_000);
        (this.#idleTimer as { unref?: () => void }).unref?.();
        (this.#statsTimer as { unref?: () => void }).unref?.();

        persistVoiceState(this.pi, {
            handle: session.resumptionHandle,
            model: this.#config.model,
            voice: this.#config.voice,
        });

        if (this.#config.openBrowser && this.#config.audio !== "native") {
            this.#open(this.#server.url);
        }

        return {
            url: this.#server.url,
            model: this.#config.model,
            voice: this.#config.voice,
            resumed: Boolean(previous.handle),
        };
    }

    async stop(): Promise<void> {
        if (!this.#running) {
            return;
        }

        this.#running = false;
        setVoiceStatus(this.ctx, undefined);

        if (this.#idleTimer) {
            clearInterval(this.#idleTimer);
            this.#idleTimer = undefined;
        }

        if (this.#statsTimer) {
            clearInterval(this.#statsTimer);
            this.#statsTimer = undefined;
        }

        const handle = this.#session?.resumptionHandle;

        if (handle) {
            persistVoiceState(this.pi, { handle, model: this.#config.model, voice: this.#config.voice });
        }

        this.#session?.close();
        this.#session = undefined;

        this.#native?.stop();
        this.#native = undefined;

        for (const peer of this.#peers) {
            try {
                peer.close(1001, "voice stopped");
            } catch {
                // ignore
            }
        }

        this.#peers.clear();

        await this.#server?.close();
        this.#server = undefined;
    }

    updateConfig(config: VoiceConfig): void {
        this.#config = config;
        this.#capabilities = capabilitiesFor(config.model);

        if (this.#setupConfig) {
            Object.assign(this.#setupConfig, config);
        }

        this.#broadcast({ t: "config", ...this.#clientConfig() });
        this.#renderStatus(true);
    }

    // -----------------------------------------------------------------------
    // VoiceControl (called from the voice model's function calls)
    // -----------------------------------------------------------------------

    sleep(reason?: string): void {
        this.#session?.setStreaming(false);
        this.#native?.setStreaming(false);
        this.#broadcast({ t: "sleep", reason });
    }

    wake(): void {
        this.#session?.setStreaming(true);
        this.#native?.setStreaming(true);
        this.#broadcast({ t: "wake" });
    }

    setAlwaysOn(value: boolean): void {
        this.#config = { ...this.#config, alwaysOn: value };
        this.#broadcast({ t: "config", ...this.#clientConfig() });
    }

    interruptAgent(): void {
        this.#bridge.interrupt();
    }

    /** Make the voice model say something (used by Pi's `voice` tool). */
    speak(text: string): boolean {
        const state = this.#session?.state;

        if (state !== "live" && state !== "sleeping") {
            return false;
        }

        this.#session?.sendText(
            `Say this to the user now, close to verbatim, in your normal spoken voice: "${text.slice(0, 800)}"`,
        );

        return true;
    }

    answerApproval(id: string, allow: boolean): boolean {
        const known = this.#bridge.answerApproval(id, allow);
        this.#broadcast({ t: "approval-done", id });

        return known;
    }

    /** Called by the Pi-side tool gate. */
    requestApproval(toolName: string, summary: string): Promise<boolean | undefined> {
        return this.#bridge.requestApproval({ toolName, summary });
    }

    get approvalAvailable(): boolean {
        return this.#running && this.#session?.state === "live";
    }

    // -----------------------------------------------------------------------
    // Session wiring
    // -----------------------------------------------------------------------

    #wireSession(session: LiveSession): void {
        session.on("audio", (bytes) => {
            this.#native?.play(bytes);
            this.#broadcastBinary(bytes);
        });

        session.on("transcript", (entry) => {
            this.#broadcast({ t: "transcript", side: entry.side, text: entry.text, final: entry.final });
        });

        session.on("toolCall", (call) => {
            void (async () => {
                try {
                    const response = await dispatchTool(call, {
                        config: this.#config,
                        capabilities: this.#capabilities,
                        bridge: this.#bridge,
                        control: this,
                    });
                    session.sendToolResult([response]);
                } catch (error) {
                    warn("tool", `dispatch failed: ${String(error)}`);
                    session.sendToolResult([{ id: call.id, name: call.name, response: { error: String(error) } }]);
                }
            })();
        });

        session.on("interrupted", () => {
            this.#broadcast({ t: "interrupt" });
        });

        session.on("state", (state) => {
            this.#broadcast({ t: "state", state, detail: `${this.#config.model} · ${state}` });
            this.#renderStatus(true);
        });

        session.on("usage", (usage) => {
            this.#tokens = usage.total || this.#tokens;
        });

        session.on("handleInvalid", () => {
            // The persisted handle was rejected; make sure a restart does not reuse it.
            persistVoiceState(this.pi, { handle: undefined, model: this.#config.model, voice: this.#config.voice });
            this.#broadcast({ t: "notice", text: "Saved voice session expired; starting a fresh one." });
        });

        session.on("resumption", (handle) => {
            const now = Date.now();

            if (now - this.#lastPersist > 20_000) {
                this.#lastPersist = now;
                persistVoiceState(this.pi, { handle, model: this.#config.model, voice: this.#config.voice });
            }
        });

        session.on("goAway", (ms) => {
            log("controller", `server will rotate the connection in ${Math.round(ms)}ms`);
        });

        session.on("error", (error) => {
            warn("live", error.message);
            this.#lastError = error.message;
            this.#renderStatus(true);

            // Live grounding is refused on free-tier projects with the same
            // "quota" close. Drop it and retry once instead of dying.
            const quota = /quota|billing|exceeded/i.test(error.message);

            if (quota && this.#setupConfig?.searchGrounding && !this.#groundingDegraded) {
                this.#groundingDegraded = true;
                this.#setupConfig.searchGrounding = false;
                this.#config = { ...this.#config, searchGrounding: false };
                log("controller", "quota refused: retrying without Google Search grounding");
                this.#broadcast({
                    t: "notice",
                    text: "Google Search grounding needs a billed project; reconnecting without it.",
                });
                setTimeout(() => session.reconnectNow(), 200).unref?.();

                return;
            }

            this.#broadcast({ t: "notice", text: error.message });
        });
    }

    #wireBridge(): void {
        this.#bridge.on((payload) => {
            const kind = (payload as { kind?: string }).kind;

            if (kind === "approval") {
                const approval = (payload as { approval: { toolCallId: string; toolName: string; summary: string } }).approval;

                this.#session?.sendText(approvalNotice(approval.toolCallId, approval.toolName, approval.summary));
                this.#broadcast({ t: "approval", id: approval.toolCallId, tool: approval.toolName, summary: approval.summary });

                return;
            }

            if (kind === "activity") {
                const activity = (payload as { activity: { kind: string; text: string } }).activity;

                if (activity.kind !== "settled" || !this.#config.announce || !activity.text) {
                    return;
                }

                const now = Date.now();

                if (now - this.#lastAnnounce < 1500 || activity.text === this.#lastAnnounceText) {
                    return;
                }

                if (this.#session?.state !== "live" && this.#session?.state !== "sleeping") {
                    return;
                }

                this.#lastAnnounce = now;
                this.#lastAnnounceText = activity.text;
                this.#session.sendText(agentReplyNotice(activity.text));
            }
        });
    }

    // -----------------------------------------------------------------------
    // Peers
    // -----------------------------------------------------------------------

    #clientConfig(): Record<string, unknown> {
        const config = this.#config;

        return {
            model: config.model,
            voice: config.voice,
            language: config.language,
            aec: config.aec,
            noiseSuppression: config.noiseSuppression,
            autoGain: config.autoGain,
            micDeviceId: config.micDeviceId,
            outputDeviceId: config.outputDeviceId,
            alwaysOn: config.alwaysOn,
            wakePhrases: config.wakePhrases,
            wakeEngine: config.wakeEngine,
            wakeSensitivity: config.wakeSensitivity,
            wakeModelUrl: config.wakeModelUrl,
            compute: config.compute,
            inputRate: 16000,
            outputRate: 24000,
        };
    }

    #sendHello(peer: WebSocketPeer): void {
        peer.send(JSON.stringify({ t: "hello", ...this.#clientConfig() }));
        peer.send(JSON.stringify({ t: "config", ...this.#clientConfig() }));
        peer.send(JSON.stringify({ t: "state", state: this.#session?.state ?? "connecting", detail: this.#config.model }));
    }

    #onPeerData(peer: WebSocketPeer, data: string | Uint8Array, isBinary: boolean): void {
        if (isBinary) {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array();

            if (bytes.length === 0) {
                return;
            }

            if (!this.#session) {
                return;
            }

            if (!this.#session.streaming) {
                this.#session.setStreaming(true);
            }

            this.#session.sendMic(bytes);

            return;
        }

        const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
        let message: Record<string, unknown>;

        try {
            message = JSON.parse(text) as Record<string, unknown>;
        } catch {
            return;
        }

        void this.#onControl(peer, message);
    }

    async #onControl(peer: WebSocketPeer, message: Record<string, unknown>): Promise<void> {
        const session = this.#session;
        const type = message.t;

        switch (type) {
            case "hello":
                this.#sendHello(peer);
                break;

            case "wake":
                this.wake();
                break;

            case "sleep":
                this.sleep();
                break;

            case "interrupt":
                session?.interrupt();
                this.#native?.flush();
                this.#bridge.interrupt();
                break;

            case "text":
                if (typeof message.value === "string" && message.value.trim()) {
                    session?.sendText(message.value.trim());
                }
                break;

            case "alwaysOn":
                if (typeof message.value === "boolean") {
                    this.setAlwaysOn(message.value);
                }
                break;

            case "approval":
                if (typeof message.id === "string" && typeof message.allow === "boolean") {
                    this.answerApproval(message.id, message.allow);
                }
                break;

            case "level":
                if (typeof message.value === "number") {
                    this.pushLevel(message.value);
                }
                break;

            case "end":
                await this.stop();
                break;

            default:
                log("controller", `unknown control: ${String(type)}`);
                break;
        }
    }

    #broadcast(message: Record<string, unknown>): void {
        const payload = JSON.stringify(message);

        for (const peer of this.#peers) {
            if (peer.open) {
                peer.send(payload);
            }
        }
    }

    #broadcastBinary(bytes: Uint8Array): void {
        for (const peer of this.#peers) {
            if (peer.open) {
                peer.send(bytes);
            }
        }
    }

    #broadcastStats(): void {
        this.#broadcast({ t: "stats", tokens: this.#tokens, peers: this.#peers.size });
    }

    #renderStatus(force = false): void {
        if (!this.#running) {
            setVoiceStatus(this.ctx, undefined);

            return;
        }

        const now = Date.now();

        if (!force && now - this.#lastStatusAt < 110) {
            return;
        }

        this.#lastStatusAt = now;
        setVoiceStatus(this.ctx, voiceStatusText({
            state: this.#session?.state ?? "starting",
            levels: this.#levels,
            alwaysOn: this.#config.alwaysOn,
            error: this.#lastError,
        }));
    }

    #tickIdle(): void {
        const session = this.#session;

        if (!session || session.state !== "live" || !session.streaming) {
            return;
        }

        if (session.idleMs > this.#config.idleSleepMs) {
            log("controller", "idle: gating the mic upstream, session kept");
            session.setStreaming(false);
            this.#broadcast({ t: "sleep" });
        }
    }

    // -----------------------------------------------------------------------

    async #resolveApiKey(): Promise<string | undefined> {
        // Pi's own order: explicit config, auth.json (`google`), env, then registry.
        const resolved = await resolveGeminiKey({
            configKey: this.#config.apiKey,
            registry: this.ctx.modelRegistry as unknown as KeyRegistry,
        });

        this.#keySource = resolved?.source;

        return resolved?.key;
    }

    #sessionName(): string | undefined {
        try {
            return (this.pi.getSessionName as () => string | undefined)();
        } catch {
            return undefined;
        }
    }

    #open(url: string): void {
        try {
            const platform = process.platform;
            const command = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
            const args = platform === "win32" ? ["/c", "start", "", url] : [url];
            const child = spawn(command, args, { detached: true, stdio: "ignore" });
            child.unref();
        } catch (error) {
            log("controller", "could not open the browser", error);
        }
    }
}