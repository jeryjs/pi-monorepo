/**
 * Lifecycle harness: drives the *real* VoiceController against a fake Gemini Live
 * endpoint (only the URL is swapped, through PI_VOICE_LIVE_URL).
 *
 * The focus is the restart / stop-start surface, where the interesting bugs live:
 * double start, stop during start, restart resumption, reload rebind, cross-process
 * locking, and subscription / lock / socket cleanup across many cycles.
 *
 * Nothing inside pi-voice is mocked: real audio endpoint, real LiveSession, real
 * bridge, real lock and persist files.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { acceptWebSocket } from "../audio/ws.ts";
import type { WebSocketPeer } from "../audio/ws.ts";
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
    sent: string[];
    entries: { type: string; data: unknown }[];
    failSend: boolean;
}

function makePi(): StubPi {
    const active = new Set<() => void>();
    const stub: StubPi = {
        activeHandlers: () => active.size,
        sent: [],
        entries: [],
        failSend: false,
        api: undefined as unknown as ExtensionAPI,
    };

    stub.api = {
        on: (_event: string, _handler: (...args: unknown[]) => void) => {
            let live = true;
            const off = () => {
                if (live) {
                    live = false;
                    active.delete(off);
                }
            };

            active.add(off);

            return off;
        },
        sendUserMessage: (message: string) => {
            if (stub.failSend) {
                throw new Error("no active session");
            }

            stub.sent.push(message);
        },
        appendEntry: (type: string, data: unknown) => {
            stub.entries.push({ type, data });
        },
        getSessionName: () => undefined,
    } as unknown as ExtensionAPI;

    return stub;
}

function makeCtx(): ExtensionContext {
    return {
        cwd,
        mode: "cli",
        ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} },
        sessionManager: { getBranch: () => [] },
        modelRegistry: {},
        abort: () => {},
        isIdle: () => true,
    } as unknown as ExtensionContext;
}

function makeConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
    return patchVoiceConfig(DEFAULT_VOICE_CONFIG, {
        // Browser transport: starts the real endpoint but never spawns ffmpeg, so
        // the suite runs headless and fast. Native audio is covered by its own test.
        audio: "browser",
        openBrowser: false,
        port: 0,
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
const controller = new VoiceController(pi.api, makeCtx(), makeConfig());
let firstUrl = "";

for (let cycle = 1; cycle <= 5; cycle++) {
    const result = await controller.start();

    if (cycle === 1) {
        firstUrl = result.url;
    }

    assert.equal(controller.running, true, `cycle ${cycle}: running after start`);
    assert.ok(result.url.startsWith("http://127.0.0.1:"), `cycle ${cycle}: endpoint url`);
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
    assert.equal(controller.peerCount, 0, `cycle ${cycle}: peers cleared`);
}

ok("5x start/stop cycles keep running state, lock, peers and sockets clean");
assert.equal(live.connections.length, 5, "exactly one live connection per cycle");
ok("each start opened exactly one Live socket (no duplicates, no leaks)");

await assert.rejects(() => fetch(firstUrl), "stopped endpoint refuses connections");
ok("stopping closes the local audio endpoint");

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

assert.equal(a.url, b.url, "both callers got the same endpoint");
await until(() => Boolean(live.connections[beforeConcurrent]?.setup), "concurrent start setup");
assert.equal(live.connections.length - beforeConcurrent, 1, "concurrent start opened one socket");
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

const idleController = new VoiceController(
    makePi().api,
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
const talker = new VoiceController(makePi().api, makeCtx(), makeConfig({ idleSleepMs: 300 }));

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

// ---------------------------------------------------------------------------
// 5c. start asleep: no Live socket until the wake phrase
// ---------------------------------------------------------------------------

const sleeper = new VoiceController(
    makePi().api,
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

const eager = new VoiceController(
    makePi().api,
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
const staysAsleep = new VoiceController(
    makePi().api,
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
const wakeDisabled = new VoiceController(
    makePi().api,
    makeCtx(),
    makeConfig({ alwaysOn: true, connectOnWake: true }),
);
const beforeDisable = live.connections.length;

await wakeDisabled.start();
wakeDisabled.updateConfig(makeConfig({ alwaysOn: false, connectOnWake: true }));
await until(() => Boolean(live.connections[beforeDisable]?.setup), "connect after always-on off");
await wakeDisabled.stop();
ok("disabling always-on while asleep connects instead of leaving dead air");

// ---------------------------------------------------------------------------
// 6. tool calls: honest results, real abort
// ---------------------------------------------------------------------------

const controller2 = new VoiceController(reloadedPi.api, makeCtx(), makeConfig());
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

const rival = new VoiceController(makePi().api, makeCtx(), makeConfig());
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
const revived = new VoiceController(makePi().api, makeCtx(), makeConfig());
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
