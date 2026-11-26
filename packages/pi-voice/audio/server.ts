/**
 * The local audio endpoint: an HTTP server that serves the companion page and
 * upgrades `/ws` to a WebSocket for full-duplex PCM + control messages.
 *
 * Bound to loopback only and gated by a per-run token, so other local apps
 * cannot drive the microphone or read transcripts.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../util.ts";
import { acceptWebSocket, type WebSocketPeer } from "./ws.ts";

export type PeerHandler = (data: string | Uint8Array, isBinary: boolean) => void;

export interface AudioServerOptions {
    host: string;
    port: number;
    token: string;
    /** Non-secret settings handed to the page. */
    clientConfig: () => Record<string, unknown>;
    /** Called once per connected page. Use `attach` to receive its messages. */
    onPeer: (peer: WebSocketPeer, attach: (handler: PeerHandler) => void) => void;
    onLog?: (message: string) => void;
}

export interface AudioServer {
    url: string;
    port: number;
    token: string;
    readonly peerCount: number;
    close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
};

const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));

async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
    let relative: string;

    try {
        relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    } catch {
        // decodeURIComponent throws on a lone `%` or malformed escape sequences.
        reply(response, 400, "bad request");

        return;
    }

    const full = join(WEB_ROOT, relative === "" ? "index.html" : relative);

    if (!full.startsWith(WEB_ROOT.endsWith(sep) ? WEB_ROOT : WEB_ROOT + sep)) {
        response.writeHead(403).end("forbidden");

        return;
    }

    try {
        const body = await readFile(full);
        const type = CONTENT_TYPES[extname(full).toLowerCase()] ?? "application/octet-stream";
        response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        response.end(body);
    } catch {
        response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
}

/**
 * Parse without throwing. A malformed request target (`/%`, `//`) or Host header
 * used to escape the handler as an uncaught exception and kill the Pi process,
 * which any web page could trigger with a single image request.
 */
function safeUrl(target: string | undefined): URL | undefined {
    try {
        return new URL(target ?? "/", "http://localhost");
    } catch {
        return undefined;
    }
}

function reply(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
    try {
        res.writeHead(status, { "content-type": type, "cache-control": "no-store" }).end(body);
    } catch {
        // the socket may already be gone; nothing to do
    }
}

function listen(server: Server, host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const onError = (error: NodeJS.ErrnoException): void => {
            if (error.code === "EADDRINUSE" && port !== 0) {
                server.removeListener("error", onError);
                server.once("error", reject);
                server.listen(0, host, () => {
                    const address = server.address();
                    resolve(typeof address === "object" && address ? address.port : 0);
                });

                return;
            }

            reject(error);
        };

        server.once("error", onError);
        server.listen(port, host, () => {
            server.removeListener("error", onError);
            const address = server.address();
            resolve(typeof address === "object" && address ? address.port : port);
        });
    });
}

export async function startAudioServer(options: AudioServerOptions): Promise<AudioServer> {
    const note = options.onLog ?? ((message: string) => log("audio", message));
    const peers = new Set<WebSocketPeer>();

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // Nothing in this handler may throw: an uncaught exception here takes the
        // whole Pi process down.
        try {
            const url = safeUrl(req.url);

            if (!url) {
                reply(res, 400, "bad request");

                return;
            }

            const token = url.searchParams.get("t");

            if (url.pathname === "/health") {
                reply(res, 200, "ok");

                return;
            }

            // Only the page and its config need the token. Static assets are requested
            // by relative URL from the page (no query string), so gating them breaks
            // the page: HTML loads, CSS/JS/worklets 403, and nothing works.
            const guarded = url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/client-config";

            if (guarded && token !== options.token) {
                reply(res, 403, "forbidden: open the URL Pi printed");

                return;
            }

            if (url.pathname === "/client-config") {
                reply(res, 200, JSON.stringify(options.clientConfig()), "application/json; charset=utf-8");

                return;
            }

            void serveStatic(res, url.pathname).catch((error: unknown) => {
                log("audio", "static serve failed", error);
            });
        } catch (error) {
            log("audio", "request handler error", error);
            reply(res, 400, "bad request");
        }
    });

    server.on("upgrade", (req, socket, head) => {
        // Same containment for the upgrade path: the URL parse can throw too.
        const url = safeUrl(req.url);

        if (!url || url.pathname !== "/ws") {
            note(`ws upgrade rejected: unexpected path ${url?.pathname ?? req.url ?? ""}`);
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();

            return;
        }

        if (url.searchParams.get("t") !== options.token) {
            note("ws upgrade rejected: token mismatch (stale page? reopen the printed URL)");
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();

            return;
        }

        const handlerRef: { current?: PeerHandler } = {};

        const peer = acceptWebSocket(req, socket, head, {
            onMessage: (data, isBinary) => handlerRef.current?.(data, isBinary),
            onClose: () => {
                peers.delete(peer);
                note(`page disconnected (${peers.size} connected)`);
            },
        });

        if (!peer) {
            return;
        }

        peers.add(peer);
        note(`page connected from ${peer.remote} (${peers.size} total)`);
        options.onPeer(peer, (handler) => {
            handlerRef.current = handler;
        });
    });

    const port = await listen(server, options.host, options.port);

    return {
        url: `http://${options.host}:${port}/?t=${options.token}`,
        port,
        token: options.token,
        get peerCount() {
            return peers.size;
        },
        close: () =>
            new Promise<void>((resolve) => {
                for (const peer of peers) {
                    try {
                        peer.close(1001, "shutdown");
                    } catch {
                        // ignore
                    }
                }

                peers.clear();
                server.close(() => resolve());
            }),
    };
}