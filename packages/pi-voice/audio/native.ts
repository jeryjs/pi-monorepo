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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceConfig } from "../config.ts";
import { log, warn, RingBuffer, float32ToPcm16 } from "../util.ts";
import { AcousticEchoCanceller, floatToInt16, resample24kTo16k } from "./aec.ts";
import { NativeKeywordSpotter } from "./kws.ts";
import { resolvedModelDir, sherpaStatus } from "../sherpa.ts";

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
    /** Workspace, used to resolve a project-local sherpa-onnx-node. */
    cwd?: string;
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
 *
 * The answer is cached on disk because the probe spawns ffmpeg and can take
 * seconds; doing that on every start made `/voice restart` feel hung.
 */
export function detectDefaultInput(ffmpegPath: string): string {
    if (process.platform !== "win32") {
        return process.platform === "darwin" ? ":0" : "default";
    }

    const cachePath = join(tmpdir(), "pi-voice-input-cache.txt");

    try {
        if (existsSync(cachePath)) {
            const cached = readFileSync(cachePath, "utf8").trim();

            if (cached) {
                return cached;
            }
        }
    } catch {
        // ignore a stale or unreadable cache
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
                const device = `audio=${match[1]}`;

                try {
                    writeFileSync(cachePath, device, "utf8");
                } catch {
                    // caching is best-effort
                }

                return device;
            }
        }
    } catch {
        // fall through to the default
    }

    return "";
}

/**
 * ffplay playback arguments.
 *
 * ffplay does NOT accept `-ac` (it is an ffmpeg-only option) and older builds
 * reject other AVOptions too, so a rejected option is retried with the minimal
 * set instead of silently producing no sound.
 */
export function playbackArgs(minimal = false): string[] {
    const options = minimal
        ? ["-nodisp", "-autoexit", "-f", "s16le", "-ar", "24000", "-"]
        : [
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
            "-",
        ];

    // Raw s16le is mono by default; do not pass a channels option.
    return ["-hide_banner", "-loglevel", "error", ...options];
}

const PLAYER_OPTION_ERROR = /option not found|failed to set|unknown option|unrecognized option/i;

