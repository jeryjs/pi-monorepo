/**
 * VoiceController: the conductor.
 *
 *   ffmpeg (mic/speaker)  <-->  this  <-->  WebSocket  <-->  Gemini Live
 *                                 |
 *                                 +--> Pi session (tools, approvals, digest)
 *
 * Keeping the Gemini socket in the Pi process means the API key never leaves it,
 * tool calls execute natively, and audio never leaves the machine.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { capabilitiesFor, type ModelCapabilities } from "./capabilities.ts";
import type { VoiceConfig } from "./config.ts";
import { AgentBridge } from "./bridge/agent.ts";
import { agentReplyNotice, approvalNotice, buildSystemInstruction } from "./bridge/prompt.ts";
import { dispatchTool, functionDeclarations, type VoiceControl } from "./bridge/tools.ts";
import { NativeTransport, type AudioSink, type NativeTransportOptions } from "./audio/native.ts";
import { LiveSession } from "./live/session.ts";
import { createSetupBuilder } from "./live/setup.ts";
import { persistVoiceState, readVoiceState } from "./state.ts";
import { resolveGeminiKey, type KeyRegistry } from "./keychain.ts";
import { acquireLock, releaseLock } from "./lock.ts";
import { clearPersistedHandle, loadPersistedHandle, persistedSeq, savePersistedHandle } from "./persist.ts";
import {
    QUESTION_TTL_MS,
    questionNotice,
    questionWithdrawnNotice,
    resolveAnswers,
    waitingForInputNotice,
    type VoiceAnswerItem,
    type VoiceAnswerResult,
    type VoiceQuestionRequest,
} from "./question.ts";
import { setVoiceStatus, voiceStatusText } from "./ui.ts";
import { log, warn } from "./util.ts";

/**
 * Injection point for the audio side. The product always uses ffmpeg; the
 * lifecycle harness passes a silent sink so it can drive the real controller (and
 * the real sockets, tools and locks) on a machine with no microphone.
 */
export interface VoiceControllerOptions {
    createAudio?: (options: NativeTransportOptions) => AudioSink;
    /** Persist a config change made through a voice tool. */
    onConfigChange?: (config: VoiceConfig) => void;
    /** Hand a spoken answer back to the extension that asked the question. */
    onQuestionAnswer?: (result: VoiceAnswerResult) => void;
    /** Overrides the prompt lifetime; the harness uses a short one. */
    questionTtlMs?: number;
}

export interface StartResult {
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
    #native: AudioSink | undefined;
    #idleTimer: ReturnType<typeof setInterval> | undefined;
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
    /**
     * Prompts waiting for a spoken answer, keyed by the provider's id.
     *
     * A provider (any extension) hands over a question; the voice model reads it out
     * and answers with `voice_answer`, which is relayed back as data. Kept here rather
     * than in the extension so a `/reload` cannot leave a prompt answerable by a socket
     * that no longer exists.
     */
    #questions = new Map<
        string,
        {
            request: VoiceQuestionRequest;
            at: number;
            /**
             * Answers collected so far. A spoken answer usually covers one question at a
             * time ("postgres" ... "and ship it Friday"), so a prompt is only complete
             * when every question has one — and answering the same question again
             * replaces it instead of being counted twice.
             */
            answers: Map<string, VoiceAnswerItem>;
            /** The prompt's own deadline, independent of the idle tick. */
            timer?: ReturnType<typeof setTimeout>;
        }
    >();
    /** Tool calls already announced read-only, so a long tool does not talk twice. */
    #announcedToolCalls = new Set<string>();

    #pi: ExtensionAPI;
    #ctx: ExtensionContext;
    #createAudio: (options: NativeTransportOptions) => AudioSink;
    readonly #onConfigChange: ((config: VoiceConfig) => void) | undefined;
    #onQuestionAnswer: ((result: VoiceAnswerResult) => void) | undefined;
    readonly #questionTtlMs: number;

