/**
 * The audio transport: ffmpeg in, ffplay out. No tab, no page, no loopback server.
 *
 *   capture : ffmpeg reading the input device -> 16 kHz s16le on stdout
 *   playback: ffplay reading 24 kHz s16le on stdin
 *   echo    : NLMS adaptive canceller (full duplex), half-duplex gating, or off
 *   wake    : ASR phrase match → keyword spotter → energy VAD
 *
 * External dependency: ffmpeg/ffplay on PATH (or configured paths). Everything
 * else is Node built-ins.
 */

import { spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceConfig } from "../config.ts";
import { log, warn, RingBuffer, float32ToPcm16 } from "../util.ts";
import { AcousticEchoCanceller, floatToInt16, resample24kTo16k } from "./aec.ts";
import { killTree, spawnManaged } from "./process.ts";
import { NativeAsrWakeSpotter } from "./asr-wake.ts";
import { NativeKeywordSpotter } from "./kws.ts";
import { asrModelStatus, resolvedAsrModelDir, resolvedModelDir, sherpaStatus } from "../sherpa.ts";

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

/**
 * Which wake engine is really running, as opposed to what the config asks for.
 * `provider` is what the runtime reports (`cpu`, `directml`, ...).
 */
export interface WakeEngineStatus {
    kind: "asr" | "sherpa";
    provider: string;
}

/**
 * What VoiceController needs from an audio sink.
 *
 * NativeTransport is the product implementation; the interface exists so the
 * lifecycle harness can run the real controller, sockets, tools and locks without
 * a microphone or ffmpeg on the machine.
 */
export interface AudioSink {
    start(): Promise<void>;
    /** Resolves once capture and playback are really gone (the device is released). */
    stop(): void | Promise<void>;
    play(bytes: Uint8Array): void;
    flush(): void;
    setStreaming(streaming: boolean): void;
    /** Epoch ms until which playback is still audible (queued frames + speaker tail). */
    readonly playingUntil: number;
    /** Wake engine that actually started; undefined = energy VAD. */
    readonly wakeEngine: WakeEngineStatus | undefined;
}

