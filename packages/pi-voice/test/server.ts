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

await server.close();
console.log(`\n${passed} endpoint checks passed`);