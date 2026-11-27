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
    /**
     * Deadline for a spoken request Pi has not answered yet. When a `pi_ask` lands,
     * Pi's eventual reply must reach the speaker even with `announce` off — the voice
     * agent promised "I'll tell you when Pi's back", and silence there looks broken.
     */
    #awaitingReplyUntil = 0;
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
    /**
     * Started asleep: the mic and the wake spotter run, no Gemini socket exists
     * yet. `wake()` opens it. This is what keeps `--voice` from holding a Live
     * session (and its context) open all day.
     */
    #dormant = false;
    /** Wake fired, socket not live yet: hold the first syllables instead of losing them. */
    #wakePending = false;
    #pendingAudio: Uint8Array[] = [];
    #pendingBytes = 0;
    /** Wake diagnostics for /voice status: how often, from what, and whether it is heard at all. */
    #wakeCount = 0;
    #lastWakeAt = 0;
    #lastWakeSource = "";
    #lastLevelAt = 0;
    /** Last moment the model produced audio; used to decide "was it mid-sentence?". */
    #lastAudioOutAt = 0;
    /**
     * Set after cutting playback for an interruption: the rest of the sentence we cut
     * is still streaming down and would play on top of the new one. Dropped until the
     * server ends that turn, with a cap so it cannot stick.
     */
    #dropAudio = false;
    #dropAudioTimer: ReturnType<typeof setTimeout> | undefined;
    /**
     * The server is (or was, a moment ago) generating a turn. A notice pushed while
     * this is true is spoken *in addition* to the sentence that is still being
     * generated, which is how two voices ended up talking at once.
     */
    #modelTurnOpen = false;
    /** Notices held back until the model's turn ends, so they never overlap. */
    #deferredNotices: string[] = [];
    #deferredNoticesTimer: ReturnType<typeof setTimeout> | undefined;

    #pi: ExtensionAPI;
    #ctx: ExtensionContext;

    constructor(pi: ExtensionAPI, ctx: ExtensionContext, config: VoiceConfig) {
        this.#pi = pi;
        this.#ctx = ctx;
        this.#config = config;
        this.#capabilities = capabilitiesFor(config.model);
        this.#bridge = new AgentBridge(pi, ctx.cwd);
        this.#seedBridgeFromSession();
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
        this.#seedBridgeFromSession();
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
        if (this.#dormant) {
            return "asleep";
        }

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

        if (level > 0.0005) {
            this.#lastLevelAt = Date.now();
        }

        this.#renderStatus();
    }

    /**
     * True when the mic has produced nothing but digital silence for a while. The
     * status bar says so instead of leaving "asleep" looking like a mystery; see
     * also `/voice mic`.
     */
    get micSilent(): boolean {
        if (this.#levels.length < 5 || !this.#running) {
            return false;
        }

        return Date.now() - this.#lastLevelAt > 8000;
    }

    /** Wake-word counters for /voice status (never fired = the useful fact). */
    get wakeStats(): { count: number; lastAt: number; source: string } {
        return { count: this.#wakeCount, lastAt: this.#lastWakeAt, source: this.#lastWakeSource };
    }

    /** Which wake engine is really running, not just what the config asks for. */
    get wakeEngineActive(): string {
        if (!this.#native) {
            return this.#config.audio === "browser" ? "browser page" : "not running";
        }

        const provider = this.#native.spotterProvider;

        return provider ? `sherpa (${provider})` : "energy VAD";
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

        const instruction = () => buildSystemInstruction({
            config: this.#config,
            capabilities: this.#capabilities,
            cwd: this.ctx.cwd,
            sessionName: this.#sessionName(),
            alwaysOn: this.#config.alwaysOn,
            // Rebuilt per connect (see createSetupBuilder): a `/resume` between two
            // connections must not leave the voice model describing a session that
            // is no longer the one Pi is showing the user.
            context: this.#bridge.digest({
                turns: this.#config.digestTurns,
                chars: this.#config.digestChars,
            }),
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
            // With a wake phrase armed, a socket that died goes back to sleep instead
            // of becoming an error the user has to restart Pi to clear.
            wakeAvailable: this.#config.alwaysOn,
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

        // Lazy start: with an always-on wake word, opening the Live socket at boot
        // means a session that usually nobody talks to — it costs context and
        // quota for nothing. Keep the local spotter running and connect on wake.
        const lazy = this.#config.connectOnWake && this.#config.alwaysOn;

        if (lazy) {
            this.#dormant = true;
            this.#wakePending = false;
            log("controller", "starting asleep: no Live session until the wake phrase");
        } else {
            session.connect();
        }

        if (wantsNative) {
            const native = new NativeTransport({
                config: this.#config,
                cwd: this.ctx.cwd,
                onMic: (bytes) => this.#feedMic(bytes),
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

        if (!this.#dormant) {
            this.#scheduleMaxSession();
        }

        // Dormant: there is no handle yet, and writing `undefined` here would look
        // like a deliberate clear. Leave the persisted handle alone until we connect.
        if (!this.#dormant) {
            persistVoiceState(this.pi, {
                handle: session.resumptionHandle,
                model: this.#config.model,
                voice: this.#config.voice,
            });
        }

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
        this.#dormant = false;
        this.#wakePending = false;
        this.#pendingAudio = [];
        this.#pendingBytes = 0;
        this.#awaitingReplyUntil = 0;
        this.#lastLevelAt = 0;
        this.#lastAudioOutAt = 0;
        this.#endDroppedAudio();
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
            "connectOnWake",
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

        // Asleep means no socket at all, so nothing to reconnect and nothing to
        // schedule: connecting here is exactly how a "start asleep" session used to
        // end up live without anyone saying the wake phrase. The mutated
        // #setupConfig is picked up by the setup the next connect builds.
        if (this.#running && !this.#dormant && changed.length > 0) {
            log("controller", `setup changed (${changed.join(", ")}); reconnecting the live session`);
            this.#groundingDegraded = false;
            this.#session?.reconnectNow();
            reconnected = true;
        }

        // Turning the wake word off while asleep would leave a session nobody can
        // wake and no way to talk; be live instead.
        if (this.#running && this.#dormant && !config.alwaysOn) {
            log("controller", "always-on disabled while asleep; connecting now");
            this.wake();
        }

        if (this.#running && !this.#dormant) {
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
        this.#wakeCount++;
        this.#lastWakeAt = Date.now();
        const session = this.#session;

        if (this.#dormant && session) {
            // First thing heard since start: open the socket now, and keep the
            // user's opening words buffered until setup completes.
            this.#wakePending = true;
            log("controller", "wake: opening the Live session");
            // Streaming first, so `setupComplete` lands on `live` rather than
            // `sleeping` (the session was created with startSleeping).
            session.setStreaming(true);
            session.connect();
            this.#renderStatus(true);
            this.#native?.setStreaming(true);
            this.#broadcast({ t: "wake" });

            return;
        }

        session?.setStreaming(true);
        this.#native?.setStreaming(true);
        this.#broadcast({ t: "wake" });
    }

    /**
     * Mic audio from either transport. While dormant it is dropped unless the wake
     * phrase has just fired, in which case it is held until the socket is live so
     * "hey pi, check my messages" is not cut down to its last syllable.
     */
    #feedMic(bytes: Uint8Array): void {
        const session = this.#session;

        if (!session) {
            return;
        }

        if (this.#dormant) {
            if (this.#wakePending) {
                this.#bufferWakeAudio(bytes);
            }

            return;
        }

        if (!session.streaming) {
            session.setStreaming(true);
        }

        session.sendMic(bytes);
    }

    #bufferWakeAudio(bytes: Uint8Array): void {
        // ~4 s at 16 kHz mono int16 is plenty for a spoken opening sentence and
        // bounds what a stuck handshake can hold on to.
        const limit = 16_000 * 2 * 4;

        this.#pendingAudio.push(bytes);
        this.#pendingBytes += bytes.length;

        while (this.#pendingBytes > limit && this.#pendingAudio.length > 0) {
            const dropped = this.#pendingAudio.shift();
            this.#pendingBytes -= dropped?.length ?? 0;
        }
    }

    /** Socket is live: stop being dormant and replay what the user already said. */
    #flushWakeAudio(): void {
        const session = this.#session;
        const pending = this.#pendingAudio;

        this.#pendingAudio = [];
        this.#pendingBytes = 0;
        this.#dormant = false;
        this.#wakePending = false;

        if (!session) {
            return;
        }

        session.setStreaming(true);

        if (pending.length > 0) {
            log("controller", `flushing ${pending.length} buffered frame(s) from before setup`);
        }

        for (const chunk of pending) {
            session.sendMic(chunk);
        }

        this.#scheduleMaxSession();
        this.#renderStatus(true);
    }

    setAlwaysOn(value: boolean): void {
        this.#config = { ...this.#config, alwaysOn: value };
        this.#broadcast({ t: "config", ...this.#clientConfig() });
    }

    /** Make the voice model say something (used by Pi's `voice` tool). */
    speak(text: string): boolean {
        // Same treatment as Pi's replies: cut the current sentence instead of
        // talking over it, and never stack a second turn on top of an open one.
        return this.#notice((interrupted) => {
            const lead = interrupted
                ? "[You were cut off mid-sentence; start with a brief \"oh\" and do not finish the old sentence]\n\n"
                : "";

            return `${lead}Say this to the user now, close to verbatim, in your normal spoken voice: "${text.slice(0, 800)}"`;
        }, true);
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
            // The tail of a sentence we deliberately cut: playing it would put two
            // voices on top of each other, which is exactly what the user heard.
            if (this.#dropAudio) {
                return;
            }

            this.#lastAudioOutAt = Date.now();
            // A turn is open from its first audio frame until the server ends it.
            this.#modelTurnOpen = true;
            // The model speaking counts as conversation activity, so the idle gate
            // counts from the end of its sentence rather than from the last thing we
            // said.
            this.#lastVoiceAt = Date.now();
            this.#native?.play(bytes);
            this.#broadcastBinary(bytes);
        });

        session.on("turnComplete", () => {
            this.#modelTurnOpen = false;
            this.#endDroppedAudio();
            // The old turn is finished: a notice held back for that reason can go now.
            this.#flushDeferredNotices();
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

                    const status = (response.response as { status?: unknown }).status;

                    if (call.name === "pi_ask" && (status === "sent" || status === "steering")) {
                        this.#awaitingReplyUntil = Date.now() + 10 * 60_000;
                        log("controller", "pi_ask delivered; waiting for Pi's reply to speak");
                    }

                    session.sendToolResult([response]);
                } catch (error) {
                    warn("tool", `dispatch failed: ${String(error)}`);
                    session.sendToolResult([{ id: call.id, name: call.name, response: { error: String(error) } }]);
                }
            })();
        });

        session.on("interrupted", () => {
            this.#modelTurnOpen = false;
            this.#endDroppedAudio();
            this.#flushDeferredNotices();
            this.#broadcast({ t: "interrupt" });
        });

        session.on("state", (state) => {
            // `sleeping` counts too: the session was built with startSleeping, so a
            // socket opened while gated reports setup-complete as sleeping.
            if (this.#dormant && (state === "live" || state === "sleeping")) {
                this.#flushWakeAudio();
            }

            this.#broadcast({ t: "state", state: this.liveState, detail: `${this.#config.model} · ${this.liveState}` });
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

        // The socket is gone and will not be retried: back to wake-word listening
        // with an honest status, so the next "hey pi" opens a fresh session instead
        // of the user having to restart Pi.
        session.on("dormant", ({ reason }) => {
            this.#modelTurnOpen = false;
            this.#endDroppedAudio();
            this.#deferredNotices = [];
            this.#lastError = undefined;
            warn("live", `session closed (${reason}); listening for the wake phrase again`);
            this.#armDormant(`Gemini closed the voice session (${reason}). Say the wake phrase to start a new one.`);
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

            // Whatever killed the session, do not leave the voice unusable: arm the
            // wake path so the phrase can bring it back without a restart.
            this.#armDormant(error.message);
            this.#broadcast({ t: "notice", text: error.message });
        });
    }

    /**
     * Park the controller in the "started asleep" state after a session death.
     *
     * Everything keeps running except the Gemini socket: the mic, the wake spotter
     * and the idle loop. Only possible with a wake phrase — without always-on
     * listening there is nothing to reconnect it, so the error stands.
     */
    #armDormant(reason: string): void {
        if (!this.#config.alwaysOn || this.#dormant) {
            if (this.#config.alwaysOn) {
                this.#renderStatus(true);
            }

            return;
        }

        this.#dormant = true;
        this.#wakePending = false;
        this.#pendingAudio = [];
        this.#pendingBytes = 0;
        log("controller", `asleep after session end (${reason})`);
        this.#broadcast({ t: "dormant", reason });
        this.#renderStatus(true);
    }

    // -----------------------------------------------------------------------
    // Talking over the model
    // -----------------------------------------------------------------------

    /**
     * Is the model still talking — generating, or still audible?
     *
     * Three signals, because each one alone left a gap: the server is mid-turn
     * (`#modelTurnOpen`), we are deliberately muting the rest of a cut sentence
     * (`#dropAudio`), or frames have been handed to the player and it is still
     * draining them (`native.playingUntil`, which already includes the speaker tail).
     */
    #modelSpeaking(): boolean {
        if (this.#modelTurnOpen || this.#dropAudio) {
            return true;
        }

        const until = Math.max(this.#lastAudioOutAt, this.#native?.playingUntil ?? 0);

        return Date.now() < until;
    }

    /**
     * Deliver a notice into the live conversation without ever talking over it.
     *
     * `interrupt` cuts the current sentence (right for an answer the user is waiting
     * for); the alternative waits for the sentence to end, but a notice that arrives
     * while the server is still generating is now *held* until that turn completes.
     * Pushing it early is what produced two voices: the old sentence and the new
     * answer were generated and played on top of each other.
     */
    #notice(build: (interrupted: boolean) => string, interrupt = true): boolean {
        const session = this.#session;
        const state = session?.state;

        if (!session || (state !== "live" && state !== "sleeping")) {
            return false;
        }

        // A reply delivered into an idle-gated session was heard but its answer was
        // not: the mic has to be open before the model speaks. This includes a
        // session that died and went dormant — the notice is held in the session's
        // outbox and delivered once the wake reconnects it.
        if (state === "sleeping") {
            log("controller", "notice while asleep: re-opening the mic so the answer is heard");
            this.wake();
        }

        const interrupted = interrupt && this.#cutPlayback();
        const text = build(interrupted);

        if (this.#modelTurnOpen) {
            this.#deferNotice(text);

            return true;
        }

        session.sendText(text);

        return true;
    }

    /** Cut local playback and mute the rest of the sentence that is streaming down. */
    #cutPlayback(): boolean {
        if (!this.#modelSpeaking()) {
            return false;
        }

        log("controller", "cutting playback: the notice arrived mid-sentence");
        this.#native?.flush();
        this.#broadcast({ t: "interrupt" });

        // Only a turn the server is still generating keeps sending frames. When the
        // tail of an already-finished turn is simply draining from the player, the
        // flush is enough — muting here would swallow the *new* answer instead.
        if (!this.#modelTurnOpen) {
            return true;
        }

        this.#dropAudio = true;

        if (this.#dropAudioTimer) {
            clearTimeout(this.#dropAudioTimer);
        }

        // Cap: if the server never reports the turn ending, resume instead of staying mute.
        this.#dropAudioTimer = setTimeout(() => this.#endDroppedAudio(), 4000);
        (this.#dropAudioTimer as { unref?: () => void }).unref?.();

        return true;
    }

    /** Hold a notice until the model's turn ends (see #notice). */
    #deferNotice(text: string): void {
        log("controller", "model mid-turn: holding the notice until that turn ends");
        this.#deferredNotices.push(text);

        if (this.#deferredNoticesTimer) {
            return;
        }

        // Cap: a server that never ends the turn must not silence the answer.
        this.#deferredNoticesTimer = setTimeout(() => {
            log("controller", "held notice timed out; delivering it now");
            this.#flushDeferredNotices();
        }, 2500);
        (this.#deferredNoticesTimer as { unref?: () => void }).unref?.();
    }

    #flushDeferredNotices(): void {
        if (this.#deferredNoticesTimer) {
            clearTimeout(this.#deferredNoticesTimer);
            this.#deferredNoticesTimer = undefined;
        }

        const pending = this.#deferredNotices.splice(0, this.#deferredNotices.length);
        const session = this.#session;

        if (!session) {
            return;
        }

        for (const text of pending) {
            log("controller", "delivering a held notice");
            session.sendText(text);
        }
    }

    #endDroppedAudio(): void {
        this.#dropAudio = false;

        if (this.#dropAudioTimer) {
            clearTimeout(this.#dropAudioTimer);
            this.#dropAudioTimer = undefined;
        }
    }

    /**
     * Seed the digest from the Pi session Pi is *already* showing the user.
     *
     * Without this, `/resume` produced a voice assistant that answered "what did the
     * agent do in this session?" with "I have no context yet": message events only
     * ever arrive for messages sent *after* the extension started, and a resumed
     * session's history never replays.
     */
    #seedBridgeFromSession(): void {
        try {
            const manager = this.ctx.sessionManager as unknown as {
                buildSessionContext?: () => { messages?: unknown[] };
            } | undefined;
            const messages = manager?.buildSessionContext?.()?.messages;

            if (messages && messages.length > 0) {
                this.#bridge.seedTranscript(messages);
                log("controller", `seeded voice context with ${messages.length} session message(s)`);
            }
        } catch (error) {
            warn("controller", `could not read the session transcript: ${String(error)}`);
        }
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

                // Not an interruption: an approval prompt can wait for the sentence to
                // finish, but it still must not be pushed into an open turn.
                this.#notice(() => approvalNotice(approval.toolCallId, approval.toolName, approval.summary), false);
                this.#broadcast({ t: "approval", id: approval.toolCallId, tool: approval.toolName, summary: approval.summary });

                return;
            }

            if (kind === "activity") {
                const activity = (payload as { activity: { kind: string; text: string } }).activity;

                if (activity.kind !== "settled" || !activity.text) {
                    return;
                }

                // A spoken request is owed an answer even with `announce` off: the voice
                // agent told the user it would report back. `agent_settled` (not the raw
                // reply event) is used so a mid-turn message is never read out on its own.
                const owed = Date.now() <= this.#awaitingReplyUntil;

                if (!this.#config.announce && !owed) {
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
                this.#awaitingReplyUntil = 0;
                this.#notice((interrupted) => agentReplyNotice(activity.text, interrupted), true);
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
        peer.send(JSON.stringify({ t: "state", state: this.liveState, detail: this.#config.model }));
    }

    #onPeerData(peer: WebSocketPeer, data: string | Uint8Array, isBinary: boolean): void {
        if (isBinary) {
            const bytes = data instanceof Uint8Array ? data : new Uint8Array();

            if (bytes.length === 0) {
                return;
            }

            this.#feedMic(bytes);

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
            state: this.liveState,
            levels: this.#levels,
            alwaysOn: this.#config.alwaysOn,
            error: this.#lastError,
            silent: this.micSilent,
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