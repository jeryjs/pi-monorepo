/**
 * Lifecycle harness: drives the *real* VoiceController against a fake Gemini Live
 * endpoint (only the URL is swapped, through PI_VOICE_LIVE_URL).
 *
 * The focus is the restart / stop-start surface, where the interesting bugs live:
 * double start, stop during start, restart resumption, reload rebind, cross-process
 * locking, and subscription / lock / socket cleanup across many cycles.
 *
 * Everything but the audio device is real: real VoiceController, real LiveSession,
 * real bridge, real lock and persist files. Audio itself is a silent sink (see
 * `SilentAudio`) so the suite runs on a machine with no microphone and no ffmpeg —
 * ffmpeg capture/playback is covered by test/smoke.ts.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AudioSink, NativeTransportOptions, WakeEngineStatus } from "../audio/native.ts";
import { acceptWebSocket } from "./ws-server.ts";
import type { WebSocketPeer } from "./ws-server.ts";
import { VoiceController } from "../controller.ts";
import { DEFAULT_VOICE_CONFIG, patchVoiceConfig } from "../config.ts";
import type { VoiceConfig } from "../config.ts";
import { readLock } from "../lock.ts";

// ---------------------------------------------------------------------------
// scratch environment: never touch the developer's real lock/state files
// ---------------------------------------------------------------------------

const sandbox = mkdtempSync(join(tmpdir(), "pi-voice-lifecycle-"));
const cwd = join(sandbox, "workspace");

process.env.PI_AGENT_DIR = join(sandbox, "agent");
process.env.PI_VOICE_STATE = join(sandbox, "voice-state.json");
process.env.PI_VOICE_AUTH = join(sandbox, "auth.json");
process.env.PI_VOICE_DEBUG = "";

let passed = 0;

function ok(name: string): void {
    passed++;
    console.log("  ok  " + name);
}

// ---------------------------------------------------------------------------
// fake Gemini Live endpoint (handshake + setup + resumption + tool calls)
// ---------------------------------------------------------------------------

interface FakeConnection {
    id: number;
    setup: Record<string, unknown> | undefined;
    messages: Record<string, unknown>[];
    closed: boolean;
}

interface FakeLive {
    url: string;
    connections: FakeConnection[];
    toolResponses(connection: FakeConnection): Record<string, unknown>[];
    send(connection: FakeConnection, message: unknown): void;
    closeConnection(connection: FakeConnection, code: number, reason: string): void;
    close(): Promise<void>;
}

function startFakeLive(): Promise<FakeLive> {
    const connections: FakeConnection[] = [];
    const peers = new Map<number, WebSocketPeer>();
    const server = createServer((_req, res) => {
        res.writeHead(404).end();
    });

    server.on("upgrade", (req, socket, head) => {
        const connection: FakeConnection = { id: connections.length + 1, setup: undefined, messages: [], closed: false };

        connections.push(connection);

        const peer = acceptWebSocket(req, socket, head, {
            onMessage: (data, isBinary) => {
                if (isBinary) {
                    return;
                }

                let message: Record<string, unknown>;

                try {
                    message = JSON.parse(String(data)) as Record<string, unknown>;
                } catch {
                    return;
                }

                connection.messages.push(message);

                if (message.setup) {
                    connection.setup = message.setup as Record<string, unknown>;
                    peer?.send(JSON.stringify({ setupComplete: {} }));
                    peer?.send(JSON.stringify({
                        sessionResumptionUpdate: { newHandle: `handle-${connection.id}`, resumable: true },
                    }));
                }
            },
            onClose: () => {
                connection.closed = true;
            },
        });

        if (!peer) {
            connection.closed = true;

            return;
        }

        peers.set(connection.id, peer);
    });

    return new Promise<FakeLive>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();

            if (typeof address !== "object" || !address) {
                throw new Error("fake live server did not bind");
            }

            resolve({
                url: `ws://127.0.0.1:${address.port}/ws`,
                connections,
                toolResponses: (connection) => connection.messages.filter((message) => message.toolResponse),
                send: (connection, message) => {
                    const peer = peers.get(connection.id);

                    if (!peer) {
                        throw new Error(`fake live: connection ${connection.id} is not open`);
                    }

                    peer.send(JSON.stringify(message));
                },
                // Server-side close, exactly how Gemini ends an idle session.
                closeConnection: (connection, code, reason) => {
                    const peer = peers.get(connection.id);

                    if (!peer) {
                        throw new Error(`fake live: connection ${connection.id} is not open`);
                    }

                    peer.close(code, reason);
                },
                close: () => new Promise<void>((done) => {
                    for (const peer of peers.values()) {
                        try {
                            peer.close(1001, "test over");
                        } catch {
                            // ignore
                        }
                    }

                    server.close(() => done());
                }),
            });
        });
    });
}

async function until(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
    const started = Date.now();

    while (!check()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error(`timed out waiting for ${label}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

// ---------------------------------------------------------------------------
// stubs for Pi
// ---------------------------------------------------------------------------

interface StubPi {
    api: ExtensionAPI;
    activeHandlers(): number;
    /** Fire a Pi event at whatever the extension subscribed to. */
    emit(event: string, ...args: unknown[]): number;
    sent: string[];
    sentOptions: unknown[];
    entries: { type: string; data: unknown }[];
    failSend: boolean;
}

