/**
 * Small shared helpers for pi-voice. No dependencies, no I/O beyond logging.
 */

export type Unsubscribe = () => void;

/** Minimal typed event emitter used across the voice stack. */
export class Emitter<Events extends object> {
    readonly #handlers = new Map<keyof Events, Set<(payload: never) => void>>();

    on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): Unsubscribe {
        let set = this.#handlers.get(event);

        if (!set) {
            set = new Set();
            this.#handlers.set(event, set);
        }

        set.add(handler as (payload: never) => void);

        return () => {
            set?.delete(handler as (payload: never) => void);
        };
    }

    emit<K extends keyof Events>(event: K, payload: Events[K]): void {
        const set = this.#handlers.get(event);

        if (!set) {
            return;
        }

        for (const handler of [...set]) {
            try {
                (handler as (value: Events[K]) => void)(payload);
            } catch (error) {
                log("emitter", "handler for " + String(event) + " threw", error);
            }
        }
    }

    clear(): void {
        this.#handlers.clear();
    }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with jitter, capped. */
export function backoffDelay(attempt: number, baseMs = 400, maxMs = 20_000): number {
    const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
    return Math.round(raw * (0.5 + Math.random() * 0.5));
}

/**
 * Is debug on, from the environment?
 *
 * `Boolean(process.env.X)` made `PI_VOICE_DEBUG=false` (and `0`, `off`, `no`)
 * *enable* verbose logging — which is how these lines leaked into the editor with
 * the setting visibly off.
 */
function envDebug(): boolean {
    const raw = (typeof process !== "undefined" ? process.env.PI_VOICE_DEBUG : undefined)?.trim().toLowerCase();

    if (!raw) {
        return false;
    }

    return !["0", "false", "off", "no", "none"].includes(raw);
}

let debugEnabled = envDebug();
let debugSource: "config" | "env" = "env";

export function setDebug(enabled: boolean): void {
    debugEnabled = enabled;
    debugSource = "config";
}

export function isDebug(): boolean {
    return debugEnabled;
}

/** Where the current debug state came from, for `/voice status`. */
export function debugState(): { enabled: boolean; source: "config" | "env" } {
    return { enabled: debugEnabled, source: debugSource };
}

/**
 * The last few warnings, kept even with debug off.
 *
 * Warnings used to go straight to stderr, which put red lines in the middle of the
 * editor during normal use. They still matter, so they are recorded and shown by
 * `/voice status` — silent unless you ask, never lost.
 */
const WARNING_LIMIT = 12;
const warnings: { at: number; scope: string; text: string }[] = [];

export function recentWarnings(limit = 3): { at: number; scope: string; text: string }[] {
    return warnings.slice(-Math.max(1, limit));
}

export function clearWarnings(): void {
    warnings.length = 0;
}

function describe(args: unknown[]): string {
    return args
        .map((value) => {
            if (typeof value === "string") {
                return value;
            }

            if (value instanceof Error) {
                return value.message;
            }

            try {
                return JSON.stringify(value);
            } catch {
                return String(value);
            }
        })
        .join(" ");
}

/** Log to the Pi process' stderr; silent unless PI_VOICE_DEBUG / debug config is on. */
export function log(scope: string, ...args: unknown[]): void {
    if (!debugEnabled) {
        return;
    }

    try {
        console.error("[pi-voice:" + scope + "]", ...args);
    } catch {
        // ignore
    }
}

/**
 * Report a real failure. Kept in memory (see `recentWarnings`) and printed only
 * with debug on: stderr output in normal use was the "leaking into the editor"
 * complaint, and every one of these also reaches the user through the status bar,
 * a notice, or `/voice status`.
 */
export function warn(scope: string, ...args: unknown[]): void {
    warnings.push({ at: Date.now(), scope, text: describe(args) });

    if (warnings.length > WARNING_LIMIT) {
        warnings.splice(0, warnings.length - WARNING_LIMIT);
    }

    if (!debugEnabled) {
        return;
    }

    try {
        console.error("[pi-voice:" + scope + "]", ...args);
    } catch {
        // ignore
    }
}

/** Collapse whitespace and clip for compact prompts/digests. */
export function clip(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();

    return flat.length <= max ? flat : flat.slice(0, Math.max(0, max - 1)) + "\u2026";
}

/** Human-friendly duration. */
export function humanDuration(ms: number): string {
    if (ms < 1000) {
        return Math.round(ms) + "ms";
    }

    if (ms < 60_000) {
        return (ms / 1000).toFixed(1) + "s";
    }

    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);

    return minutes + "m" + String(seconds).padStart(2, "0") + "s";
}

/** A tiny ring buffer of float32 mono samples, used for mic pre-roll. */
export class RingBuffer {
    readonly capacity: number;
    #data: Float32Array;
    #write = 0;
    #length = 0;

    constructor(capacity: number) {
        this.capacity = capacity;
        this.#data = new Float32Array(capacity);
    }

    push(samples: Float32Array): void {
        for (let i = 0; i < samples.length; i++) {
            this.#data[this.#write] = samples[i] as number;
            this.#write = (this.#write + 1) % this.capacity;

            if (this.#length < this.capacity) {
                this.#length++;
            }
        }
    }

    clear(): void {
        this.#write = 0;
        this.#length = 0;
    }

    /** Most recent `count` samples, oldest first. */
    tail(count: number): Float32Array {
        const take = Math.min(count, this.#length);
        const out = new Float32Array(take);
        const start = (this.#write - take + this.capacity) % this.capacity;

        for (let i = 0; i < take; i++) {
            out[i] = this.#data[(start + i) % this.capacity] as number;
        }

        return out;
    }
}

/** int16LE mono bytes from float32 [-1,1] samples. */
export function float32ToPcm16(samples: Float32Array): Uint8Array {
    const out = new Uint8Array(samples.length * 2);
    const view = new DataView(out.buffer);

    for (let i = 0; i < samples.length; i++) {
        const clamped = Math.max(-1, Math.min(1, samples[i] as number));
        view.setInt16(i * 2, Math.round(clamped * 32767), true);
    }

    return out;
}
