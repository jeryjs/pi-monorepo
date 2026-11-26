/**
 * Acoustic echo cancellation for the native transport.
 *
 * A time-domain NLMS adaptive filter estimates the speaker→microphone path from
 * the known playback signal and subtracts it from the mic. Double-talk detection
 * freezes adaptation while the user speaks so their voice is not cancelled.
 *
 * This is not WebRTC AEC3, but it is real cancellation (not a mute), needs no
 * native addon, and is enough to keep the model from hearing itself on speakers.
 *
 * One instance per output rate; all input is 16 kHz mono float.
 */

export interface AecOptions {
    /** Filter length in samples (16 kHz). 1536 ≈ 96 ms of echo path. */
    taps?: number;
    /** Estimated speaker→mic delay in ms. */
    delayMs?: number;
    /** NLMS step size. */
    mu?: number;
}

export class AcousticEchoCanceller {
    readonly #taps: number;
    readonly #delay: number;
    readonly #mu: number;
    readonly #weights: Float32Array;
    readonly #ring: Float32Array;
    readonly #size: number;
    #write = 0;
    #lastEchoEnergy = 0;

    constructor(options: AecOptions = {}) {
        this.#taps = Math.max(256, Math.floor(options.taps ?? 1536));
        this.#delay = Math.max(0, Math.round(((options.delayMs ?? 40) / 1000) * 16_000));
        this.#mu = Math.min(0.9, Math.max(0.01, options.mu ?? 0.35));
        this.#weights = new Float32Array(this.#taps);
        this.#size = this.#taps + this.#delay + 4096;
        this.#ring = new Float32Array(this.#size);
    }

    /** Feed playback audio (16 kHz) as the echo reference. */
    pushReference(samples: Float32Array): void {
        for (let i = 0; i < samples.length; i++) {
            this.#ring[this.#write] = samples[i] as number;
            this.#write = (this.#write + 1) % this.#size;
        }
    }

    /** Subtract the estimated echo from a 16 kHz mic frame. */
    process(mic: Float32Array): Float32Array {
        const out = new Float32Array(mic.length);
        const taps = this.#taps;
        const ring = this.#ring;
        const size = this.#size;
        const weights = this.#weights;

        let micEnergy = 0;

        for (let i = 0; i < mic.length; i++) {
            micEnergy += (mic[i] as number) ** 2;
        }

        micEnergy /= Math.max(1, mic.length);
        // Freeze only once the filter has an echo estimate and the near end is
        // clearly louder than it (i.e. the user is speaking over the model).
        const freeze = this.#lastEchoEnergy > 1e-6 && micEnergy > this.#lastEchoEnergy * 4;
        let echoEnergy = 0;

        // Align the reference with this frame: the newest reference sample is the
        // last one pushed, and mic[0] lines up `delay` before the frame's end.
        const align = this.#write - mic.length - this.#delay;

        for (let i = 0; i < mic.length; i++) {
            const base = (((align + i) % size) + size) % size;

            let echo = 0;
            let norm = 1e-6;

            for (let j = 0; j < taps; j++) {
                const x = ring[(base - j + size) % size] as number;
                echo += (weights[j] as number) * x;
                norm += x * x;
            }

            const residual = (mic[i] as number) - echo;
            out[i] = residual;
            echoEnergy += echo * echo;

            if (!freeze) {
                const gain = (this.#mu * residual) / norm;

                for (let j = 0; j < taps; j++) {
                    const x = ring[(base - j + size) % size] as number;
                    weights[j] = (weights[j] as number) + gain * x;
                }
            }
        }

        this.#lastEchoEnergy = echoEnergy / Math.max(1, mic.length);

        return out;
    }

    reset(): void {
        this.#weights.fill(0);
        this.#ring.fill(0);
        this.#write = 0;
        this.#lastEchoEnergy = 0;
    }
}

/** Linear resample 24 kHz int16 to 16 kHz float, for feeding the reference. */
export function resample24kTo16k(samples: Int16Array): Float32Array {
    const ratio = 24_000 / 16_000;
    const length = Math.floor(samples.length / ratio);
    const out = new Float32Array(length);

    for (let i = 0; i < length; i++) {
        const position = i * ratio;
        const index = Math.floor(position);
        const fraction = position - index;
        const a = (samples[index] ?? 0) / 32768;
        const b = (samples[index + 1] ?? samples[index] ?? 0) / 32768;

        out[i] = a + (b - a) * fraction;
    }

    return out;
}

export function floatToInt16(samples: Float32Array): Int16Array {
    const out = new Int16Array(samples.length);

    for (let i = 0; i < samples.length; i++) {
        const value = Math.max(-1, Math.min(1, samples[i] as number));
        out[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }

    return out;
}