function makePi(): StubPi {
    const active = new Set<() => void>();
    const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    const stub: StubPi = {
        activeHandlers: () => active.size,
        emit: (event, ...args) => {
            let fired = 0;

            for (const handler of [...(handlers.get(event) ?? [])]) {
                fired++;
                handler(...args);
            }

            return fired;
        },
        sent: [],
        sentOptions: [],
        entries: [],
        failSend: false,
        api: undefined as unknown as ExtensionAPI,
    };

    stub.api = {
        on: (event: string, handler: (...args: unknown[]) => void) => {
            let live = true;
            const bucket = handlers.get(event) ?? new Set<(...args: unknown[]) => void>();

            handlers.set(event, bucket);
            bucket.add(handler);

            const off = () => {
                if (live) {
                    live = false;
                    active.delete(off);
                    bucket.delete(handler);
                }
            };

            active.add(off);

            return off;
        },
        sendUserMessage: (message: string, options?: unknown) => {
            if (stub.failSend) {
                throw new Error("no active session");
            }

            stub.sent.push(message);
            stub.sentOptions.push(options ?? null);
        },
        appendEntry: (type: string, data: unknown) => {
            stub.entries.push({ type, data });
        },
        getSessionName: () => undefined,
    } as unknown as ExtensionAPI;

    return stub;
}

function makeCtx(history?: unknown[]): ExtensionContext {
    return {
        cwd,
        mode: "cli",
        ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
        sessionManager: {
            getBranch: () => [],
            // What a `/resume` hands the extension: the messages Pi is already showing.
            buildSessionContext: () => ({ messages: history ?? [], thinkingLevel: "low", model: null }),
        },
        modelRegistry: {},
        abort: () => {},
        isIdle: () => true,
    } as unknown as ExtensionContext;
}

/**
 * Audio sink that satisfies the transport contract and does nothing.
 *
 * The controller, socket, tools and lock are all real; only PCM in/out is inert.
 */
class SilentAudio implements AudioSink {
    #streaming = true;
    #wakeEngine: WakeEngineStatus | undefined = undefined;
    started = 0;
    stopped = 0;
    played = 0;

    readonly options: NativeTransportOptions;

    constructor(options: NativeTransportOptions) {
        this.options = options;
    }

    async start(): Promise<void> {
        this.started++;
    }

    stop(): void {
        this.stopped++;
    }

    play(bytes: Uint8Array): void {
        this.played += bytes.length;
        this.options.onLevel?.(0.01);
    }

    flush(): void {}

    setStreaming(streaming: boolean): void {
        this.#streaming = streaming;
    }

    get playingUntil(): number {
        return 0;
    }

    get wakeEngine(): WakeEngineStatus | undefined {
        return this.#wakeEngine;
    }

    /** Tests set this to check how a live wake engine is reported in status. */
    set wakeEngine(value: WakeEngineStatus | undefined) {
        this.#wakeEngine = value;
    }

    get streaming(): boolean {
        return this.#streaming;
    }
}

/**
 * Build a controller whose audio side is the silent sink. Every test uses this:
 * a real transport would open a microphone and feed ambient noise into the idle
 * gate, which is exactly what these tests want to control.
 */
function makeController(
    api: ExtensionAPI,
    ctx: ExtensionContext,
    config: VoiceConfig,
    createAudio: (options: NativeTransportOptions) => AudioSink = (options) => new SilentAudio(options),
    onConfigChange?: (next: VoiceConfig) => void,
): VoiceController {
    return new VoiceController(api, ctx, config, { createAudio, onConfigChange });
}

function makeConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
    return patchVoiceConfig(DEFAULT_VOICE_CONFIG, {
        alwaysOn: false,
        apiKey: "test-key",
        autonomy: "steer",
        debug: false,
        announce: false,
        ...overrides,
    } as Partial<VoiceConfig>);
}

// ---------------------------------------------------------------------------
// 1. start / stop loops
// ---------------------------------------------------------------------------

const live = await startFakeLive();
process.env.PI_VOICE_LIVE_URL = live.url;

const pi = makePi();
const sinks: SilentAudio[] = [];
const controller = makeController(pi.api, makeCtx(), makeConfig(), (transportOptions) => {
    const sink = new SilentAudio(transportOptions);
    sinks.push(sink);

    return sink;
});

for (let cycle = 1; cycle <= 5; cycle++) {
    const result = await controller.start();

    assert.equal(controller.running, true, `cycle ${cycle}: running after start`);

    if (cycle === 1) {
        // Status must name the engine that really started. It used to wrap every
        // provider in "sherpa (...)", so an ASR session was reported as sherpa.
        sinks[0]!.wakeEngine = { kind: "asr", provider: "cpu" };
        assert.equal(controller.wakeEngineActive, "asr (cpu)", "status names the ASR engine");
        sinks[0]!.wakeEngine = { kind: "sherpa", provider: "directml" };
        assert.equal(controller.wakeEngineActive, "sherpa (directml)", "status names the KWS engine");
        sinks[0]!.wakeEngine = undefined;
        assert.equal(controller.wakeEngineActive, "energy VAD", "status falls back to the energy VAD");
    }
    assert.equal(result.model, DEFAULT_VOICE_CONFIG.model, `cycle ${cycle}: model reported`);
    assert.equal(readLock(cwd)?.pid, process.pid, `cycle ${cycle}: lock held while running`);

    // The handshake is asynchronous: wait for the setup frame, otherwise the socket
    // is torn down mid-handshake and nothing real is exercised.
    await until(
        () => live.connections.length === cycle && Boolean(live.connections[cycle - 1]?.setup),
        `cycle ${cycle}: live setup`,
    );

    await controller.stop();
    await until(() => live.connections[cycle - 1]?.closed === true, `cycle ${cycle}: socket closed`);

    assert.equal(controller.running, false, `cycle ${cycle}: stopped`);
    assert.equal(readLock(cwd), undefined, `cycle ${cycle}: lock released`);
}

ok("5x start/stop cycles keep running state, lock and sockets clean");
assert.equal(live.connections.length, 5, "exactly one live connection per cycle");
ok("each start opened exactly one Live socket (no duplicates, no leaks)");

// One audio sink per start, and every one of them was stopped: a leaked ffmpeg
// pair would show up as a started sink that was never stopped.
assert.equal(sinks.length, 5, "one audio sink per start");
assert.ok(sinks.every((sink) => sink.started === 1), "each sink started once");
assert.ok(sinks.every((sink) => sink.stopped === 1), "each sink stopped once");
ok("every audio sink was started exactly once and stopped exactly once");

// ---------------------------------------------------------------------------
// 2. restart resumes the previous session instead of starting over
// ---------------------------------------------------------------------------

const third = live.connections[2]!;
const fourth = live.connections[3]!;

assert.equal(
    (fourth.setup?.sessionResumption as { handle?: string } | undefined)?.handle,
    "handle-3",
    "fourth connection resumed the handle handed out on the third",
);
ok("restart passes the previous resumption handle back to the server");

// ---------------------------------------------------------------------------
// 3. concurrent start collapses to a single session
// ---------------------------------------------------------------------------

const beforeConcurrent = live.connections.length;
const [a, b] = await Promise.all([controller.start(), controller.start()]);

// In-flight callers share one start promise, so they must get the same object:
// distinct results would mean a second session was built for the same request.
assert.strictEqual(a, b, "concurrent callers got the same start result");
await until(() => Boolean(live.connections[beforeConcurrent]?.setup), "concurrent start setup");
assert.equal(
    live.connections.length - beforeConcurrent,
    1,
    "concurrent start opened one socket",
);
await controller.stop();
ok("double start / autoStart race opens a single Live session");

// ---------------------------------------------------------------------------
// 4. stop() during an in-flight start
// ---------------------------------------------------------------------------

