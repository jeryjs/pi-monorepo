/**
 * A tiny RFC 6455 WebSocket *server* (handshake + frames) built only on
 * `node:crypto` and `node:stream`.
 *
 * Test support, not shipped: the lifecycle harness stands up a fake Gemini
 * Live endpoint and needs the server side of the protocol to do it. Node has no
 * WebSocket server, and adding a dependency for tests is not worth it. The npm
 * package excludes `test/`, so this file never reaches a consumer.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Refuse single messages (and unreassembled buffers) larger than this. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export interface WebSocketPeer {
    send(data: string | Uint8Array): void;
    close(code?: number, reason?: string): void;
}

export interface PeerHandlers {
    onMessage(data: string | Uint8Array, isBinary: boolean): void;
    onClose?(code: number): void;
}

function acceptKey(key: string): string {
    return createHash("sha1").update(key + GUID).digest("base64");
}

function frame(opcode: number, payload: Uint8Array): Buffer {
    const length = payload.length;
    let header: Buffer;
    let offset = 0;

    if (length < 126) {
        header = Buffer.alloc(2);
        header[1] = length;
    } else if (length < 65_536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(length, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
    }

    header[0] = 0x80 | opcode; // FIN + opcode
    offset = header.length;

    return Buffer.concat([header.subarray(0, offset), Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)]);
}

/** Handle the HTTP upgrade and return a peer, or write a 400 and return undefined. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, handlers: PeerHandlers): WebSocketPeer | undefined {
    const key = req.headers["sec-websocket-key"];
    const version = req.headers["sec-websocket-version"];

    if (typeof key !== "string" || version !== "13") {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();

        return undefined;
    }

    socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n"
        + "Upgrade: websocket\r\n"
        + "Connection: Upgrade\r\n"
        + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );

    let open = true;
    let buffer = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    let fragmentOpcode = 0;
    let fragments: Buffer[] = [];

    const peer: WebSocketPeer = {
        send(data) {
            if (!open) {
                return;
            }

            const payload = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
            const opcode = typeof data === "string" ? 0x1 : 0x2;

            try {
                socket.write(frame(opcode, payload));
            } catch {
                open = false;
            }
        },
        close(code = 1000, reason = "") {
            if (!open) {
                return;
            }

            open = false;

            try {
                const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
                payload.writeUInt16BE(code, 0);
                payload.write(reason, 2);
                socket.write(frame(0x8, payload));
            } catch {
                // ignore
            }

            socket.end();
        },
    };

    const fail = (code: number, reason = ""): void => {
        open = false;
        handlers.onClose?.(code);

        // Send a real close frame (RFC 6455) so the peer learns the reason instead
        // of seeing a bare 1006 from a destroyed socket.
        try {
            const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
            payload.writeUInt16BE(code, 0);
            payload.write(reason, 2, "utf8");
            socket.write(frame(0x8, payload));
            socket.end();
        } catch {
            try {
                socket.destroy();
            } catch {
                // ignore
            }
        }
    };

    const handleFrame = (opcode: number, payload: Buffer, fin: boolean): void => {
        switch (opcode) {
            case 0x0: // continuation
                fragments.push(payload);

                // A peer that never sends FIN could otherwise grow this without
                // bound; fail the connection instead of leaking memory.
                if (fragments.reduce((total, part) => total + part.length, 0) > MAX_FRAME_BYTES) {
                    fail(1009, "message too big");

                    return;
                }

                if (fin) {
                    const merged = Buffer.concat(fragments);
                    fragments = [];
                    const op = fragmentOpcode;
                    fragmentOpcode = 0;
                    handleFrame(op, merged, true);
                }
                return;

            case 0x1:
            case 0x2:
                if (!fin) {
                    fragmentOpcode = opcode;
                    fragments = [payload];
                    return;
                }

                if (payload.length > MAX_FRAME_BYTES) {
                    fail(1009, "message too big");

                    return;
                }

                try {
                    handlers.onMessage(opcode === 0x1 ? payload.toString("utf8") : payload, opcode === 0x2);
                } catch {
                    // a bad client message must not kill the socket loop
                }
                return;

            case 0x8: {
                const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
                open = false;
                handlers.onClose?.(code);
                try {
                    socket.end();
                } catch {
                    // ignore
                }
                return;
            }

            case 0x9: // ping -> pong
                try {
                    socket.write(frame(0xA, payload));
                } catch {
                    // ignore
                }
                return;

            case 0xA: // pong
                return;

            default:
                return;
        }
    };

    const parse = (): void => {
        while (buffer.length >= 2) {
            const first = buffer[0] as number;
            const second = buffer[1] as number;
            const fin = (first & 0x80) !== 0;
            const opcode = first & 0x0f;
            const masked = (second & 0x80) !== 0;
            let length = second & 0x7f;
            let offset = 2;

            if (length === 126) {
                if (buffer.length < 4) {
                    return;
                }
                length = buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (buffer.length < 10) {
                    return;
                }
                const big = buffer.readBigUInt64BE(2);

                if (big > BigInt(16 * 1024 * 1024)) {
                    fail(1009, "message too big");
                    return;
                }

                length = Number(big);
                offset = 10;
            }

            const maskOffset = masked ? 4 : 0;

            if (buffer.length < offset + maskOffset + length) {
                return;
            }

            let payload: Buffer;

            if (masked) {
                const mask = buffer.subarray(offset, offset + 4);
                const raw = buffer.subarray(offset + 4, offset + 4 + length);
                payload = Buffer.allocUnsafe(length);

                for (let i = 0; i < length; i++) {
                    payload[i] = (raw[i] as number) ^ (mask[i & 3] as number);
                }
            } else {
                payload = Buffer.from(buffer.subarray(offset, offset + length));
            }

            buffer = buffer.subarray(offset + maskOffset + length);
            handleFrame(opcode, payload, fin);
        }
    };

    socket.on("data", (chunk: Buffer) => {
        // Refuse to buffer without bound while waiting for a frame to complete.
        if (buffer.length + chunk.length > MAX_FRAME_BYTES * 2) {
            fail(1009, "message too big");

            return;
        }

        buffer = Buffer.concat([buffer, chunk]);
        parse();
    });

    socket.on("close", () => {
        if (open) {
            open = false;
            handlers.onClose?.(1006);
        }
    });

    socket.on("error", () => {
        if (open) {
            open = false;
            handlers.onClose?.(1006);
        }
    });

    if (buffer.length > 0) {
        parse();
    }

    return peer;
}