/** Multiply raw int16 PCM by a gain, clamping at the 16-bit range. */
function scalePcm16(bytes: Uint8Array, gain: number): Uint8Array {
    if (!Number.isFinite(gain) || Math.abs(gain - 1) < 0.001) {
        return bytes;
    }

    const source = Buffer.isBuffer(bytes)
        ? bytes
        : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = Buffer.alloc(source.length);

    for (let i = 0; i + 1 < source.length; i += 2) {
        const value = Math.max(-32768, Math.min(32767, Math.round(source.readInt16LE(i) * gain)));
        out.writeInt16LE(value, i);
    }

    return out;
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
    #aec: AcousticEchoCanceller | undefined;
    #kws: NativeKeywordSpotter | undefined;
    #lastKeywordAt = 0;
    #noiseFloor = 0.012;
    #voicedMs = 0;
    #wakeNoteAt = 0;
    /** Multiplier over the room noise floor used by the energy wake fallback. */
    #wakeMultiplier = 2.2;
    #playerMinimal = false;
    #playerSpawnedAt = 0;
    #carry = Buffer.alloc(0);
    #captureAttempts = 0;
    #captureTimer: ReturnType<typeof setTimeout> | undefined;
    #halfDuplexVoicedMs = 0;

    /** Restart the capture process at most this many times before reporting failure. */
    static readonly CAPTURE_ATTEMPTS = 5;
    /** Drop queued playback beyond this many bytes (~2 s of 24 kHz mono). */
    static readonly MAX_PLAYBACK_BYTES = 24_000 * 2 * 2;

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

        if (config.nativeAec === "nlms") {
            this.#aec = new AcousticEchoCanceller();
            this.#log("native AEC: NLMS (full duplex)");
        }

        // The wake model falls back to the managed directory, so installing it
        // from `/voice` is enough — no config edit needed. `energy` still means
        // "never use a phrase spotter".
        const modelDir = resolvedModelDir(config.kwsModelDir);
        const wantsKws = config.wakeEngine !== "energy";

        // 0..1 sensitivity: at the default 0.5 this is the tuned 2.2x factor.
        const sensitivity = Number.isFinite(config.wakeSensitivity) ? Math.min(1, Math.max(0, config.wakeSensitivity)) : 0.5;
        this.#wakeMultiplier = 3.0 - sensitivity * 1.6;

        if (wantsKws) {
            this.#kws = await NativeKeywordSpotter.create({
                modelDir,
                keywords: config.kwsKeywords,
                provider: config.sherpaProvider,
                sensitivity,
                onWake: () => undefined,
                onLog: (message) => this.#log(message),
            }, this.options.cwd);

            if (!this.#kws) {
                const status = sherpaStatus(config.kwsModelDir);

                this.#log(
                    status.ready
                        ? "native wake: sherpa spotter failed to start, falling back to energy VAD"
                        : `native wake: ${status.detail}; falling back to energy VAD (run /voice sherpa to install it)`,
                );
            }
        }

        this.#spawnCapture();
        this.#started = true;
        this.#starting = false;
        this.#captureAttempts = 0;
        this.#halfDuplexVoicedMs = 0;
        this.#log("native audio started");
    }

    stop(): void {
        this.#started = false;

        if (this.#captureTimer) {
            clearTimeout(this.#captureTimer);
            this.#captureTimer = undefined;
        }

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
        this.#carry = Buffer.alloc(0);
        this.#captureAttempts = 0;
        this.#playingUntil = 0;
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

        // Output gain is applied once, here, so the AEC reference stays exact.
        const source = scalePcm16(bytes, this.options.config.outputGain);

        // Track the acoustic tail so half-duplex gating covers speaker ringing.
        this.#playingUntil = Date.now() + Math.round((source.length / 2 / 24_000) * 1000) + 250;

        // A stalled player must not build an unbounded buffer: better to drop audio
        // than to fall seconds behind the conversation.
        if (player.stdin.writableLength > NativeTransport.MAX_PLAYBACK_BYTES) {
            log("native", "playback backlog; dropping queued audio");
            this.flush();
        }

        const target = this.#player;

        if (!target || !target.stdin.writable) {
            return;
        }

        try {
            target.stdin.write(Buffer.from(source.buffer, source.byteOffset, source.byteLength));
        } catch (error) {
            log("native", "playback write failed", error);
        }

        if (this.#aec) {
            // Feed the known playback signal as the echo reference.
            const copy = Buffer.from(source);
            const int16 = new Int16Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 2));
            this.#aec.pushReference(resample24kTo16k(int16));
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

        const child = spawn(config.ffplayPath, playbackArgs(this.#playerMinimal), {
            stdio: ["pipe", "ignore", "pipe"],
            windowsHide: true,
        }) as ChildProcessWithoutNullStreams;

        this.#playerSpawnedAt = Date.now();

        child.on("error", (error) => this.#error(`ffplay: ${error.message}`));
        child.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString().trim();

            if (!text) {
                return;
            }

            log("native", "ffplay", text);

            // ffplay rejected one of our options: retry once with the bare set
            // (this is what makes playback work on builds without -fflags etc.).
            if (!this.#playerMinimal && PLAYER_OPTION_ERROR.test(text)) {
                this.#playerMinimal = true;
                this.#error(`ffplay rejected a playback option (${text}); retrying with a minimal argument set`);

                try {
                    child.kill();
                } catch {
                    // ignore
                }

                this.#player = undefined;
                this.#spawnPlayer();
            }
        });
        child.on("exit", (code) => {
            log("native", "ffplay exited", code);

            if (this.#player !== child) {
                return;
            }

            this.#player = undefined;

            // Only respawn if it had been healthy for a while: an immediate exit
            // means bad arguments or a missing audio device, and retrying would
            // just spin.
            if (this.#started && code !== 0 && Date.now() - this.#playerSpawnedAt > 1000) {
                setTimeout(() => {
                    if (this.#started && !this.#player) {
                        this.#spawnPlayer();
                    }
                }, 300);
            }
        });

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

            // ffmpeg chats on stderr (device probing, stream info). Only forward
            // lines that look like actual failures: routing every line through
            // warn() turned a healthy run into a wall of red.
            if (!text) {
                return;
            }

            if (/error|failed|invalid|no such|cannot|denied|busy|not found/i.test(text)) {
                this.#error(text);
            } else {
                log("native", "ffmpeg", text);
            }
        });
        child.on("error", (error) => this.#error(`ffmpeg: ${error.message}`));
        child.on("exit", (code) => this.#onCaptureExit(code));

        this.#capture = child;
    }

    /**
     * The microphone dying used to be a silent, permanent failure: the status bar
     * kept saying "live" while nothing was captured. Now it is surfaced and the
     * capture process is restarted a few times before giving up.
     */
    #onCaptureExit(code: number | null): void {
        this.#capture = undefined;
        this.#carry = Buffer.alloc(0);

        if (!this.#started) {
            return;
        }

        this.#captureAttempts++;

        if (this.#captureAttempts > NativeTransport.CAPTURE_ATTEMPTS) {
            this.#error(
                `ffmpeg capture stopped (exit ${code}) and could not be restarted after `
                + `${NativeTransport.CAPTURE_ATTEMPTS} attempts. Check the input device in /voice → Audio.`,
            );

            return;
        }

        const delay = Math.min(500 * 2 ** (this.#captureAttempts - 1), 8000);
        this.#log(`ffmpeg capture exited (${code}); restarting in ${delay} ms`);

        this.#captureTimer = setTimeout(() => {
            this.#captureTimer = undefined;

            if (this.#started && !this.#capture) {
                this.#spawnCapture();
            }
        }, delay);
        (this.#captureTimer as { unref?: () => void }).unref?.();
    }

    #onCapture(chunk: Buffer): void {
        // Capture is producing audio again: clear the restart counter.
        if (this.#captureAttempts > 0) {
            this.#captureAttempts = 0;
        }

        // Work in whole 20 ms frames (320 samples = 640 bytes at 16 kHz); a chunk
        // can split a frame, so carry the remainder into the next one instead of
        // dropping audio.
        const frameBytes = 640;
        const data = this.#carry.length > 0 ? Buffer.concat([this.#carry, chunk]) : chunk;
        const usable = data.length - (data.length % frameBytes);

        for (let offset = 0; offset < usable; offset += frameBytes) {
            this.#handleFrame(data.subarray(offset, offset + frameBytes));
        }

        this.#carry = usable < data.length ? Buffer.from(data.subarray(usable)) : Buffer.alloc(0);
    }

    #handleFrame(frame: Buffer): void {
        const samples = new Int16Array(frame.length / 2);

        for (let i = 0; i < samples.length; i++) {
            samples[i] = frame.readInt16LE(i * 2);
        }

        // Input gain is applied here, so the level meter shows what the model gets.
        const rawFloat = this.#toFloat(samples);
        let sum = 0;

        for (let i = 0; i < rawFloat.length; i++) {
            const value = rawFloat[i] as number;
            sum += value * value;
        }

        const rms = Math.sqrt(sum / Math.max(1, rawFloat.length));
        this.options.onLevel?.(rms);

        const bargeThreshold = 0.05;

        if (!this.#streaming) {
            // Sleep: keep a pre-roll and look for the wake phrase.
            this.#preRoll.push(rawFloat);

            if (this.#kws) {
                this.#kws.feed(rawFloat, (keyword) => this.#onKeyword(keyword));

                return;
            }

            // Energy wake with an adaptive noise floor, so a quiet mic still
            // wakes: a fixed threshold either misses soft speech or fires at
            // room tone.
            const threshold = Math.max(0.006, this.#noiseFloor * this.#wakeMultiplier);

            if (rms < threshold) {
                this.#noiseFloor = Math.max(0.002, this.#noiseFloor * 0.95 + rms * 0.05);
                this.#voicedMs = 0;
            } else {
                this.#voicedMs += 20;
            }

            if (Date.now() - this.#wakeNoteAt > 5000) {
                this.#wakeNoteAt = Date.now();
                this.#log(
                    `native wake: energy floor ${this.#noiseFloor.toFixed(4)} `
                    + `threshold ${threshold.toFixed(4)} level ${rms.toFixed(4)}`,
                );
            }

            if (this.#voicedMs >= 120 && Date.now() > this.#wakeCooldownUntil) {
                this.#wakeCooldownUntil = Date.now() + 1500;
                this.#voicedMs = 0;
                this.#emitWake("energy");
            }

            return;
        }

        // Half-duplex only when AEC is disabled; NLMS keeps full duplex so the
        // user can barge in without the model hearing itself. Any single loud
        // frame used to cut the model off — a cough or a door slam — so require
        // ~60 ms of speech first.
        if (this.options.config.nativeAec === "half-duplex" && this.playing) {
            if (rms < bargeThreshold) {
                this.#halfDuplexVoicedMs = 0;

                return;
            }

            this.#halfDuplexVoicedMs += 20;

            if (this.#halfDuplexVoicedMs < 60) {
                return;
            }

            this.#halfDuplexVoicedMs = 0;
            this.flush();
        }

        const outgoing = this.#cancel(rawFloat, frame);

        this.options.onMic(outgoing);
    }

    /**
     * Apply echo cancellation only while the model is actually speaking. With no
     * playback reference there is nothing to subtract, so passing the frame
     * through untouched keeps the mic signal exact and the CPU cost at zero
     * while the user talks.
     */
    #cancel(raw: Float32Array, frame: Buffer): Uint8Array {
        const aec = this.#aec;

        if (aec && this.playing) {
            return new Uint8Array(floatToInt16(aec.process(raw)).buffer);
        }

        // No AEC: send the gained signal. With gain 1 the original bytes are
        // forwarded untouched (no copy, no clipping).
        const gain = this.options.config.inputGain;

        if (Number.isFinite(gain) && Math.abs(gain - 1) >= 0.001) {
            return float32ToPcm16(raw);
        }

        return new Uint8Array(frame);
    }

    #onKeyword(keyword: string): void {
        if (this.#streaming) {
            return;
        }

        const now = Date.now();

        if (now - this.#lastKeywordAt < 1200) {
            return;
        }

        this.#lastKeywordAt = now;
        this.#emitWake(`sherpa:${keyword}`);
    }

    /** Replay the phrase (and a little before it) so the model hears the request. */
    #emitWake(source: string): void {
        const pre = this.#preRoll.tail(16_000 * 0.5);
        this.#preRoll.clear();
        this.options.onWake(source);

        if (pre.length > 0) {
            const aec = this.#aec;
            const outgoing = aec && this.playing ? aec.process(pre) : pre;
            this.options.onMic(float32ToPcm16(outgoing));
        }
    }

    #toFloat(samples: Int16Array): Float32Array {
        const gain = this.options.config.inputGain;
        const scale = Number.isFinite(gain) && gain > 0 ? gain : 1;
        const out = new Float32Array(samples.length);

        for (let i = 0; i < samples.length; i++) {
            const value = ((samples[i] as number) / 32768) * scale;
            out[i] = value > 1 ? 1 : value < -1 ? -1 : value;
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