const results = await Promise.allSettled([controller.start(), controller.stop()]);

assert.equal(results[1]?.status, "fulfilled", "stop resolved");
assert.equal(controller.running, false, "not running after cancelled start");
assert.equal(readLock(cwd), undefined, "lock released after cancelled start");
await until(() => live.connections.every((connection) => connection.closed), "all sockets closed");
ok("stop() during start cancels cleanly, releases the lock and closes any socket");

// ...and the next start still works (proves no poisoned state)
const afterCancel = await controller.start();
assert.equal(controller.running, true, "start after cancel works");
assert.equal(afterCancel.resumed, true, "resumes the previous conversation");
await controller.stop();
ok("start works again after a cancelled start (resumption intact)");

// ---------------------------------------------------------------------------
// 5. reload: rebind keeps the socket, drops the old subscriptions
// ---------------------------------------------------------------------------

await controller.start();

const liveBefore = live.connections.length;
await until(() => Boolean(live.connections[liveBefore - 1]?.setup), "pre-reload setup");
assert.ok(pi.activeHandlers() > 0, "bridge subscribed to Pi events");

const reloadedPi = makePi();
controller.rebind(reloadedPi.api, makeCtx());

assert.equal(controller.running, true, "still running after reload");
assert.equal(live.connections.length, liveBefore, "reload did not open a new socket");
assert.equal(pi.activeHandlers(), 0, "old bridge detached from the discarded ExtensionAPI");
assert.ok(reloadedPi.activeHandlers() > 0, "new bridge attached to the reloaded API");
await controller.stop();
ok("/reload rebind keeps the Live socket and hands subscriptions to the new bridge");

// ---------------------------------------------------------------------------
// 5b. idle gate: quiet time gates the mic but keeps the session
// ---------------------------------------------------------------------------

const idleController = makeController(makePi().api,
    makeCtx(),
    makeConfig({ idleSleepMs: 300 }),
);

await idleController.start();
await until(() => idleController.liveState === "live", "idle test: session live");
await until(() => idleController.liveState === "sleeping", "idle gate to engage");
ok("idle time gates the mic upstream instead of dropping the session");

idleController.wake();
assert.equal(idleController.liveState, "live", "wake restores the live state");
await idleController.stop();
ok("wake after an idle gate resumes listening on the same session");

// Voice activity has to keep it awake: the gate keys on the mic level, not on the
// constant frame flow that made it never fire in native mode.
const talker = makeController(makePi().api, makeCtx(), makeConfig({ idleSleepMs: 300 }));

await talker.start();
await until(() => talker.liveState === "live", "talker live");

const talking = setInterval(() => talker.pushLevel(0.2), 100);
await new Promise((resolve) => setTimeout(resolve, 2600));
assert.equal(talker.liveState, "live", "voiced audio keeps the session awake");
ok("speech keeps the session awake past the idle window");

clearInterval(talking);
await until(() => talker.liveState === "sleeping", "gate after the talking stops");
ok("silence after speech still reaches the idle gate");
await talker.stop();

// An open model turn is activity, not idleness. With a short idleSleepMs (5 s is
// allowed) extended thinking or a slow tool call used to gate the mic mid-answer,
// dropping barge-in and the user's reply.
const busy = makeController(makePi().api, makeCtx(), makeConfig({ idleSleepMs: 300 }));

await busy.start();
await until(() => busy.liveState === "live", "busy: live");

const busyConnection = live.connections[live.connections.length - 1]!;
const pcm = Buffer.from(new Int16Array([0, 1_000, -1_000, 0]).buffer).toString("base64");

live.send(busyConnection, { serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm } }] } } });
await new Promise((resolve) => setTimeout(resolve, 1200));
assert.equal(busy.liveState, "live", "a turn that is still open must not be gated");
live.send(busyConnection, { serverContent: { turnComplete: true } });
await until(() => busy.liveState === "sleeping", "gate after the turn ends");
ok("the idle gate waits for the open model turn instead of cutting the answer");
await busy.stop();

// ---------------------------------------------------------------------------
// 5c. start asleep: no Live socket until the wake phrase
// ---------------------------------------------------------------------------

const sleeper = makeController(makePi().api,
    makeCtx(),
    makeConfig({ alwaysOn: true, connectOnWake: true }),
);
const socketsBefore = live.connections.length;

