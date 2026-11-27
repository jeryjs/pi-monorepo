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
    /** Text decoded so far in the current segment, so only new words are matched. */
    #heard = "";
    #lastFireAt = 0;

    private constructor(
        recognizer: OnlineRecognizer,
        stream: RecognizerStream,
        phrases: readonly string[],
        provider: string,
    ) {
        this.#recognizer = recognizer;
        this.#stream = stream;
        this.#phrases = phrases;
        this.provider = provider;
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

                return new NativeAsrWakeSpotter(recognizer, stream, phrases, provider);
            } catch (error) {
                options.onLog?.(`asr: provider ${provider} failed: ${String(error)}`);
            }
        }

        return undefined;
    }

    /** Feed 16 kHz mono float audio; fires `onWake` with the matched phrase. */
    feed(samples: Float32Array, onWake: (keyword: string) => void): void {
        try {
            this.#stream.acceptWaveform({ sampleRate: 16_000, samples });

            while (this.#recognizer.isReady(this.#stream)) {
                this.#recognizer.decode(this.#stream);

                const text = (this.#recognizer.getResult(this.#stream).text ?? "").trim();

                if (!text) {
                    continue;
                }

                // Only the words added since the last pass: re-matching the whole
                // segment would fire again on the same phrase.
                const fresh = text.length > this.#heard.length && text.startsWith(this.#heard)
                    ? text.slice(this.#heard.length)
                    : text;

                this.#heard = text;

                const match = matchWakePhrase(fresh, this.#phrases);

                if (match.matched && Date.now() - this.#lastFireAt > 1200) {
                    this.#lastFireAt = Date.now();
                    onWake(match.heard ?? match.phrase ?? "");
                }
            }

            if (this.#recognizer.isEndpoint?.(this.#stream)) {
                this.#recognizer.reset?.(this.#stream);
                this.#heard = "";
            }
        } catch {
            // a bad frame must not kill capture
        }
    }
}