    constructor(pi: ExtensionAPI, ctx: ExtensionContext, config: VoiceConfig, options: VoiceControllerOptions = {}) {
        this.#pi = pi;
        this.#ctx = ctx;
        this.#config = config;
        this.#createAudio = options.createAudio ?? ((transportOptions) => new NativeTransport(transportOptions));
        this.#onConfigChange = options.onConfigChange;
        this.#onQuestionAnswer = options.onQuestionAnswer;
        this.#questionTtlMs = options.questionTtlMs ?? QUESTION_TTL_MS;
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

    /** Tell the user something that has no other way of reaching them. */
    #tellUser(message: string, kind: "info" | "warning" | "error" = "info"): void {
        try {
            this.ctx.ui.notify(message, kind);
        } catch {
            // No UI in this mode; the status bar and /voice status still carry it.
        }
    }

    /**
     * Reattach to a reloaded Pi session without dropping the Gemini connection.
     * `/reload` disposes the old extension runner, so the bridge is rebuilt while
     * the socket, audio transport and resumption handle stay intact.
     */
    rebind(pi: ExtensionAPI, ctx: ExtensionContext): void {
        const previous = this.#bridge;

        // A reloaded provider instance cannot resolve the old request ids, and the old
        // extension API no longer accepts events. Close the prompts instead of keeping
        // them registered against a socket whose owner has been disposed. The extension
        // also cancels on `session_shutdown`, where the old bus is still valid: by the
        // time `rebind` runs, answering through the old API can already be impossible.
        this.cancelQuestions("reload");

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

    get model(): string {
        return this.#config.model;
    }

    get capabilities(): ModelCapabilities {
        return this.#capabilities;
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

    /**
     * Can the model hear the microphone right now?
     *
     * False while asleep (voice_sleep, /voice sleep), dormant after a close, or
     * idle-gated. `pi_voice status` and /voice status used to report the socket state
     * only, so `state: live` was shown while the mic was muted and the agent could not
     * tell whether speaking would be heard.
     */
    get micOpen(): boolean {
        return !this.#dormant && Boolean(this.#session?.streaming);
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

        // The native transport reports the mic level here, which makes this the one
        // place that knows whether anybody is actually talking. The idle gate keys
        // on that.
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
            return "not running";
        }

        const provider = this.#native.wakeEngine;

        return provider ? `${provider.kind} (${provider.provider})` : "energy VAD";
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
            // A failed or cancelled start must not leak a socket, microphone,
            // player or the workspace lock.
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
            const who = lock.reason === "unwritable"
                ? `voice could not write its lock file in ${lock.lock.cwd} (is the agent directory read-only?)`
                : `voice is already running in this workspace (pid ${lock.lock.pid})`;

            throw new Error(`${who}. Use that instance, or stop it first.`);
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

        const buildSetup = createSetupBuilder({
            config: this.#setupConfig,
            // Both are read per connect: `/voice model` changes the capability table,
            // and a captured object kept declaring NON_BLOCKING tools (and omitting a
            // required thinking level) for a model that no longer supports them.
            capabilities: () => this.#capabilities,
            systemInstruction: instruction,
            tools: () => functionDeclarations(this.#capabilities),
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

        const native = this.#createAudio({
            config: this.#config,
            cwd: this.ctx.cwd,
            onMic: (bytes) => this.#feedMic(bytes),
            onWake: (source) => {
                this.#lastWakeSource = source;
                this.wake();
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
            await Promise.resolve(native.stop()).catch(() => undefined);

            if (generation !== this.#generation) {
                throw new Error("voice start cancelled");
            }

            session.close();

            throw new Error(
                `voice needs ffmpeg for microphone and speaker: ${String(error)}. `
                + "Install ffmpeg and check the input/output device in /voice → Audio "
                + "(/voice diagnose reports what is missing).",
            );
        }

        this.#assertCurrent(generation);
        this.#running = true;
        this.#startedAt = Date.now();
        this.#lastVoiceAt = Date.now();
        this.#renderStatus(true);

        this.#idleTimer = setInterval(() => this.#tickIdle(), 2000);
        (this.#idleTimer as { unref?: () => void }).unref?.();

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
            // Awaited: the capture process must be gone before the lock is released
            // and a replacement can take the microphone (Windows "device busy").
            await native?.stop();
        } catch (error) {
            log("controller", "native stop failed", error);
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

        // A held notice belongs to the session that was just closed: leaving the
        // timer armed let it fire into the next one.
        if (this.#deferredNoticesTimer) {
            clearTimeout(this.#deferredNoticesTimer);
            this.#deferredNoticesTimer = undefined;
        }

        this.#deferredNotices = [];
        this.#dropAudio = false;
        // A turn left open by a session that died must not block the idle gate of the
        // next one forever.
        this.#modelTurnOpen = false;
        // Prompts belonged to the socket that just closed: their ids can never be
        // answered by a new session, and the provider keeps its own UI.
        this.cancelQuestions("voice-stopped");
        this.#announcedToolCalls.clear();
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

        // A resumption handle belongs to the model that issued it. Sending it after a
        // model switch produced a setup the new model rejected (or a session that
        // resumed with the wrong capabilities), so drop it and start clean.
        if (previous.model !== config.model && this.#session) {
            log("controller", `model changed to ${config.model}; dropping the resumption handle`);
            this.#session.setResumptionHandle(undefined);
            this.#saveHandle(undefined);
        }

        this.#renderStatus(true);

        // Transport-level settings can only be applied by rebuilding the process
        // side (mic capture, player, wake spotter).
        const restartKeys: (keyof VoiceConfig)[] = [
            "nativeInput", "ffmpegPath", "ffplayPath", "nativeAec",
            "kwsModelDir", "asrModelDir", "kwsKeywords", "sherpaProvider", "wakeEngine",
            "connectOnWake", "inputGain", "outputGain",
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

            return;
        }

        session?.setStreaming(true);
        this.#native?.setStreaming(true);
    }

    /**
     * Mic audio. While dormant it is dropped unless the wake phrase has just fired,
     * in which case it is held until the socket is live so "hey pi, check my
     * messages" is not cut down to its last syllable.
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
        if (this.#config.alwaysOn === value) {
            return;
        }

        // Changing only the field left the state machine behind: with always-on off
        // while dormant, the session stayed dormant and the transport stayed gated, so
        // the user's next sentence was captured and thrown away. The wake phrase could
        // not bring it back either, because the mic it listens to was closed.
        this.#config = { ...this.#config, alwaysOn: value };

        if (this.#setupConfig) {
            this.#setupConfig.alwaysOn = value;
        }

        if (this.#running && this.#dormant && !value) {
            log("controller", "always-on disabled while asleep; connecting now");
            this.wake();
        }

        this.#onConfigChange?.(this.#config);
        this.#renderStatus(true);
    }

    /** Make the voice model say something (used by Pi's `voice` tool). */
    speak(text: string): boolean {
        // Same treatment as Pi's replies: cut the current sentence instead of
        // talking over it, and never stack a second turn on top of an open one.
        return this.#notice((interrupted) => {
            const lead = interrupted
                ? "[You were cut off mid-sentence; start with a brief \"oh\" and do not finish the old sentence]\n\n"
                : "";

            return `${lead}Say this to the user now, close to verbatim, in your normal spoken voice: ${JSON.stringify(text.slice(0, 800))}`;
        }, true);
    }

    answerApproval(id: string, allow: boolean): boolean {
        return this.#bridge.answerApproval(id, allow);
    }

    /** Called by the Pi-side tool gate. */
    requestApproval(toolName: string, summary: string): Promise<boolean | undefined> {
        return this.#bridge.requestApproval({ toolName, summary });
    }

    get approvalAvailable(): boolean {
        return this.#running && this.#session?.state === "live";
    }

    // -----------------------------------------------------------------------
    // Voice questions (the `voice:question` protocol, see question.ts)
    // -----------------------------------------------------------------------

    /** Relay a spoken/closed prompt to the provider, surviving a disposed extension. */
    #relayAnswer(result: VoiceAnswerResult): void {
        try {
            this.#onQuestionAnswer?.(result);
        } catch (error) {
            warn("controller", `could not relay the answer for ${result.id}: ${String(error)}`);
        }
    }

    /**
     * Close one prompt and tell both sides.
     *
     * `expired`/`voice-stopped`/`reload` all end a prompt the provider is still
     * blocked on, so the provider is told (and can fall back to its own UI) instead of
     * waiting out its timeout.
     */
    #expireQuestion(id: string, reason: "expired" | "voice-stopped" | "reload"): void {
        const entry = this.#questions.get(id);

        if (!entry) {
            return;
        }

        if (entry.timer) {
            clearTimeout(entry.timer);
        }

        this.#questions.delete(id);
        log("controller", `question ${id} closed (${reason})`);

        if (reason === "expired") {
            // The model would otherwise keep asking about a prompt nobody can answer.
            this.#notice(() => questionWithdrawnNotice(id), false);
        }

        this.#relayAnswer({ id, answers: [], cancelled: true, reason });
    }

    /**
     * Point the answer relay at a new extension runtime.
     *
     * The controller outlives `/reload`, but the callback it holds was created by the
     * module instance that was just disposed; relaying through the old `pi` rejects once
     * that runtime is invalidated.
     */
    setAnswerRelay(relay: (result: VoiceAnswerResult) => void): void {
        this.#onQuestionAnswer = relay;
    }

    /**
     * Close every open prompt (teardown, restart, `/reload`).
     */
    cancelQuestions(reason: "voice-stopped" | "reload"): void {
        for (const id of [...this.#questions.keys()]) {
            this.#expireQuestion(id, reason);
        }
    }

    /** Drop prompts past their deadline and report the ones still live. */
    #liveQuestions(now = Date.now()): VoiceQuestionRequest[] {
        for (const [id, entry] of [...this.#questions]) {
            if (now - entry.at > this.#questionTtlMs) {
                this.#expireQuestion(id, "expired");
            }
        }

        return [...this.#questions.values()].map((entry) => entry.request);
    }

    /**
     * Announce a prompt and keep it answerable.
     *
     * Returns false when nothing could be spoken (voice off, socket down, the same id
     * already open): the provider then keeps its own UI as the only way to answer, and
     * a headless provider can fail fast instead of waiting out its timeout.
     */
    presentQuestion(request: VoiceQuestionRequest): boolean {
        if (!this.#running) {
            return false;
        }

        // A second live prompt under the same id would overwrite the first, and answers
        // are matched by id alone — one provider could receive another's answer.
        if (this.#questions.has(request.id)) {
            warn("controller", `voice_question id ${request.id} is already open; ignoring the duplicate`);

            return false;
        }

        if (this.#questions.size >= 8) {
            warn("controller", "too many open questions; ignoring the newest");

            return false;
        }

        const timer = setTimeout(() => this.#expireQuestion(request.id, "expired"), this.#questionTtlMs);

        // Do not hold the process open for a prompt nobody can answer.
        (timer as { unref?: () => void }).unref?.();
        this.#questions.set(request.id, { request, at: Date.now(), answers: new Map(), timer });

        // The user is being asked something: the mic must stay open, or a spoken
        // answer arrives after the idle gate has muted it.
        this.#lastVoiceAt = Date.now();

        const spoken = this.#notice(() => questionNotice(request), true);

        if (!spoken) {
            this.#expireQuestion(request.id, "voice-stopped");
        }

        return spoken;
    }

    /** The provider resolved the prompt on screen (or gave up). */
    withdrawQuestion(id: string): boolean {
        const entry = this.#questions.get(id);

        if (!entry) {
            return false;
        }

        if (entry.timer) {
            clearTimeout(entry.timer);
        }

        this.#questions.delete(id);

        // Tell the model to drop it too, or its next sentence asks about a
        // question that is already answered.
        this.#notice(() => questionWithdrawnNotice(id), false);

        return true;
    }

    /** Is a registered prompt waiting on this tool call? (suppresses the fallback notice) */
    hasQuestionForToolCall(toolCallId: string | undefined): boolean {
        if (!toolCallId) {
            return false;
        }

        return this.#liveQuestions().some((request) => request.toolCallId === toolCallId);
    }

    /**
     * Read-only notice for a blocked tool that never adopted the protocol.
     *
     * Voice cannot answer it — the tool is waiting on its own UI — so the note only
     * tells the user where the question is.
     */
    announceWaitingForInput(toolName: string, prompts: string[], toolCallId?: string): boolean {
        if (!this.#running || prompts.length === 0) {
            return false;
        }

        const key = toolCallId ?? `${toolName}:${prompts[0] ?? ""}`;

        if (this.#announcedToolCalls.has(key) || this.hasQuestionForToolCall(toolCallId)) {
            return false;
        }

        // Bounded: one entry per announcing tool call, and a long session can run
        // thousands of them. The ids are only used to avoid a second announcement, so
        // forgetting old ones is harmless.
        if (this.#announcedToolCalls.size > 64) {
            this.#announcedToolCalls.clear();
        }

        this.#announcedToolCalls.add(key);

        return this.#notice(() => waitingForInputNotice(toolName, prompts), false);
    }

    /**
     * The voice model answered. `undefined` means the id is unknown or expired.
     *
     * The model's strings are matched against the offered options here, so a provider
     * only ever receives an option it actually offered (or free text it allowed).
     */
    answerQuestion(
        id: string,
        raw: unknown,
        cancel = false,
    ): { status: "answered" | "cancelled" | "partial"; count: number; unknown: string[]; freeText?: boolean } | undefined {
        this.#liveQuestions();

        const entry = this.#questions.get(id);

        if (!entry) {
            return undefined;
        }

        if (cancel) {
            this.#expireQuestion(id, "voice-stopped");

            return { status: "cancelled", count: 0, unknown: [] };
        }

        const { answers, unknown } = resolveAnswers(entry.request.questions, raw);

        if (answers.length === 0) {
            // Nothing usable: keep the prompt live so the model can try again rather
            // than silently dropping a question the user is still waiting on. `freeText`
            // is only ever true when *some* blocked question allows it, so the tool tells
            // the model to prefer a listed option and to use free text only where the
            // question permits it (a mixed request used to suggest it for all of them).
            const blocked = entry.request.questions.filter((question) => !entry.answers.has(question.id));
            const freeText = blocked.some((question) => question.allowOther !== false);

            return { status: "partial", count: 0, unknown, freeText };
        }

        for (const answer of answers) {
            entry.answers.set(answer.questionId, answer);
        }

        const complete = entry.request.questions.every((question) => entry.answers.has(question.id));

        if (complete) {
            if (entry.timer) {
                clearTimeout(entry.timer);
            }

            this.#questions.delete(id);
        }

        // Only the new answers are relayed: the provider merges them into its own state,
        // so re-sending earlier ones would be noise (and could re-ask a question).
        this.#relayAnswer({ id, answers, cancelled: false });

        return { status: complete ? "answered" : "partial", count: answers.length, unknown };
    }

    /** Prompts still open, for `/voice status`. */
    get pendingQuestions(): number {
        return this.#liveQuestions().length;
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
        });

        session.on("turnComplete", () => {
            this.#modelTurnOpen = false;
            this.#endDroppedAudio();
            // The old turn is finished: a notice held back for that reason can go now.
            this.#flushDeferredNotices();
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
        });

        session.on("state", (state) => {
            // `sleeping` counts too: the session was built with startSleeping, so a
            // socket opened while gated reports setup-complete as sleeping.
            if (this.#dormant && (state === "live" || state === "sleeping")) {
                this.#flushWakeAudio();
            }

            this.#renderStatus(true);
        });

        session.on("handleInvalid", () => {
            // The persisted handle was rejected; make sure a restart does not reuse it.
            persistVoiceState(this.pi, { handle: undefined, model: this.#config.model, voice: this.#config.voice });
            clearPersistedHandle(this.ctx.cwd);
            this.#tellUser("Saved voice session expired; starting a fresh one.");
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
                this.#tellUser("Google Search grounding needs a billed project; reconnecting without it.", "warning");
                setTimeout(() => session.reconnectNow(), 200).unref?.();

                return;
            }

            // Whatever killed the session, do not leave the voice unusable: arm the
            // wake path so the phrase can bring it back without a restart.
            this.#armDormant(error.message);
            this.#tellUser(error.message, "error");
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

        // A turn the server is still generating is activity, not idleness: with a
        // short idleSleepMs (5 s is allowed) extended thinking or a slow tool call
        // gated the mic mid-answer, so barge-in and the user's reply were dropped.
        if (this.#modelTurnOpen) {
            this.#lastVoiceAt = Date.now();

            return;
        }

        // Pi is waiting for an answer: the next thing said is the answer, so the mic
        // must stay open. Gating here made the user say the wake phrase in the middle
        // of answering a question. The TTL bounds it, so an abandoned prompt cannot
        // keep the socket awake forever.
        if (this.#liveQuestions().length > 0) {
            this.#lastVoiceAt = Date.now();

            return;
        }

        log("controller", "idle: gating the mic upstream, session kept");
        // Gate the capture process too, not just the session: the native transport
        // only stops sending frames when *it* is told to, so gating the session
        // alone let the next frame reopen it.
        this.#native?.setStreaming(false);
        session.setStreaming(false);
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

}