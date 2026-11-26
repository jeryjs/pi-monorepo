/**
 * Integration test for the local audio endpoint: HTTP static serving, token
 * gating, and the hand-rolled WebSocket server (handshake + text + binary).
 */

import assert from "node:assert/strict";
import { startAudioServer } from "../audio/server.ts";
import type { WebSocketPeer } from "../audio/ws.ts";

const TOKEN = "test-token";
const received: { text?: string; binary?: number[] }[] = [];

const server = await startAudioServer({
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    clientConfig: () => ({ model: "gemini-3.8-live", alwaysOn: false }),
    onPeer: (peer: WebSocketPeer, attach) => {
        attach((data, isBinary) => {
            if (isBinary) {
                received.push({ binary: Array.from(data as Uint8Array) });
                peer.send(new Uint8Array([9, 8, 7]));
            } else {
                received.push({ text: String(data) });
                peer.send(JSON.stringify({ t: "echo", got: JSON.parse(String(data)) }));
            }
        });

        peer.send(JSON.stringify({ t: "hello" }));
    },
});

const base = `http://127.0.0.1:${server.port}`;
let passed = 0;

function ok(name: string): void {
    passed++;
    console.log("  ok  " + name);
}

// --- HTTP -------------------------------------------------------------------

const health = await fetch(`${base}/health`);
assert.equal(health.status, 200);
ok("health endpoint responds");

const forbidden = await fetch(`${base}/client-config`);
assert.equal(forbidden.status, 403);
ok("missing token is rejected");

const config = (await fetch(`${base}/client-config?t=${TOKEN}`)).json() as Promise<Record<string, unknown>>;
assert.equal((await config).model, "gemini-3.8-live");
ok("client config is served with the token");

const page = await fetch(`${base}/?t=${TOKEN}`);
assert.equal(page.status, 200);
const html = await page.text();
assert.ok(html.includes("Pi Voice"));
assert.ok((page.headers.get("content-type") ?? "").includes("text/html"));
ok("index.html is served");

// The page requests these relatively, without the token. Gating them breaks it.
const script = await fetch(`${base}/voice.js`);
assert.equal(script.status, 200);
assert.ok((script.headers.get("content-type") ?? "").includes("javascript"));
ok("voice.js loads without the token");

const style = await fetch(`${base}/styles.css`);
assert.equal(style.status, 200);
ok("styles.css loads without the token");

const worklet = await fetch(`${base}/worklet-playback.js`);
assert.equal(worklet.status, 200);
ok("worklets load without the token");

const rooted = await fetch(`${base}/`);
assert.equal(rooted.status, 403);
ok("index still requires the token");

const escape = await fetch(`${base}/..%2f..%2fpackage.json?t=${TOKEN}`);
assert.ok([403, 404].includes(escape.status));
ok("path traversal is contained");

// --- WebSocket --------------------------------------------------------------