export function gainToFloat(samples: Int16Array, gain: number): Float32Array {
    // Zero is a real setting (mute), not a missing one: `gain > 0 ? gain : 1` silently
    // applied unity gain, so a user who muted the microphone was still heard — and
    // still woke the wake-word engine.
    const scale = Number.isFinite(gain) && gain >= 0 ? gain : 1;
    const out = new Float32Array(samples.length);

    for (let i = 0; i < samples.length; i++) {
        const value = ((samples[i] as number) / 32768) * scale;
        out[i] = value > 1 ? 1 : value < -1 ? -1 : value;
    }

    return out;
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

// ---------------------------------------------------------------------------
// Microphone probe: answers "is the mic giving us anything at all?" in one shot
// ---------------------------------------------------------------------------

export interface MicProbe {
    device: string;
    seconds: number;
    samples: number;
    /** Absolute peak amplitude, 0..1. */
    peak: number;
    /** RMS over the whole window, 0..1. */
    rms: number;
    /** Fraction of 100 ms windows whose RMS is above the wake threshold. */
    voicedRatio: number;
    error?: string;
}

/** One-line diagnosis of a probe; pure so it can be tested without a microphone. */
export function micVerdict(probe: MicProbe): string {
    if (probe.error) {
        return `could not capture: ${probe.error}`;
    }

    if (probe.samples === 0) {
        return "no audio arrived at all — ffmpeg opened the device but produced nothing";
    }

    const db = (value: number): string => (value <= 0 ? "-inf" : (20 * Math.log10(value)).toFixed(1));

    if (probe.peak < 0.0005) {
        return "DIGITAL SILENCE: the device is delivering zeros. Windows: Settings → Sound → Input → "
            + "check mute, volume, and Privacy → Microphone → allow desktop apps. Also check that "
            + "nativeInput is the mic and not Stereo Mix / a disconnected endpoint.";
    }

    if (probe.voicedRatio === 0) {
        return `signal present but very quiet (peak ${db(probe.peak)} dBFS): speech never reached the wake `
            + "threshold — raise the mic gain or wakeSensitivity";
    }

    return `signal present (peak ${db(probe.peak)} dBFS, rms ${db(probe.rms)} dBFS, `
        + `${Math.round(probe.voicedRatio * 100)}% of the window above the wake threshold)`;
}

/**
 * Record a few seconds from the configured input and measure it. Used by
 * `/voice mic` so "the wake word never fires" can be split into "the mic is silent"
 * (device/privacy problem) versus "the mic works, the detector does not fire"
 * (model/keyword/threshold problem) without reading logs.
 */
export async function probeMic(config: VoiceConfig, seconds = 3): Promise<MicProbe> {
    const device = config.nativeInput.trim() || detectDefaultInput(config.ffmpegPath);
    const result: MicProbe = { device, seconds, samples: 0, peak: 0, rms: 0, voicedRatio: 0 };
    const args = [
        "-hide_banner",
        "-loglevel",
        "error",
        ...captureArgs(config, device),
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "-",
    ];

    return new Promise<MicProbe>((resolve) => {
        let child: ChildProcessWithoutNullStreams;

        try {
            child = spawnManaged(config.ffmpegPath, args, {
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            }) as ChildProcessWithoutNullStreams;
        } catch (error) {
            resolve({ ...result, error: String(error) });

            return;
        }

        const window = 1600; // 100 ms at 16 kHz
        let windowSum = 0;
        let windowCount = 0;
        let voicedWindows = 0;
        let windows = 0;
        let sumSquares = 0;
        let settled = false;
        let carry = Buffer.alloc(0);
        let stderr = "";

        const finish = (error?: string): void => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            killTree(child);

            if (windows > 0) {
                result.voicedRatio = voicedWindows / windows;
            }

            if (result.samples > 0) {
                result.rms = Math.sqrt(sumSquares / result.samples);
            }

            resolve({
                ...result,
                error: error ?? (result.samples === 0 ? cleanStderr(stderr) : undefined),
            });
        };

        const timer = setTimeout(() => finish(), seconds * 1000 + 1500);
        (timer as { unref?: () => void }).unref?.();

        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.stdout.on("data", (chunk: Buffer) => {
            carry = Buffer.concat([carry, chunk]);
            const usable = carry.length - (carry.length % 2);

            for (let offset = 0; offset + 1 < usable; offset += 2) {
                const sample = carry.readInt16LE(offset) / 32768;
                const magnitude = Math.abs(sample);

                if (magnitude > result.peak) {
                    result.peak = magnitude;
                }

                sumSquares += sample * sample;
                result.samples++;
                windowSum += sample * sample;
                windowCount++;

                if (windowCount >= window) {
                    const rms = Math.sqrt(windowSum / windowCount);

                    if (rms > 0.006) {
                        voicedWindows++;
                    }

                    windows++;
                    windowSum = 0;
                    windowCount = 0;
                }
            }

            carry = Buffer.from(carry.subarray(usable));

            if (result.samples >= 16_000 * seconds) {
                finish();
            }
        });

        child.on("error", (error: Error) => finish(error.message));
        child.on("close", () => finish());
    });
}

function cleanStderr(text: string): string {
    const line = text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).pop();

    return line ? line.slice(0, 200) : "no audio captured";
}

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

export class NativeTransport implements AudioSink {
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
    #asr: NativeAsrWakeSpotter | undefined;
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

    /**
     * How long the wake detectors stay off after the mic is muted.
     *
     * The words that triggered the sleep ("stop listening") are still in the decoder,
     * and the model's goodbye is still coming out of the speakers: waking on either is
     * the "asleep for a second, then live again" bug.
     */
    static readonly SLEEP_SETTLE_MS = 900;