await sleeper.start();
assert.equal(sleeper.running, true, "asleep controller is running");
assert.equal(sleeper.liveState, "asleep", "starts in the asleep state");

// Long enough for a socket to appear if it were going to.
await new Promise((resolve) => setTimeout(resolve, 400));
assert.equal(live.connections.length, socketsBefore, "no Live socket is opened while asleep");
assert.equal(sleeper.liveState, "asleep", "still asleep after the window");
ok("connectOnWake starts asleep: no Gemini session exists until the wake phrase");

sleeper.wake();
await until(() => Boolean(live.connections[socketsBefore]?.setup), "socket after wake");
await until(() => sleeper.liveState === "live", "live after wake");
ok("the wake phrase opens the Live session and it goes live");

await sleeper.stop();

const eager = makeController(makePi().api,
    makeCtx(),
    makeConfig({ alwaysOn: true, connectOnWake: false }),
);
const eagerBefore = live.connections.length;

await eager.start();
await until(() => Boolean(live.connections[eagerBefore]?.setup), "eager setup");
// Connected but gated (startSleeping): a socket exists, the mic does not feed it.
assert.equal(eager.liveState, "sleeping", "eager start holds an open session without a wake");
await eager.stop();
ok("connectOnWake=false keeps the eager behaviour (socket open at startup)");

// A config change while asleep must not open the socket: `updateConfig` used to
// call #scheduleMaxSession()/reconnectNow() unconditionally, which is exactly how a
// "start asleep" session turned up `live` without anyone saying the wake phrase.
const staysAsleep = makeController(makePi().api,
    makeCtx(),
    makeConfig({ alwaysOn: true, connectOnWake: true }),
);
const beforeConfig = live.connections.length;

await staysAsleep.start();
staysAsleep.updateConfig(makeConfig({ alwaysOn: true, connectOnWake: true, model: "gemini-3.8-live", idleSleepMs: 60_000 }));
await new Promise((resolve) => setTimeout(resolve, 600));

assert.equal(live.connections.length, beforeConfig, "config change while asleep opened no socket");
assert.equal(staysAsleep.liveState, "asleep", "still asleep after a config change");
await staysAsleep.stop();
ok("a config change while asleep does not connect the session");

// ...while turning the wake word off has to leave something usable.
const wakeDisabled = makeController(makePi().api,
    makeCtx(),
    makeConfig({ alwaysOn: true, connectOnWake: true }),
);
const beforeDisable = live.connections.length;

await wakeDisabled.start();
wakeDisabled.updateConfig(makeConfig({ alwaysOn: false, connectOnWake: true }));
await until(() => Boolean(live.connections[beforeDisable]?.setup), "connect after always-on off");
await wakeDisabled.stop();
ok("disabling always-on while asleep connects instead of leaving dead air");

// The voice model's own `voice_always_on` tool reaches the controller through
// setAlwaysOn(), not updateConfig(). That path used to flip the field alone: the
// session stayed dormant and capture stayed gated, so the user's next sentence went
// into a microphone that was not listening, and the wake phrase could not help
// because it listened to the same closed mic.
const persisted: boolean[] = [];
const toolDisabled = makeController(makePi().api,
    makeCtx(),
    makeConfig({ alwaysOn: true, connectOnWake: true }),
    undefined,
    (next) => persisted.push(next.alwaysOn),
);
const beforeToolDisable = live.connections.length;

await toolDisabled.start();
assert.equal(toolDisabled.liveState, "asleep", "starts asleep with the wake word armed");
toolDisabled.setAlwaysOn(false);
await until(() => Boolean(live.connections[beforeToolDisable]?.setup), "connect after voice_always_on off");
await until(() => toolDisabled.liveState === "live", "live after the tool turned always-on off");
await toolDisabled.stop();
assert.deepEqual(persisted, [false], "the tool's change is handed to the persister");
ok("voice_always_on off while asleep connects the session and persists the change");

// ---------------------------------------------------------------------------
// 6. tool calls: honest results, real abort
// ---------------------------------------------------------------------------

const controller2 = makeController(reloadedPi.api, makeCtx(), makeConfig());
const index = live.connections.length;

await controller2.start();
await until(() => Boolean(live.connections[index]?.setup), "tool-call session setup");

const connection = live.connections[index]!;
const send = (message: unknown): void => live.send(connection, message);

