/**
 * Key/model diagnosis: opens a real Live socket per model and reports whether
 * the server accepts the setup. This is the check that distinguishes
 * "bad key" from "model needs a setting" from "quota/billing refused".
 */

import { capabilitiesFor, type ModelCapabilities } from "./capabilities.ts";
import { liveSocketUrl } from "./live/protocol.ts";

export interface ProbeResult {
    model: string;
    ok: boolean;
    detail: string;
    ms: number;
}

interface WebSocketLike {
    binaryType?: string;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: string, listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void;
}

function openSocket(url: string): WebSocketLike | undefined {
    const Ctor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;

    if (!Ctor) {
        return undefined;
    }

    const socket = new Ctor(url);
    socket.binaryType = "arraybuffer";

    return socket;
}

function textOf(data: unknown): string {
    if (typeof data === "string") {
        return data;
    }

    if (data instanceof ArrayBuffer) {
        return Buffer.from(data).toString("utf8");
    }

    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    }

    return "";
}

export interface ProbeOptions {
    thinkingLevel?: string;
    timeoutMs?: number;
    /** Build the exact setup the extension would send (defaults to a minimal one). */
    buildSetup?: (capabilities: ModelCapabilities) => Record<string, unknown>;
}

export function probeLiveModel(apiKey: string, model: string, options: ProbeOptions = {}): Promise<ProbeResult> {
    const started = Date.now();
    const capabilities = capabilitiesFor(model);
    const timeoutMs = options.timeoutMs ?? 10_000;
    const socket = openSocket(liveSocketUrl(apiKey));

    if (!socket) {
        return Promise.resolve({ model, ok: false, detail: "global WebSocket unavailable", ms: 0 });
    }

    return new Promise<ProbeResult>((resolve) => {
        let settled = false;

        const finish = (ok: boolean, detail: string): void => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);

            try {
                socket.close(1000, "probe");
            } catch {
                // ignore
            }

            resolve({ model, ok, detail: detail.replace(/\s+/g, " ").trim().slice(0, 220), ms: Date.now() - started });
        };

        const timer = setTimeout(() => finish(false, `timeout after ${timeoutMs}ms`), timeoutMs);

        socket.addEventListener("open", () => {
            let setup: Record<string, unknown>;

            if (options.buildSetup) {
                setup = options.buildSetup(capabilities);
            } else {
                const generationConfig: Record<string, unknown> = { responseModalities: ["AUDIO"] };
                const level = options.thinkingLevel || (capabilities.thinkingRequired ? "low" : "");

                if (capabilities.thinking === "level" && level) {
                    generationConfig.thinkingConfig = { thinkingLevel: level };
                }

                setup = { model: "models/" + capabilities.id, generationConfig };
            }

            socket.send(JSON.stringify({ setup }));
        });

        socket.addEventListener("message", (event) => {
            const text = textOf(event.data);

            if (text.includes("setupComplete")) {
                finish(true, "setupComplete");
            } else if (text.includes("\"error\"")) {
                finish(false, text);
            }
        });

        socket.addEventListener("close", (event) => {
            finish(false, `close ${event.code ?? "?"}: ${event.reason ?? ""}`.trim());
        });
    });
}

export async function diagnoseLive(apiKey: string, models: string[], options: ProbeOptions = {}): Promise<ProbeResult[]> {
    const results: ProbeResult[] = [];

    for (const model of models) {
        results.push(await probeLiveModel(apiKey, model, options));
    }

    return results;
}