    /** When the current capture process was spawned (health window for retries). */
    #captureSpawnedAt = 0;

    /** Which engine actually got constructed (nothing = energy VAD). */
    get wakeEngine(): WakeEngineStatus | undefined {
        if (this.#asr) {
            return { kind: "asr", provider: this.#asr.provider };
        }

        return this.#kws ? { kind: "sherpa", provider: this.#kws.provider } : undefined;
    }
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

    /**
     * Timestamp until which the speakers are still busy (queued frames plus the
     * acoustic tail). The controller uses it to know whether a notice would land on
     * top of a sentence that has already stopped generating but is still audible.
     */
    get playingUntil(): number {
        return this.#playingUntil;
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
                `ffmpeg not found (${config.ffmpegPath}). Install ffmpeg or set ffmpegPath in pi-voice.json.`,
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
        // "never use a phrase recognizer".
        const modelDir = resolvedModelDir(config.kwsModelDir);

        // Which recognizer runs. `auto` prefers the ASR when its model is present:
        // it is the one that works on voices the 3.3M keyword spotter cannot hear.
        const asrDir = resolvedAsrModelDir(config.asrModelDir);
        const asrReady = asrModelStatus(asrDir).ok;
        const wantsAsr = config.wakeEngine === "asr" || (config.wakeEngine === "auto" && asrReady);
        const wantsKws = !wantsAsr && config.wakeEngine !== "energy";

        // 0..1 sensitivity: at the default 0.5 this is the tuned 2.2x factor.
        const sensitivity = Number.isFinite(config.wakeSensitivity) ? Math.min(1, Math.max(0, config.wakeSensitivity)) : 0.5;
        this.#wakeMultiplier = 3.0 - sensitivity * 1.6;

        if (wantsAsr) {
            this.#asr = await NativeAsrWakeSpotter.create({
                modelDir: asrDir,
                phrases: config.wakePhrases,
                provider: config.sherpaProvider,
                onLog: (message) => this.#log(message),
                onError: (message) => this.#error(message),
            });

            if (!this.#asr) {
                this.#log("native wake: ASR recognizer failed to start, falling back to energy VAD");
            }
        }