// pi_status ---------------------------------------------------------------
send({ toolCall: { functionCalls: [{ id: "t1", name: "pi_status", args: {} }] } });
await until(() => live.toolResponses(connection).length >= 1, "pi_status response");

const statusResponse = live.toolResponses(connection)[0]!;
const statusBody = (statusResponse.toolResponse as { functionResponses: { response: { state?: string } }[] })
    .functionResponses[0]?.response;

assert.equal(statusBody?.state, "idle", "pi_status reports the agent state");
ok("pi_status round-trips through the real Live session");

// pi_ask with a failing sendUserMessage must NOT claim success
reloadedPi.failSend = true;
send({ toolCall: { functionCalls: [{ id: "t2", name: "pi_ask", args: { message: "do a thing" } }] } });
await until(() => live.toolResponses(connection).length >= 2, "pi_ask failure response");

const failedBody = (live.toolResponses(connection)[1]!.toolResponse as {
    functionResponses: { response: Record<string, unknown> }[];
}).functionResponses[0]?.response;

assert.ok(
    typeof failedBody?.error === "string" && /could not deliver/i.test(String(failedBody.error)),
    "pi_ask reports delivery failure",
);
ok("pi_ask reports a real failure instead of claiming the message was sent");

// pi_ask with a working sendUserMessage reports success and reaches Pi
reloadedPi.failSend = false;
send({ toolCall: { functionCalls: [{ id: "t3", name: "pi_ask", args: { message: "summarise the repo" } }] } });
await until(() => reloadedPi.sent.length > 0, "pi_ask delivery");
assert.equal(reloadedPi.sent[0], "summarise the repo", "message reached Pi verbatim");
ok("pi_ask delivers the spoken request to Pi");

// The delivery mode has to be on the message: the session throws "Agent is already
// processing. Specify streamingBehavior..." when neither name is present, and the
// extension API swallows that rejection into an extension error — so pi_ask said
// "sent" for messages that never arrived while Pi was busy.
//
// Default is steer: speech is about the run happening *now*, and sending every
// request as a follow-up meant "stop that, do this" waited for the run it was
// supposed to redirect.
assert.deepEqual(
    reloadedPi.sentOptions[0],
    { deliverAs: "steer", streamingBehavior: "steer" },
    "pi_ask must default to steering",
);
ok("pi_ask defaults to steering the running turn");

send({ toolCall: { functionCalls: [{ id: "t3b", name: "pi_ask", args: { message: "one for later", mode: "queue" } }] } });
await until(() => reloadedPi.sent.length > 1, "queue delivery");
assert.deepEqual(
    reloadedPi.sentOptions[1],
    { deliverAs: "followUp", streamingBehavior: "followUp" },
    "queue mode must carry followUp for a busy Pi",
);
ok("pi_ask queue mode states the follow-up behaviour explicitly");

// pi_stop must abort the running turn, not just queue text
let aborts = 0;
controller2.setAgentAbort(() => {
    aborts++;
});

const sentBeforeStop = reloadedPi.sent.length;
send({ toolCall: { functionCalls: [{ id: "t4", name: "pi_stop", args: {} }] } });
await until(() => aborts > 0, "pi_stop abort");

assert.equal(aborts, 1, "pi_stop invoked the agent abort handler");
assert.ok(reloadedPi.sent.length > sentBeforeStop, "pi_stop also steers Pi with a stop instruction");
ok("pi_stop performs a real abort (ctx.abort) plus a steering instruction");

await controller2.stop();
assert.equal(reloadedPi.activeHandlers(), 0, "all bridge subscriptions removed on final stop");
ok("no Pi event subscriptions leak across restarts");

// ---------------------------------------------------------------------------
// 5d. context on resume: the voice knows what Pi is already showing
// ---------------------------------------------------------------------------

const history = [
    { role: "system", content: [{ type: "text", text: "you are Pi" }] },
    { role: "user", content: [{ type: "text", text: "fix the flaky deploy script" }] },
    { role: "assistant", content: [{ type: "text", text: "I changed retries to 3 in deploy.sh" }] },
    { role: "toolResult", content: [{ type: "text", text: "noisy tool output that must not reach the prompt" }] },
    { role: "user", content: [{ type: "text", text: "also add a timeout" }] },
    { role: "assistant", content: [{ type: "text", text: "Added a 30s timeout to deploy.sh" }] },
];

const resumed = makeController(makePi().api, makeCtx(history), makeConfig());
const resumedIndex = live.connections.length;

