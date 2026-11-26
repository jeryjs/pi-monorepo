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
import { acquireLock, releaseLock, updateLockUrl } from "./lock.ts";
import { clearPersistedHandle, loadPersistedHandle, persistedSeq, savePersistedHandle } from "./persist.ts";
import { setVoiceStatus, voiceStatusText } from "./ui.ts";
import { log, warn } from "./util.ts";

export interface StartResult {
    url: string;
    model: string;
    voice: string;
    resumed: boolean;
}

/**
 * One token per Pi process. Reusing it means `/voice restart` keeps an already
 * open page working instead of leaving it to reconnect forever against a new token.
 */
const PROCESS_TOKEN = randomBytes(16).toString("hex");

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
    /** In-flight start, so `autoStart` + `/voice on` cannot open two sessions. */
    #startPromise: Promise<StartResult> | undefined;
    /** Bumped by stop(); an in-flight start notices and cleans up after itself. */
    #generation = 0;
    #abortAgent: (() => void) | undefined;
    #maxSessionTimer: ReturnType<typeof setTimeout> | undefined;
    /** The bridge instance whose listeners are wired, to avoid double-wiring. */
    #wiredBridge: AgentBridge | undefined;
    #lastAnnounce = 0;
    #lastAnnounceText = "";
    #lastPersist = 0;
    /** Last moment the mic heard voice, from pushLevel(); drives the idle gate. */
    #lastVoiceAt = 0;
    #voiceFloor = 0.006;
    /** Monotonic counter for resumption-handle writes (see persist.savePersistedHandle). */
    #persistSeq = 0;
    #tokens = 0;
    #keySource: string | undefined;
    #levels: number[] = [];
    #lastStatusAt = 0;
    #lastError: string | undefined;
    #startedAt = 0;

    #pi: ExtensionAPI;
    #ctx: ExtensionContext;

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

    /**
     * Reattach to a reloaded Pi session without dropping the Gemini connection.
     * `/reload` disposes the old extension runner, so the bridge is rebuilt while
     * the socket, audio transport and resumption handle stay intact.
     */
    rebind(pi: ExtensionAPI, ctx: ExtensionContext): void {
        const previous = this.#bridge;

        this.#pi = pi;
        this.#ctx = ctx;
        this.#bridge = new AgentBridge(pi, ctx.cwd);
        // Keep the digest across the reload so the voice model does not lose its
        // view of the conversation just because the extension was re-created.
        this.#bridge.adoptFrom(previous);
        this.#wiredBridge = undefined;

        // Drop the old subscriptions immediately: after a reload the discarded
        // bridge would otherwise keep consuming every Pi event.
        try {
            previous.dispose();
        } catch (error) {
            log("controller", "bridge dispose failed", error);
        }

        this.#wireBridge();
        this.#renderStatus(true);
    }

    get running(): boolean {
        return this.#running;
    }

    get url(): string | undefined {
        return this.#server?.url;
    }

    /** Open the companion page (no-op when the browser transport is off). */
    openPage(): boolean {
        if (!this.#server) {
            return false;
        }

        this.#open(this.#server.url);

        return true;
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
        const level = Number.isFinite(rms) ? rms : 0;

        this.#levels.push(level);

        if (this.#levels.length > 24) {
            this.#levels.shift();
        }

        // Both transports report the mic level here (native frames, the page's
        // `level` message), which makes this the one place that knows whether
        // anybody is actually talking. The idle gate keys on that.
        const threshold = Math.max(0.006, this.#voiceFloor * 2.2);

        if (level > threshold) {
            this.#lastVoiceAt = Date.now();
        } else {
            this.#voiceFloor = Math.max(0.002, this.#voiceFloor * 0.95 + level * 0.05);
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
            return this.#statusResult();
        }

        if (this.#startPromise) {
            return this.#startPromise;
        }

        const generation = this.#generation;
        const promise = this.#start(generation).finally(() => {
            if (this.#startPromise === promise) {
                this.#startPromise = undefined;
            }
        });

        this.#startPromise = promise;

        return promise;
    }

    get starting(): boolean {
        return this.#startPromise !== undefined && !this.#running;
    }

    #statusResult(resumed = false): StartResult {
        return {
            url: this.#server?.url ?? "",
            model: this.#config.model,
            voice: this.#config.voice,
            resumed: resumed || Boolean(this.#session?.resumptionHandle),
        };
    }

    /** Throw if stop() ran while we were awaiting something. */
    #assertCurrent(generation: number): void {
        if (generation !== this.#generation) {
            throw new Error("voice start cancelled");
        }
    }

    async #start(generation: number): Promise<StartResult> {
        try {
            return await this.#startInner(generation);
        } catch (error) {
            // A failed or cancelled start must not leak a socket, HTTP server,
            // microphone or the workspace lock.
            await this.#teardown(false);

            throw error;
        }
    }

    async #startInner(generation: number): Promise<StartResult> {

        const apiKey = await this.#resolveApiKey();
        this.#assertCurrent(generation);

        if (!apiKey) {
            throw new Error(
                "No Gemini API key. Pi looked in pi-voice.json, ~/.pi/agent/auth.json (google), "
                + "GEMINI_API_KEY, and Pi's provider registry. Connect Google in Pi's Providers, "
                + "or run /voice key <key>.",
            );
        }

        const lock = acquireLock(this.ctx.cwd);

        if (!lock.ok) {
            throw new Error(
                `voice is already running in this workspace (pid ${lock.lock.pid})`
                + (lock.lock.url ? ` at ${lock.lock.url}` : "")
                + ". Use that instance, or stop it first.",
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

        const token = PROCESS_TOKEN;

        // Browser transport is opt-in: native (ffmpeg) is the default, so no HTTP
        // server, no page, no tab unless `audio` is `browser`/`both`.
        const wantsBrowser = this.#config.audio !== "native";
        const wantsNative = this.#config.audio !== "browser";

        if (wantsBrowser) {
            this.#server = await startAudioServer({
                host: this.#config.host,
                port: this.#config.port,
                token,
                clientConfig: () => this.#clientConfig(),
                onPeer: (peer, attach) => {
                    // A peer from a previous run must never be routed into the new one.
                    if (generation !== this.#generation) {
                        try {
                            peer.close(1001, "stale session");
                        } catch {
                            // ignore
                        }

                        return;
                    }

                    this.#peers.add(peer);
                    attach((data, isBinary) => this.#onPeerData(peer, data, isBinary));
                    this.#sendHello(peer);
                },
                onLog: (message) => log("audio", message),
            });
            this.#assertCurrent(generation);
        }

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
        const persisted = loadPersistedHandle(this.ctx.cwd);
        // Continue the write sequence above whatever is on disk, so this run's
        // handle updates are never mistaken for stale writes.
        this.#persistSeq = Math.max(this.#persistSeq, persistedSeq(this.ctx.cwd));
        // Session entries vanish with --no-session, so fall back to the file.
        const seed = previous.handle ? previous : persisted;
        const ageMs = seed?.updatedAt ? Date.now() - Date.parse(seed.updatedAt) : Number.POSITIVE_INFINITY;

        if (seed?.handle && seed.model === this.#config.model && ageMs < 2 * 60 * 60_000) {
            session.setResumptionHandle(seed.handle);
            log("controller", "resuming previous voice session");
        }

        this.#session = session;
        this.#wireSession(session);
        this.#wireBridge();

        session.connect();

        if (wantsNative) {
            const native = new NativeTransport({
                config: this.#config,
                cwd: this.ctx.cwd,
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

            try {
                await native.start();
                this.#assertCurrent(generation);
                this.#native = native;
                this.#native.setStreaming(!this.#config.alwaysOn);
            } catch (error) {
                native.stop();

                if (generation !== this.#generation) {
                    throw new Error("voice start cancelled");
                }

                if (!wantsBrowser) {
                    session.close();
                    await this.#server?.close();
                    this.#server = undefined;

                    throw new Error(
                        `native audio unavailable: ${String(error)}. `
                        + "Install ffmpeg, set the input device in /voice → Audio, or switch transport to browser.",
                    );
                }

                warn("controller", `native audio unavailable: ${String(error)} (continuing with browser)`);
            }
        }
        this.#assertCurrent(generation);
        this.#running = true;
        this.#startedAt = Date.now();
        this.#lastVoiceAt = Date.now();
        this.#renderStatus(true);

        this.#idleTimer = setInterval(() => this.#tickIdle(), 2000);
        this.#statsTimer = setInterval(() => this.#broadcastStats(), 10_000);
        (this.#idleTimer as { unref?: () => void }).unref?.();
        (this.#statsTimer as { unref?: () => void }).unref?.();
        this.#scheduleMaxSession();

        persistVoiceState(this.pi, {
            handle: session.resumptionHandle,
            model: this.#config.model,
            voice: this.#config.voice,
        });

        if (this.#server && this.#config.openBrowser) {
            this.#open(this.#server.url);
        }

        updateLockUrl(this.ctx.cwd, this.#server?.url);

        return this.#statusResult(Boolean(previous.handle));
    }

    /**
     * Close everything this controller owns. Split out of stop() because a failed
     * or cancelled start needs the same cleanup without persisting a handle.
     */
    async #teardown(persist: boolean): Promise<void> {
        if (this.#idleTimer) {
            clearInterval(this.#idleTimer);
            this.#idleTimer = undefined;
        }

        if (this.#statsTimer) {
            clearInterval(this.#statsTimer);
            this.#statsTimer = undefined;
        }

        if (this.#maxSessionTimer) {
            clearTimeout(this.#maxSessionTimer);
            this.#maxSessionTimer = undefined;
        }

        const session = this.#session;
        this.#session = undefined;

        if (persist && session?.resumptionHandle) {
            persistVoiceState(this.pi, {
                handle: session.resumptionHandle,
                model: this.#config.model,
                voice: this.#config.voice,
            });
            this.#saveHandle(session.resumptionHandle);
        }

        // Resolves any pending approval instead of leaving a tool call hanging.
        this.#bridge.dispose();
        this.#wiredBridge = undefined;
        setVoiceStatus(this.ctx, undefined);

        try {
            session?.close();
        } catch (error) {
            log("controller", "session close failed", error);
        }

        const native = this.#native;
        this.#native = undefined;

        try {
            native?.stop();
        } catch (error) {
            log("controller", "native stop failed", error);
        }

        for (const peer of [...this.#peers]) {
            try {
                peer.close(1001, "voice stopped");
            } catch {
                // ignore
            }
        }

        this.#peers.clear();

        const server = this.#server;
        this.#server = undefined;

        try {
            await server?.close();
        } catch (error) {
            log("controller", "audio server close failed", error);
        }

        this.#levels = [];
        releaseLock(this.ctx.cwd);
    }

    async stop(): Promise<void> {
        // Bump first: an in-flight start will see this and clean up after itself
        // instead of racing us for the same fields.
        this.#generation++;
        this.#running = false;
        const inFlight = this.#startPromise;

        await this.#teardown(true);

        if (inFlight) {
            // Let the cancelled start finish its own teardown before returning, so
            // `/voice on` immediately after `/voice off` never overlaps a socket.
            await inFlight.catch(() => undefined);
            await this.#teardown(true);
        }
    }

    updateConfig(config: VoiceConfig): { restart: boolean; reconnected: boolean } {
        const previous = this.#config;

        this.#config = config;
        this.#capabilities = capabilitiesFor(config.model);

        if (this.#setupConfig) {
            Object.assign(this.#setupConfig, config);
        }

        this.#broadcast({ t: "config", ...this.#clientConfig() });
        this.#renderStatus(true);

        // Transport-level settings can only be applied by rebuilding the process
        // side (server, mic, player).
        const restartKeys: (keyof VoiceConfig)[] = [
            "audio", "host", "port", "nativeInput", "nativeOutput", "ffmpegPath", "ffplayPath",
            "nativeAec", "kwsModelDir", "kwsKeywords", "sherpaProvider", "wakeEngine", "compute",
        ];
        const restart = restartKeys.some((key) => previous[key] !== config[key]);

        // Everything else is a `setup` field: the running socket keeps the old one
        // until it reconnects, so do that now instead of silently disagreeing with
        // the capability table used to filter tool results.
        const setupKeys: (keyof VoiceConfig)[] = [
            "model", "voice", "language", "persona", "temperature", "searchGrounding",
            "inputTranscription", "outputTranscription", "customVocabulary", "proactiveAudio",
            "proactiveVideo", "affectiveDialog", "thinkingLevel", "thinkingBudget", "vadSilenceMs",
            "vadPrefixMs", "bargeIn", "autonomy", "voiceApprovals",
        ];
        const changed = setupKeys.filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(config[key]));
        let reconnected = false;

        if (this.#running && changed.length > 0) {
            log("controller", `setup changed (${changed.join(", ")}); reconnecting the live session`);
            this.#groundingDegraded = false;
            this.#session?.reconnectNow();
            reconnected = true;
        }

        if (this.#running) {
            this.#scheduleMaxSession();
        }

        return { restart, reconnected };
    }

    /** Renew the Live socket before the server's own session limits bite. */
    #scheduleMaxSession(): void {
        if (this.#maxSessionTimer) {
            clearTimeout(this.#maxSessionTimer);
            this.#maxSessionTimer = undefined;
        }

        const limit = Math.round(this.#config.maxSessionMs);

        if (!(limit > 0) || !this.#running) {
            return;
        }

        this.#maxSessionTimer = setTimeout(() => {
            this.#maxSessionTimer = undefined;

            if (!this.#running) {
                return;
            }

            log("controller", `session age limit ${limit} ms reached; renewing the live session`);
            this.#session?.reconnectNow();
            this.#scheduleMaxSession();
        }, limit);
        (this.#maxSessionTimer as { unref?: () => void }).unref?.();
    }

    /** Wire the Pi agent's interrupt (ctx.abort) so `pi_stop` really stops work. */
    setAgentAbort(handler: () => void): void {
        this.#abortAgent = handler;
    }

    /**
     * Stop Pi's current work: `ctx.abort()` ends the running turn, and a steering
     * message tells the model the stop was intentional.
     *
     * This used to be defined twice in this class; the second definition silently
     * won and only sent the steer, so `pi_stop` never aborted anything. Keep
     * exactly one implementation.
     */
    interruptAgent(): void {
        if (this.#abortAgent) {
            try {
                this.#abortAgent();
            } catch (error) {
                warn("controller", `agent abort failed: ${String(error)}`);
            }
        } else {
            warn("controller", "no agent abort handler registered");
        }

        this.#bridge.interrupt();
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
        this.#lastVoiceAt = Date.now();
        this.#session?.setStreaming(true);
        this.#native?.setStreaming(true);
        this.#broadcast({ t: "wake" });
    }

    setAlwaysOn(value: boolean): void {
        this.#config = { ...this.#config, alwaysOn: value };
        this.#broadcast({ t: "config", ...this.#clientConfig() });
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
            clearPersistedHandle(this.ctx.cwd);
            this.#broadcast({ t: "notice", text: "Saved voice session expired; starting a fresh one." });
        });

        session.on("resumption", (handle) => {
            const now = Date.now();

            if (now - this.#lastPersist > 20_000) {
                this.#lastPersist = now;
                persistVoiceState(this.pi, { handle, model: this.#config.model, voice: this.#config.voice });
                this.#saveHandle(handle);
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
        // A start after a stop must re-attach the same bridge instance; teardown
        // detached it and nothing else would subscribe again.
        this.#bridge.attach();

        // Idempotent: start() and rebind() can both reach here for the same bridge.
        if (this.#wiredBridge === this.#bridge) {
            return;
        }

        this.#wiredBridge = this.#bridge;
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
            bargeIn: config.bargeIn,
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

            case "mic":
                // The page reports its own mic state; nothing to do server-side.
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

        // session.idleMs is useless here: mic frames (and therefore activity) stream
        // continuously while awake, so it never grew and the gate never fired in
        // native mode. Sleep on *voice* silence instead, which is what the setting
        // actually promises.
        if (Date.now() - this.#lastVoiceAt < this.#config.idleSleepMs) {
            return;
        }

        log("controller", "idle: gating the mic upstream, session kept");
        // Gate the capture process too, not just the session: the native transport
        // only stops sending frames when *it* is told to, so gating the session
        // alone let the next frame reopen it.
        this.#native?.setStreaming(false);
        session.setStreaming(false);
        this.#broadcast({ t: "sleep" });
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

    /**
     * Persist the newest resumption handle to the file store. The sequence number
     * makes a newer handle win even inside a fast restart loop, while still
     * ignoring a late write from a connection that has already been replaced.
     */
    #saveHandle(handle: string | undefined): void {
        this.#persistSeq++;
        savePersistedHandle(this.ctx.cwd, {
            handle,
            model: this.#config.model,
            voice: this.#config.voice,
            seq: this.#persistSeq,
        });
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