        if (wantsKws) {
            this.#kws = await NativeKeywordSpotter.create({
                modelDir,
                keywords: config.kwsKeywords,
                provider: config.sherpaProvider,
                sensitivity,
                onWake: () => undefined,
                onLog: (message) => this.#log(message),
                onError: (message) => this.#error(message),
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

    /**
     * Stop capture and playback and *wait* for both children to exit.
     *
     * The wait matters on Windows: `/voice restart` (and any settings change that
     * rebuilds the transport) used to spawn the new ffmpeg while the old one still
     * held the dshow device, and the replacement died with "device busy".
     */
    async stop(): Promise<void> {
        this.#started = false;

        if (this.#captureTimer) {
            clearTimeout(this.#captureTimer);
            this.#captureTimer = undefined;
        }

        const children = [this.#capture, this.#player].filter((child): child is ChildProcessWithoutNullStreams => Boolean(child));

        this.#capture = undefined;
        this.#player = undefined;
        this.#carry = Buffer.alloc(0);
        this.#captureAttempts = 0;
        this.#playingUntil = 0;

        await Promise.all(children.map((child) => NativeTransport.#killAndWait(child)));
    }

    /** SIGTERM, then SIGKILL after a grace period; resolves once the child is gone. */
    static #killAndWait(child: ChildProcessWithoutNullStreams, graceMs = 1500): Promise<void> {
        return new Promise<void>((resolve) => {
            let settled = false;

            const finish = (): void => {
                if (settled) {
                    return;
                }

                settled = true;
                clearTimeout(timer);
                resolve();
            };

            const timer = setTimeout(() => {
                // The child is still up after the grace period: take the whole tree,
                // the real ffmpeg/ffplay included (see audio/process.ts).
                killTree(child);

                // Do not hang the caller on a process the OS refuses to reap.
                setTimeout(finish, 500).unref?.();
            }, graceMs);
            (timer as { unref?: () => void }).unref?.();

            // Already reaped before stop() ran: its "close" fired into an earlier
            // listener, so waiting the grace period here would stall every restart.
            if (child.exitCode !== null || child.signalCode !== null) {
                finish();

                return;
            }

            child.once("close", finish);
            child.once("error", finish);

            // Tree first, then the child itself: killing the shim alone used to
            // orphan the real binary with the microphone still open. SIGTERM gives
            // ffmpeg a chance to release the dshow device cleanly.
            killTree(child, "SIGTERM");

            try {
                child.kill();
            } catch {
                finish();
            }
        });
    }

    setStreaming(streaming: boolean): void {
        this.#streaming = streaming;

        if (!streaming) {
            this.#preRoll.clear();
            // Drop a partial energy count and hold both detectors off while the sentence
            // that asked for the sleep, and the goodbye that follows it, are still in the
            // air. Without this the next frame re-wakes the session it just put to sleep.
            this.#voicedMs = 0;
            this.#wakeCooldownUntil = Date.now() + NativeTransport.SLEEP_SETTLE_MS;
        }
    }

    /** Queue 24 kHz s16le model audio for the speakers. */
    play(bytes: Uint8Array): void {
        const first = this.#player;

        if (!first || !first.stdin.writable) {
            return;
        }

        // Output gain is applied once, here, so the AEC reference stays exact.
        const source = scalePcm16(bytes, this.options.config.outputGain);

        // A stalled player must not build an unbounded buffer: better to drop audio
        // than to fall seconds behind the conversation.
        if (first.stdin.writableLength > NativeTransport.MAX_PLAYBACK_BYTES) {
            log("native", "playback backlog; dropping queued audio");
            this.flush();
        }

        const target = this.#player;

        if (!target || !target.stdin.writable) {
            return;
        }

        // Audible until everything already queued plus this chunk has played, plus a
        // speaker tail. Counting only this chunk made `playing` false while a backlog
        // was still audible, which skipped AEC and disabled half-duplex right when the
        // model was talking loudest.
        const queuedMs = Math.round((target.stdin.writableLength / 2 / 24_000) * 1000);
        const chunkMs = Math.round((source.length / 2 / 24_000) * 1000);

        this.#playingUntil = Date.now() + queuedMs + chunkMs + 250;

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

        // Barge-in: the respawn must not happen when the transport is stopping, and
        // the old child must be forgotten so its exit handler cannot double-spawn.
        if (this.#player) {
            const previous = this.#player;

            this.#player = undefined;
            killTree(previous);
        }

        this.#playingUntil = 0;
        this.#spawnPlayer();
    }

    // -----------------------------------------------------------------------

    #spawnPlayer(): void {
        const { config } = this.options;

        const child = spawnManaged(config.ffplayPath, playbackArgs(this.#playerMinimal), {
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

                // Only retry if this is still the live player: a stale stderr line
                // used to spawn a second ffplay and orphan the one we were tracking.
                if (this.#player === child && this.#started) {
                    this.#player = undefined;
                    killTree(child);
                    this.#spawnPlayer();
                }
            }
        });
        child.on("exit", (code) => {
            log("native", "ffplay exited", code);

            if (this.#player !== child) {
                return;
            }

            this.#player = undefined;

            // Respawn whenever it was healthy for a while. Requiring a non-zero exit
            // meant a clean exit (a device disappearing, a pipe closed by the OS) left
            // the session with no player at all: play() returned early forever, so the
            // model went silent with no error anywhere.
            if (this.#started && Date.now() - this.#playerSpawnedAt > 1000) {
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

        const child = spawnManaged(config.ffmpegPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        }) as ChildProcessWithoutNullStreams;

        this.#captureSpawnedAt = Date.now();
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
        child.on("error", (error) => {
            this.#error(`ffmpeg: ${error.message}`);

            // A spawn failure emits `error` and `close`, never `exit`: without this the
            // capture process was simply gone and nothing restarted it.
            if (!this.#captureTimer) {
                this.#onCaptureExit(null);
            }
        });
        child.on("exit", (code) => {
            // A shim can exit while the binary it launched is still holding the
            // device; make sure the tree is gone before the restart attempt so it
            // does not fail with "device busy".
            killTree(child);
            this.#onCaptureExit(code);
        });

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
        // Capture is producing audio again: clear the restart counter, but only once
        // the process has proved it is healthy. Resetting on the first chunk let a
        // device that opened, emitted one frame and died restart forever: each exit
        // incremented the counter and the next chunk wiped it.
        if (this.#captureAttempts > 0 && Date.now() - this.#captureSpawnedAt > 3000) {
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

            // Settle window: see setStreaming(false). The tail of the utterance that put
            // us to sleep must not be decoded as the phrase, and the goodbye must not
            // wake the session it is closing.
            if (Date.now() < this.#wakeCooldownUntil) {
                return;
            }

            // Never detect a wake through our own playback. With AEC the echo is
            // cancelled first, so a real "hey pi" spoken over the goodbye still lands;
            // with AEC off there is no way to tell the two apart, so stay deaf until the
            // speakers are quiet rather than open a session on our own voice.
            let detect = rawFloat;

            if (this.playing) {
                if (!this.#aec) {
                    return;
                }

                detect = this.#aec.process(rawFloat);
            }

            let wakeRms = rms;

            if (detect !== rawFloat) {
                let detectSum = 0;

                for (let i = 0; i < detect.length; i++) {
                    const value = detect[i] as number;
                    detectSum += value * value;
                }

                wakeRms = Math.sqrt(detectSum / Math.max(1, detect.length));
            }

            const threshold = Math.max(0.006, this.#noiseFloor * this.#wakeMultiplier);

            // Logged for both engines: "level 0.0000" is the difference between
            // "the phrase is not recognized" and "the mic delivers silence".
            if (Date.now() - this.#wakeNoteAt > 5000) {
                this.#wakeNoteAt = Date.now();
                const engine = this.#asr
                    ? `asr ${this.#asr.provider}`
                    : this.#kws ? `sherpa ${this.#kws.provider}` : "energy";

                this.#log(
                    `native wake (${engine}): `
                    + `level ${wakeRms.toFixed(4)} floor ${this.#noiseFloor.toFixed(4)} threshold ${threshold.toFixed(4)}`,
                );
            }

            if (this.#asr && !this.#asr.failed) {
                this.#asr.feed(detect, (keyword) => this.#onKeyword(keyword));

                return;
            }

            if (this.#kws && !this.#kws.failed) {
                this.#kws.feed(detect, (keyword) => this.#onKeyword(keyword));

                return;
            }

            // A wake engine that gave up (see feed's failure path) leaves the energy
            // VAD as the fallback, which is what `wakeEngine: auto` promises.

            // Energy wake with an adaptive noise floor, so a quiet mic still
            // wakes: a fixed threshold either misses soft speech or fires at
            // room tone.
            if (wakeRms < threshold) {
                this.#noiseFloor = Math.max(0.002, this.#noiseFloor * 0.95 + wakeRms * 0.05);
                this.#voicedMs = 0;
            } else {
                this.#voicedMs += 20;
            }

            if (this.#voicedMs >= 120) {
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
        return gainToFloat(samples, this.options.config.inputGain);
    }

    #log(message: string): void {
        // One place only: the controller's onLog writes the prefixed debug line.
        // Logging here *and* there printed every native line twice.
        this.options.onLog?.(message);
    }

    #error(message: string): void {
        // Same as #log: onError (controller `warn`) is the only sink.
        this.options.onError?.(message);
    }
}