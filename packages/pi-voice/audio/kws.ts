/**
 * Offline keyword spotting for the native transport, via `sherpa-onnx-node`.
 *
 * Optional and lazy: if the module or model files are missing, the caller falls
 * back to energy VAD. `provider` selects the inference backend
 * ("directml" can reach the GPU/NPU through DirectML on Windows); each is tried
 * in order and the first that initialises wins.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface NativeKwsOptions {
    modelDir: string;
    keywords: string;
    provider?: string;
    onWake: (keyword: string) => void;
    onLog?: (message: string) => void;
}

interface SherpaModule {
    KeywordSpotter?: new (config: unknown) => {
        createStream: () => KwsStream;
        isReady: (stream: KwsStream) => boolean;
        decode: (stream: KwsStream) => void;
        getResult: (stream: KwsStream) => { keyword?: string };
    };
}

interface KwsStream {
    acceptWaveform: (input: { sampleRate: number; samples: Float32Array }) => void;
}

function pickFile(dir: string, prefix: string): string | undefined {
    try {
        const match = readdirSync(dir).find((name) => name.startsWith(prefix) && name.endsWith(".onnx"));

        return match ? join(dir, match) : undefined;
    } catch {
        return undefined;
    }
}

async function loadSherpa(cwd: string): Promise<SherpaModule | undefined> {
    try {
        return (await import("sherpa-onnx-node")) as SherpaModule;
    } catch {
        // fall through to a project-local resolution
    }

    try {
        const require = createRequire(join(cwd, "package.json"));

        return require("sherpa-onnx-node") as SherpaModule;
    } catch {
        return undefined;
    }
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

    static async create(options: NativeKwsOptions, cwd = process.cwd()): Promise<NativeKeywordSpotter | undefined> {
        const { modelDir } = options;

        if (!modelDir || !existsSync(modelDir)) {
            options.onLog?.("sherpa: no kwsModelDir configured");

            return undefined;
        }

        const encoder = pickFile(modelDir, "encoder");
        const decoder = pickFile(modelDir, "decoder");
        const joiner = pickFile(modelDir, "joiner");
        const tokens = existsSync(join(modelDir, "tokens.txt")) ? join(modelDir, "tokens.txt") : undefined;

        if (!encoder || !decoder || !joiner || !tokens) {
            options.onLog?.(`sherpa: kws model files incomplete in ${modelDir}`);

            return undefined;
        }

        // sherpa reads keywords from a file. Name it after the keyword set so
        // editing kwsKeywords actually changes the wake phrase: reusing a fixed
        // filename meant the first run's file won every later run.
        const keywords = options.keywords.trim() || "HEY PI :2.0";
        const legacy = join(modelDir, "keywords.txt");
        const digest = createHash("sha1").update(keywords).digest("hex").slice(0, 10);
        const generated = join(modelDir, `pi-voice-keywords-${digest}.txt`);
        let keywordsFile = generated;

        if (!existsSync(generated)) {
            let legacyMatches = false;

            try {
                legacyMatches = existsSync(legacy) && readFileSync(legacy, "utf8").trim() === keywords;
            } catch {
                legacyMatches = false;
            }

            if (legacyMatches) {
                keywordsFile = legacy;
            } else {
                try {
                    writeFileSync(generated, `${keywords}\n`, "utf8");
                } catch {
                    options.onLog?.("sherpa: cannot write keywords file");

                    return undefined;
                }
            }
        }

        const sherpa = await loadSherpa(cwd);

        if (!sherpa?.KeywordSpotter) {
            options.onLog?.("sherpa: sherpa-onnx-node is not installed (npm i sherpa-onnx-node)");

            return undefined;
        }

        const providers = options.provider && options.provider !== "auto"
            ? [options.provider, "cpu"]
            : ["directml", "cpu"];

        for (const provider of providers) {
            try {
                const spotter = new sherpa.KeywordSpotter({
                    featConfig: { sampleRate: 16_000, featureDim: 80 },
                    modelConfig: {
                        transducer: { encoder, decoder, joiner },
                        tokens,
                        numThreads: 1,
                        provider,
                        debug: 0,
                    },
                    keywordsFile,
                });
                const stream = spotter.createStream();

                options.onLog?.(`sherpa: keyword spotter ready (${provider})`);

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