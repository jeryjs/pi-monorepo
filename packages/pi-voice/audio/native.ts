/**
 * Native (headless) audio transport: no browser, no tab.
 *
 *   capture : ffmpeg reading the default input device -> 16 kHz s16le on stdout
 *   playback: ffplay reading 24 kHz s16le on stdin
 *   echo    : half-duplex gating (mic upstream is muted while the model speaks,
 *             with a barge-in energy threshold) — weaker than WebRTC AEC3, which
 *             is why the browser transport is the default.
 *
 * External dependency: ffmpeg/ffplay on PATH (or configured paths). Everything
 * else is Node built-ins.
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { VoiceConfig } from "../config.ts";
import { log, warn, RingBuffer, float32ToPcm16 } from "../util.ts";

export interface NativeTransportEvents {
    /** 16 kHz s16le microphone bytes, already gated. */
    mic: Uint8Array;
    /** Wake phrase / speech onset detected while sleeping. */
    wake: { source: string };
    level: number;
    log: string;
    error: string;
}

export interface NativeTransportOptions {
    config: VoiceConfig;
    onMic: (bytes: Uint8Array) => void;
    onWake: (source: string) => void;
    onLevel?: (value: number) => void;
    onLog?: (message: string) => void;
    onError?: (message: string) => void;
}

function hasBinary(command: string): boolean {
    try {
        const result = spawnSync(command, ["-version"], { stdio: "ignore", timeout: 5000, windowsHide: true });

        return result.status === 0;
    } catch {
        return false;
    }
}

function captureArgs(config: VoiceConfig, input: string): string[] {
    const device = input.trim();

    if (process.platform === "win32") {
        return ["-f", "dshow", "-i", device || "audio=default"];
    }

    if (process.platform === "darwin") {
        return ["-f", "avfoundation", "-i", device || ":0"];
    }

    return ["-f", "pulse", "-i", device || "default"];
}

/**
 * Pick a capture device automatically so native works without configuration.
 * On Windows, ffmpeg's dshow backend needs an exact device name, so ask it.
 */
export function detectDefaultInput(ffmpegPath: string): string {
    if (process.platform !== "win32") {
        return process.platform === "darwin" ? ":0" : "default";
    }

    try {
        const result = spawnSync(
            ffmpegPath,
            ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
            { encoding: "utf8", timeout: 8000, windowsHide: true },
        );
        const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;

        for (const line of text.split(/\r?\n/)) {
            const match = /"([^"]+)"\s+\(audio\)/.exec(line);

            if (match?.[1]) {
                return `audio=${match[1]}`;
            }
        }
    } catch {
        // fall through to the default
    }

    return "";
}

function playbackArgs(): string[] {
    return [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nodisp",
        "-autoexit",
        "-fflags",
        "nobuffer",
        "-flags",
        "low_delay",
        "-f",
        "s16le",
        "-ar",
        "24000",
        "-ac",
        "1",
        "-",
    ];
}

export class NativeTransport {
    #capture: ChildProcessWithoutNullStreams | undefined;
    #player: ChildProcessWithoutNullStreams | undefined;
    #streaming = true;
    #playingUntil = 0;
    #preRoll = new RingBuffer(16_000 * 0.6); // ~600 ms at 16 kHz
    #wakeCooldownUntil = 0;
    #starting = false;
    #started = false;
    #input = "";

    readonly #options: NativeTransportOptions;

    constructor(options: NativeTransportOptions) {
        this.#options = options;
    }

    private get options(): NativeTransportOptions {
        return this.#options;
    }

    get started(): boolean {
        return this.#started;
    }

    get playing(): boolean {
        return Date.now() < this.#playingUntil;
    }

    static available(config: VoiceConfig): boolean {
        return hasBinary(config.ffmpegPath) && hasBinary(config.ffplayPath);
    }

    static describeMissing(config: VoiceConfig): string[] {
        const missing: string[] = [];

        if (!hasBinary(config.ffmpegPath)) {
            missing.push(config.ffmpegPath);
        }

        if (!hasBinary(config.ffplayPath)) {
            missing.push(config.ffplayPath);
        }

        return missing;
    }

    async start(): Promise<void> {
        if (this.#started || this.#starting) {
            return;
        }

        this.#starting = true;

        const { config } = this.options;

        if (!hasBinary(config.ffmpegPath)) {
            this.#starting = false;
            throw new Error(
                `ffmpeg not found (${config.ffmpegPath}). Install ffmpeg or set ffmpegPath in pi-voice.json, `
                + "or use the browser transport.",
            );
        }

        if (!hasBinary(config.ffplayPath)) {
            this.#starting = false;
            throw new Error(
                `ffplay not found (${config.ffplayPath}). Install ffmpeg (which includes ffplay) or set ffplayPath.`,
            );
        }

        this.#spawnPlayer();
        this.#input = config.nativeInput.trim() || detectDefaultInput(config.ffmpegPath);
        this.#log(`native input device: ${this.#input || "none detected"}`);
        this.#spawnCapture();
        this.#started = true;
        this.#starting = false;
        this.#log("native audio started");
    }

