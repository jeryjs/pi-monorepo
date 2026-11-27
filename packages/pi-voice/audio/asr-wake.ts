/**
 * Wake word by speech recognition, for voices the keyword spotter cannot hear.
 *
 * The 3.3M KWS model is small and English-only-accented: on some speakers it never
 * fires, at any threshold. A general streaming ASR decodes the same phrase anyway
 * ("HAYPE", "HAY PE", "HEYPI"), so matching *text* is far more forgiving than
 * matching acoustics — and it lets the wake phrase be anything the user types.
 *
 * Cost: a bigger model (~40 MB of int8 weights) and more CPU than the spotter. That
 * is the trade for a wake word that works on a real human voice.
 *
 * Contract matches `NativeKeywordSpotter`: `feed(samples, onWake)` after `create()`.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { asrModelStatus, loadSherpaModule, pickModelFile } from "../sherpa.ts";
import { matchWakePhrase } from "./wake-match.ts";

export interface NativeAsrWakeOptions {
    modelDir: string;
    /** Wake phrases in plain words ("hey pi"). Fuzzy-matched against the transcript. */
    phrases: readonly string[];
    provider?: string;
    onLog?: (message: string) => void;
    /** Engine-level failure (a throwing recognizer). Surfaces in /voice status. */
    onError?: (message: string) => void;
}

interface RecognizerStream {
    acceptWaveform: (input: { sampleRate: number; samples: Float32Array }) => void;
    inputFinished?: () => void;
}

interface OnlineRecognizer {
    createStream: () => RecognizerStream;
    isReady: (stream: RecognizerStream) => boolean;
    decode: (stream: RecognizerStream) => void;
    getResult: (stream: RecognizerStream) => { text?: string };
    isEndpoint?: (stream: RecognizerStream) => boolean;
    reset?: (stream: RecognizerStream) => void;
}

interface SherpaModule {
    OnlineRecognizer?: new (config: unknown) => OnlineRecognizer;
}

export class NativeAsrWakeSpotter {
    readonly #recognizer: OnlineRecognizer;
    readonly #stream: RecognizerStream;
    readonly #phrases: readonly string[];
    readonly provider: string;
    /** Text decoded in the current segment; reset at every endpoint. */
    #heard = "";
    #lastFireAt = 0;
    /** One wake per decoded segment, so a long sentence cannot fire twice. */
    #firedInSegment = false;
    /** Consecutive decode failures; the engine reports once and then gives up. */
    #failures = 0;
    #failed = false;
    readonly #onError: ((message: string) => void) | undefined;

    private constructor(
        recognizer: OnlineRecognizer,
        stream: RecognizerStream,
        phrases: readonly string[],
        provider: string,
        onError?: (message: string) => void,
    ) {
        this.#recognizer = recognizer;
        this.#stream = stream;
        this.#phrases = phrases;
        this.provider = provider;
        this.#onError = onError;
    }

    /** False once the recognizer has thrown repeatedly: the caller falls back to VAD. */
    get failed(): boolean {
        return this.#failed;
    }

