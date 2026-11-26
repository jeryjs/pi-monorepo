/**
 * Offline keyword spotting for the native transport, via `sherpa-onnx-node`.
 *
 * Optional and lazy: if the module or model files are missing we fall back to
 * energy VAD, and `sherpa.ts` knows how to install both (from `/voice` → Wake
 * engine, or `/voice sherpa`). `provider` selects the inference backend
 * ("directml" can reach the GPU/NPU through DirectML on Windows); each is tried
 * in order and the first that initialises wins.
 *
 * The wake phrase must be given to sherpa as BPE tokens, not raw text, so it is
 * tokenised against the model's own `tokens.txt` (see `sherpa.tokenizeKeyword`).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
    DEFAULT_KEYWORD_SCORE,
    loadSherpaModule,
    modelStatus,
    pickModelFile,
    writeKeywordsFile,
} from "../sherpa.ts";

export interface NativeKwsOptions {
    modelDir: string;
    keywords: string;
    provider?: string;
    /** 0..1; higher = easier to trigger (maps to the spotter's threshold). */
    sensitivity?: number;
    onWake: (keyword: string) => void;
    onLog?: (message: string) => void;
}

interface KwsStream {
    acceptWaveform: (input: { sampleRate: number; samples: Float32Array }) => void;
}

interface SherpaModule {
    KeywordSpotter?: new (config: unknown) => {
        createStream: () => KwsStream;
        isReady: (stream: KwsStream) => boolean;
        decode: (stream: KwsStream) => void;
        getResult: (stream: KwsStream) => { keyword?: string };
    };
}

/**
 * Verified against the gigaspeech model: at 0.5 sensitivity the threshold is
 * 0.25, which detected the model's own test phrases reliably.
 */
export function keywordThreshold(sensitivity: number | undefined): number {
    const value = Number.isFinite(sensitivity) ? (sensitivity as number) : 0.5;

    return Math.min(0.6, Math.max(0.05, 0.45 - value * 0.4));
}

export class NativeKeywordSpotter {
    readonly #spotter: InstanceType<NonNullable<SherpaModule["KeywordSpotter"]>>;
    readonly #stream: KwsStream;
    readonly provider: string;

    private constructor(
        spotter: InstanceType<NonNullable<SherpaModule["KeywordSpotter"]>>,
        stream: KwsStream,
        provider: string,
    ) {
        this.#spotter = spotter;
        this.#stream = stream;
        this.provider = provider;
    }

    static async create(options: NativeKwsOptions, _cwd = process.cwd()): Promise<NativeKeywordSpotter | undefined> {
        const { modelDir } = options;

        if (!modelDir || !existsSync(modelDir)) {
            options.onLog?.("sherpa: no wake model directory (run /voice sherpa to install one)");

            return undefined;
        }

        const status = modelStatus(modelDir);

        if (!status.ok) {
            options.onLog?.(`sherpa: wake model incomplete in ${modelDir}: missing ${status.missing.join(", ")}`);

            return undefined;
        }

        // Tokenised keywords file, named after the phrase set so editing the wake
        // phrase takes effect (a fixed filename meant the first file always won).
        const keywords = writeKeywordsFile(modelDir, options.keywords);

        if (!keywords.ok) {
            options.onLog?.(`sherpa: ${keywords.reason}`);

            return undefined;
        }

        const patched = loadSherpaModule() as SherpaModule | undefined;

        if (!patched?.KeywordSpotter) {
            options.onLog?.("sherpa: sherpa-onnx-node is not installed (run /voice sherpa to install it)");

            return undefined;
        }

        const encoder = pickModelFile(modelDir, "encoder");
        const decoder = pickModelFile(modelDir, "decoder");
        const joiner = pickModelFile(modelDir, "joiner");
        const tokens = join(modelDir, "tokens.txt");

        const providers = options.provider && options.provider !== "auto"
            ? [options.provider, "cpu"]
            : ["directml", "cpu"];
        const threshold = keywordThreshold(options.sensitivity);

        for (const provider of providers) {
            try {
                const spotter = new patched.KeywordSpotter({
                    featConfig: { sampleRate: 16_000, featureDim: 80 },
                    modelConfig: {
                        transducer: { encoder, decoder, joiner },
                        tokens,
                        numThreads: 1,
                        provider,
                        debug: 0,
                    },
                    keywordsFile: keywords.path,
                    keywordsScore: DEFAULT_KEYWORD_SCORE,
                    keywordsThreshold: threshold,
                    numTrailingBlanks: 1,
                });
                const stream = spotter.createStream();

                options.onLog?.(
                    `sherpa: keyword spotter ready (${provider}, threshold ${threshold.toFixed(2)}, `
                    + `${keywords.lines.length} keyword(s))`,
                );

                return new NativeKeywordSpotter(spotter, stream, provider);
            } catch (error) {
                options.onLog?.(`sherpa: provider ${provider} failed: ${String(error)}`);
            }
        }

        return undefined;
    }

    /** Feed 16 kHz mono float audio; fires `onWake` through the callback given to create(). */
    feed(samples: Float32Array, onWake: (keyword: string) => void): void {
        try {
            this.#stream.acceptWaveform({ sampleRate: 16_000, samples });

            while (this.#spotter.isReady(this.#stream)) {
                this.#spotter.decode(this.#stream);
                const result = this.#spotter.getResult(this.#stream);

                if (result.keyword) {
                    onWake(result.keyword);
                }
            }
        } catch {
            // a bad frame must not kill capture
        }
    }
}