    stop(): void {
        this.#started = false;

        for (const child of [this.#capture, this.#player]) {
            if (!child) {
                continue;
            }

            try {
                child.kill();
            } catch {
                // ignore
            }
        }

        this.#capture = undefined;
        this.#player = undefined;
    }

    setStreaming(streaming: boolean): void {
        this.#streaming = streaming;

        if (!streaming) {
            this.#preRoll.clear();
        }
    }

    /** Queue 24 kHz s16le model audio for the speakers. */
    play(bytes: Uint8Array): void {
        const player = this.#player;

        if (!player || !player.stdin.writable) {
            return;
        }

        // Track the acoustic tail so half-duplex gating covers speaker ringing.
        this.#playingUntil = Date.now() + Math.round((bytes.length / 2 / 24_000) * 1000) + 250;

        try {
            player.stdin.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        } catch (error) {
            log("native", "playback write failed", error);
        }
    }

    /** Drop queued playback (barge-in): ffplay has no flush, so respawn it. */
    flush(): void {
        if (!this.#started) {
            return;
        }

        try {
            this.#player?.kill();
        } catch {
            // ignore
        }

        this.#player = undefined;
        this.#playingUntil = 0;
        this.#spawnPlayer();
    }

    // -----------------------------------------------------------------------

    #spawnPlayer(): void {
        const { config } = this.options;

        const child = spawn(config.ffplayPath, playbackArgs(), {
            stdio: ["pipe", "ignore", "pipe"],
            windowsHide: true,
        }) as ChildProcessWithoutNullStreams;

        child.on("error", (error) => this.#error(`ffplay: ${error.message}`));
        child.stderr?.on("data", (chunk: Buffer) => log("native", "ffplay", chunk.toString().trim()));
        child.on("exit", (code) => log("native", "ffplay exited", code));

        this.#player = child;
    }

    #spawnCapture(): void {
        const { config } = this.options;
        const args = [
            "-hide_banner",
            "-loglevel",
            "error",
            ...captureArgs(config, this.#input),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "s16le",
            "-",
        ];

        const child = spawn(config.ffmpegPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        }) as ChildProcessWithoutNullStreams;

        child.stdout.on("data", (chunk: Buffer) => this.#onCapture(chunk));
        child.stderr.on("data", (chunk: Buffer) => {
            const text = chunk.toString().trim();

            if (text) {
                log("native", "ffmpeg", text);
                this.#error(text);
            }
        });
        child.on("error", (error) => this.#error(`ffmpeg: ${error.message}`));
        child.on("exit", (code) => log("native", "ffmpeg exited", code));

        this.#capture = child;
    }

    #onCapture(chunk: Buffer): void {
        // Work in whole 20 ms frames (320 samples = 640 bytes at 16 kHz).
        const frameBytes = 640;

        for (let offset = 0; offset + frameBytes <= chunk.length; offset += frameBytes) {
            const frame = chunk.subarray(offset, offset + frameBytes);
            this.#handleFrame(frame);
        }
    }

    #handleFrame(frame: Buffer): void {
        const samples = new Int16Array(frame.length / 2);

        for (let i = 0; i < samples.length; i++) {
            samples[i] = frame.readInt16LE(i * 2);
        }

        let sum = 0;

        for (let i = 0; i < samples.length; i++) {
            const value = (samples[i] as number) / 32768;
            sum += value * value;
        }

        const rms = Math.sqrt(sum / samples.length);
        this.options.onLevel?.(rms);

        const bargeThreshold = 0.05;

        if (!this.#streaming) {
            // Sleep: keep a pre-roll and look for speech onset.
            this.#preRoll.push(this.#toFloat(samples));

            if (rms > bargeThreshold && Date.now() > this.#wakeCooldownUntil) {
                this.#wakeCooldownUntil = Date.now() + 1500;

                // Hand the phrase (and a little before it) to the session so the
                // wake words are not lost from the request.
                const pre = this.#preRoll.tail(16_000 * 0.5);
                this.#preRoll.clear();
                this.options.onWake("energy");

                if (pre.length > 0) {
                    this.options.onMic(float32ToPcm16(pre));
                }
            }

            return;
        }

        // Half-duplex: while the model is speaking, only a clear barge-in gets through.
        if (this.options.config.nativeAec === "half-duplex" && this.playing) {
            if (rms < bargeThreshold) {
                return;
            }

            this.flush();
        }

        this.options.onMic(new Uint8Array(frame));
    }

    #toFloat(samples: Int16Array): Float32Array {
        const out = new Float32Array(samples.length);

        for (let i = 0; i < samples.length; i++) {
            out[i] = (samples[i] as number) / 32768;
        }

        return out;
    }

    #log(message: string): void {
        log("native", message);
        this.options.onLog?.(message);
    }

    #error(message: string): void {
        warn("native", message);
        this.options.onError?.(message);
    }
}