    static async create(options: NativeAsrWakeOptions): Promise<NativeAsrWakeSpotter | undefined> {
        const { modelDir } = options;

        if (!modelDir || !existsSync(modelDir)) {
            options.onLog?.("asr: no recognizer model directory (run /voice asr to install one)");

            return undefined;
        }

        const status = asrModelStatus(modelDir);

        if (!status.ok) {
            options.onLog?.(`asr: model incomplete in ${modelDir}: missing ${status.missing.join(", ")}`);

            return undefined;
        }

        const phrases = options.phrases.filter((phrase) => phrase.trim().length > 0);

        if (phrases.length === 0) {
            options.onLog?.("asr: no wake phrases configured");

            return undefined;
        }

        const patched = loadSherpaModule() as SherpaModule | undefined;

        if (!patched?.OnlineRecognizer) {
            options.onLog?.("asr: sherpa-onnx-node is not installed (run /voice sherpa to install it)");

            return undefined;
        }

        // Same provider story as the keyword spotter: the prebuilt package is CPU.
        const providers = options.provider && options.provider !== "auto"
            ? [options.provider, "cpu"]
            : ["cpu"];

        for (const provider of providers) {
            try {
                const recognizer = new patched.OnlineRecognizer({
                    featConfig: { sampleRate: 16_000, featureDim: 80 },
                    modelConfig: {
                        transducer: {
                            encoder: pickModelFile(modelDir, "encoder"),
                            decoder: pickModelFile(modelDir, "decoder"),
                            joiner: pickModelFile(modelDir, "joiner"),
                        },
                        tokens: join(modelDir, "tokens.txt"),
                        numThreads: 1,
                        provider,
                        debug: 0,
                    },
                    decodingMethod: "modified_beam_search",
                    // Endpoints let us drop the context at sentence ends instead of
                    // decoding one ever-growing utterance.
                    enableEndpoint: true,
                    rule1MinTrailingSilence: 2.4,
                    rule2MinTrailingSilence: 1.2,
                    rule3MinUtteranceLength: 20,
                });
                const stream = recognizer.createStream();

                options.onLog?.(`asr: wake recognizer ready (${provider}, phrases: ${phrases.join(", ")})`);

                return new NativeAsrWakeSpotter(recognizer, stream, phrases, provider, options.onError);
            } catch (error) {
                options.onLog?.(`asr: provider ${provider} failed: ${String(error)}`);
            }
        }

        return undefined;
    }

    /** Feed 16 kHz mono float audio; fires `onWake` with the matched phrase. */
    feed(samples: Float32Array, onWake: (keyword: string) => void): void {
        if (this.#failed) {
            return;
        }

        try {
            this.#stream.acceptWaveform({ sampleRate: 16_000, samples });

            while (this.#recognizer.isReady(this.#stream)) {
                this.#recognizer.decode(this.#stream);

                const text = (this.#recognizer.getResult(this.#stream).text ?? "").trim();

                if (!text || text === this.#heard) {
                    continue;
                }

                // A decoder that rewrites instead of extending has started a new
                // segment (or corrected itself): allow the next wake. Without this, a
                // recognizer that never reports an endpoint would wake exactly once per
                // process — the flag would never be cleared.
                if (this.#firedInSegment && !text.startsWith(this.#heard)) {
                    this.#firedInSegment = false;
                }

                // Match the whole segment, not the suffix added since the last pass.
                // Suffix-only matching required the whole phrase to land inside one
                // decoder update: "HEY" then "HEY PI" produced the windows "HEY" and
                // " PI", neither containing the phrase, so the wake word was missed on
                // exactly the slow, careful speech this engine exists for.
                this.#heard = text;

                if (this.#firedInSegment) {
                    continue;
                }

                const match = matchWakePhrase(text, this.#phrases);

                if (match.matched && Date.now() - this.#lastFireAt > 1200) {
                    this.#firedInSegment = true;
                    this.#lastFireAt = Date.now();
                    this.#failures = 0;
                    onWake(match.heard ?? match.phrase ?? "");
                }
            }

            if (this.#recognizer.isEndpoint?.(this.#stream)) {
                this.#recognizer.reset?.(this.#stream);
                this.#heard = "";
                this.#firedInSegment = false;
            }

            this.#failures = 0;
        } catch (error) {
            // A bad frame must not kill capture, but a recognizer that keeps throwing
            // is a dead wake word: report it and let the caller fall back to VAD.
            this.#failures++;

            if (this.#failures === 1) {
                this.#onError?.(`asr wake failed: ${String(error)}`);
            }

            if (this.#failures >= 20 && !this.#failed) {
                this.#failed = true;
                this.#onError?.("asr wake stopped after repeated decode failures; falling back to energy VAD");
            }
        }
    }
}