const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?t=${TOKEN}`);
socket.binaryType = "arraybuffer";

const messages: unknown[] = [];
const binary: number[][] = [];

const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 5000);
    socket.onopen = () => {
        clearTimeout(timer);
        resolve();
    };
    socket.onerror = () => reject(new Error("ws error"));
});

socket.onmessage = (event) => {
    if (typeof event.data === "string") {
        messages.push(JSON.parse(event.data));
    } else {
        binary.push(Array.from(new Uint8Array(event.data as ArrayBuffer)));
    }
};

await opened;
ok("websocket handshake succeeds");

const gotEcho = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("echo timeout")), 5000);
    const check = setInterval(() => {
        if (messages.some((m) => (m as { t?: string }).t === "echo")) {
            clearInterval(check);
            clearTimeout(timer);
            resolve();
        }
    }, 20);
});

socket.send(JSON.stringify({ t: "ping", n: 1 }));
await gotEcho;
ok("text frames round-trip (masked client -> server -> client)");

const gotBinary = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("binary timeout")), 5000);
    const check = setInterval(() => {
        if (binary.some((b) => b.join(",") === "9,8,7")) {
            clearInterval(check);
            clearTimeout(timer);
            resolve();
        }
    }, 20);
});

socket.send(new Uint8Array([1, 2, 3, 4, 5]));
await gotBinary;
assert.deepEqual(received.find((r) => r.binary)?.binary, [1, 2, 3, 4, 5]);
ok("binary frames round-trip both ways");

socket.close(1000, "done");
await new Promise((resolve) => setTimeout(resolve, 150));
assert.ok(server.peerCount === 0);
ok("peer is cleaned up on close");

// --- hostile input ----------------------------------------------------------

process.on("uncaughtException", (error) => {
    console.error("uncaught exception escaped the server handler:", error);

    process.exit(3);
});

async function raw(request: string): Promise<string> {
    const net = await import("node:net");

    return new Promise<string>((resolve) => {
        const client = net.connect(server.port, "127.0.0.1", () => client.write(request));
        let buffer = "";

        client.on("data", (chunk) => {
            buffer += chunk.toString();
        });
        client.on("close", () => resolve(buffer.split("\r\n")[0] ?? ""));
        client.on("error", (error) => resolve(`ERR ${error.message}`));
        setTimeout(() => client.destroy(), 1500);
    });
}

const badPercent = await raw("GET /% HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
assert.ok(badPercent.startsWith("HTTP/1.1 400"), `malformed escape should be a 400, got ${badPercent}`);
ok("a malformed URL escape is rejected instead of crashing the process");

const badHost = await raw("GET /health HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n");
assert.equal(badHost.includes("HTTP/1.1"), true, `invalid Host should still answer, got ${badHost}`);
ok("an invalid Host header does not kill the process");

const badUpgrade = await raw("GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: nope\r\nSec-WebSocket-Version: [\r\n\r\n");
assert.equal(badUpgrade.includes("HTTP/1.1"), true, "bad upgrade should get an HTTP error");
ok("a malformed websocket upgrade is rejected, not fatal");

// The endpoint must still work after all of that.
const stillAlive = await fetch(`${base}/health`);
assert.equal(stillAlive.status, 200);
ok("the endpoint survives malformed requests");

// --- oversized frames -------------------------------------------------------

const oversized = new WebSocket(`ws://127.0.0.1:${server.port}/ws?t=${TOKEN}`);
const closedWith = new Promise<number>((resolve) => {
    oversized.onclose = (event) => resolve(event.code);
});

await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 5000);

    oversized.onopen = () => {
        clearTimeout(timer);
        resolve();
    };
});

oversized.send(new Uint8Array(5 * 1024 * 1024));
const code = await Promise.race([
    closedWith,
    new Promise<number>((resolve) => setTimeout(() => resolve(-1), 5000)),
]);

assert.equal(code, 1009, `an oversized frame must close with 1009, got ${code}`);
ok("an oversized client frame closes the socket with 1009");

// --- restart cycles ---------------------------------------------------------

await server.close();

for (let cycle = 1; cycle <= 3; cycle++) {
    const restarted = await startAudioServer({
        host: "127.0.0.1",
        port: 0,
        token: `cycle-${cycle}`,
        clientConfig: () => ({ cycle }),
        onPeer: () => {},
    });

    const health = await fetch(`http://127.0.0.1:${restarted.port}/health`);
    assert.equal(health.status, 200, `cycle ${cycle}: restarted endpoint responds`);

    const page = await fetch(`http://127.0.0.1:${restarted.port}/?t=cycle-${cycle}`);
    assert.equal(page.status, 200, `cycle ${cycle}: page served after restart`);

    await restarted.close();
    await assert.rejects(() => fetch(`http://127.0.0.1:${restarted.port}/health`), `cycle ${cycle}: endpoint closed`);
}

ok("the audio endpoint can be started and stopped repeatedly");

console.log(`\n${passed} endpoint checks passed`);