await resumed.start();
await until(() => Boolean(live.connections[resumedIndex]?.setup), "resumed session setup");

const resumedInstruction = (live.connections[resumedIndex]!.setup as {
    systemInstruction: { parts: { text: string }[] };
}).systemInstruction.parts[0]!.text;

assert.ok(
    resumedInstruction.includes("fix the flaky deploy script"),
    "the resumed transcript reaches the system instruction",
);
assert.ok(
    resumedInstruction.includes("also add a timeout"),
    "the user's latest request is in the prompt",
);
assert.ok(
    !resumedInstruction.includes("noisy tool output"),
    "tool results stay out of the voice prompt",
);
assert.ok(
    /never say you have no context/i.test(resumedInstruction),
    "the prompt forbids the 'no context yet' answer",
);
ok("a resumed Pi session is seeded into the voice prompt (last turns + latest request)");

await resumed.stop();

// A brand new session must not pretend to have history.
const blank = makeController(makePi().api, makeCtx([]), makeConfig());
const blankIndex = live.connections.length;

await blank.start();
await until(() => Boolean(live.connections[blankIndex]?.setup), "blank session setup");

const blankInstruction = (live.connections[blankIndex]!.setup as {
    systemInstruction: { parts: { text: string }[] };
}).systemInstruction.parts[0]!.text;

assert.ok(/nothing has happened in this session yet/i.test(blankInstruction), "empty session stays honest");
ok("an empty session is described as empty instead of inventing context");
await blank.stop();

// ---------------------------------------------------------------------------
// 5e. a dead socket parks the voice instead of killing it
// ---------------------------------------------------------------------------

const revivable = makeController(makePi().api, makeCtx(), makeConfig({ alwaysOn: true, connectOnWake: false }));
const beforeDrop = live.connections.length;

await revivable.start();
await until(() => Boolean(live.connections[beforeDrop]?.setup), "revivable session setup");

live.closeConnection(live.connections[beforeDrop]!, 1008, "Session closed");
await until(() => revivable.liveState === "asleep", "controller parks after 1008");
ok("1008 'Session closed' parks the session instead of leaving voice dead");

// No retry storm: the socket count must not grow on its own.
const afterDrop = live.connections.length;
await new Promise((resolve) => setTimeout(resolve, 500));
assert.equal(live.connections.length, afterDrop, "a dormant session does not reconnect on its own");
ok("a parked session does not burn quota reconnecting by itself");

// The wake phrase has to bring it back without restarting Pi.
revivable.wake();
await until(() => Boolean(live.connections[afterDrop]?.setup), "reconnect on wake");
await until(() => revivable.liveState === "live", "live again after wake");
ok("the wake phrase opens a fresh session after the close (no restart needed)");
await revivable.stop();

// A handle *this* connection received can still be rejected: the server rotates
// sessions and changes projects. Recovery used to be gated on "the handle came from
// disk", so this case sat in `error` holding the dead handle, and every wake reused
// it. Now the handle is cleared and a fresh session is opened.
const rotated = makeController(makePi().api, makeCtx(), makeConfig());
const rotatedIndex = live.connections.length;

await rotated.start();
await until(() => Boolean(live.connections[rotatedIndex]?.setup), "rotated: setup");
await until(() => rotated.liveState === "live", "rotated: live");

live.closeConnection(live.connections[rotatedIndex]!, 1008, "BidiGenerateContent session not found");
await until(() => live.connections.length > rotatedIndex + 1, "reconnect after a rejected server handle");

const freshHandle = live.connections[rotatedIndex + 1]!;
await until(() => Boolean(freshHandle.setup), "fresh setup after the rejected handle");
assert.equal(
    (freshHandle.setup?.sessionResumption as { handle?: string } | undefined)?.handle,
    undefined,
    "the rejected handle is not sent again",
);
await rotated.stop();
ok("a rejected handle issued by the server reconnects fresh instead of dying");

// With no wake phrase there is nothing to re-arm, so the old behaviour stands.
const noWake = makeController(makePi().api, makeCtx(), makeConfig({ alwaysOn: false, connectOnWake: false }));
const beforeNoWake = live.connections.length;

await noWake.start();
await until(() => Boolean(live.connections[beforeNoWake]?.setup), "no-wake session setup");

live.closeConnection(live.connections[beforeNoWake]!, 1008, "Session closed");
await until(() => live.connections.length > beforeNoWake + 1, "automatic retry without a wake word");
ok("without always-on listening the session retries itself as before");
await noWake.stop();

// A genuine setup error must still be an error, not a silent park.
const broken = makeController(makePi().api, makeCtx(), makeConfig({ alwaysOn: true, connectOnWake: false }));
const beforeBroken = live.connections.length;

await broken.start();
await until(() => Boolean(live.connections[beforeBroken]?.setup), "broken session setup");

live.closeConnection(live.connections[beforeBroken]!, 1008, "You are not permitted to use this model");
await until(() => /not permitted/i.test(String(broken.lastError ?? "")), "policy error surfaced");
assert.equal(broken.liveState, "asleep", "policy close parks too, so the wake phrase can retry");
ok("a policy refusal is reported and still leaves a way back in");
await broken.stop();

// ---------------------------------------------------------------------------
// 5f. one voice at a time: notices never stack on an open turn
// ---------------------------------------------------------------------------

const answererPi = makePi();
const answerer = makeController(answererPi.api, makeCtx(), makeConfig({ announce: true }));
const answererIndex = live.connections.length;

await answerer.start();
await until(() => Boolean(live.connections[answererIndex]?.setup), "answerer session setup");

const answerConnection = live.connections[answererIndex]!;
const replyNotices = (): Record<string, unknown>[] => answerConnection.messages.filter((message) => {
    const content = message.clientContent as { turns?: { parts?: { text?: string }[] }[] } | undefined;

    // Interrupted notices open with "[Pi's answer arrived..." instead.
    return Boolean(content?.turns?.some((turn) => /\[Pi replied\]|\[Pi's answer arrived/.test(turn.parts?.[0]?.text ?? "")));
});

// Model started a turn: audio is arriving and the server has not ended it.
live.send(answerConnection, {
    serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAA" } }] } },
});
await new Promise((resolve) => setTimeout(resolve, 100));

// Pi finishes while that turn is open: the notice must be held, not pushed.
answererPi.emit("agent_start");
answererPi.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "The deploy is green now." }] } });
answererPi.emit("agent_settled");

await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(replyNotices().length, 0, "no notice is pushed into an open turn");
ok("a Pi answer arriving mid-turn is held back instead of talking over the model");

live.send(answerConnection, { serverContent: { turnComplete: true } });
await until(() => replyNotices().length > 0, "notice delivered after the turn ends");
const heldText = (replyNotices()[0]!.clientContent as { turns: { parts: { text: string }[] }[] })
    .turns[0]!.parts[0]!.text;
assert.ok(/cut off mid-sentence/i.test(heldText), "the held notice explains the cut");
assert.ok(/deploy is green/i.test(heldText), "the held notice carries Pi's answer");
ok("the held notice is delivered the moment the turn completes");

await answerer.stop();

// ---------------------------------------------------------------------------
// 7. one instance per workspace, across processes
// ---------------------------------------------------------------------------

const lockModule = new URL("../lock.ts", import.meta.url).href;
const holder = spawn(process.execPath, [
    "--input-type=module",
    "-e",
    `import { acquireLock } from ${JSON.stringify(lockModule)};
     const result = acquireLock(${JSON.stringify(cwd)});
     console.log(JSON.stringify(result.ok ? { ok: true } : { ok: false, pid: result.lock.pid }));
     setInterval(() => {}, 1000);`,
], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, PI_AGENT_DIR: process.env.PI_AGENT_DIR } });

await until(() => readLock(cwd)?.pid === holder.pid, "child process to take the lock");

const rival = makeController(makePi().api, makeCtx(), makeConfig());
await assert.rejects(() => rival.start(), /already running in this workspace/i);
ok("a second Pi process in the same workspace refuses to duplicate the session");

holder.kill();
await until(() => {
    try {
        process.kill(holder.pid as number, 0);

        return false;
    } catch {
        return true;
    }
}, "child process to exit");

// The stale lock file is still there; the next start must take it over.
const revived = makeController(makePi().api, makeCtx(), makeConfig());
await revived.start();
assert.equal(readLock(cwd)?.pid, process.pid, "stale lock taken over by the new owner");
await revived.stop();
ok("a stale lock from a dead process is taken over instead of blocking voice");

// ---------------------------------------------------------------------------
// done
// ---------------------------------------------------------------------------

await live.close();
rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${passed} lifecycle checks passed (start/stop/restart/reload/tool-calls/locking).`);
