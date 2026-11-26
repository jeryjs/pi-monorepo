/**
 * Wake-word layer.
 *
 * Three engines behind one contract:
 *   - "sherpa":   offline keyword spotting. Lazy-loads a module that exports
 *                 `createKeywordSpotter({ sampleRate, phrases, sensitivity, compute })`
 *                 returning `{ acceptWaveform(Float32Array) -> boolean, reset?() }`.
 *                 Point `wakeModelUrl` at a local build to keep it fully offline.
 *   - "webspeech": Chrome/Edge SpeechRecognition as a phrase spotter (online).
 *   - "energy":   local VAD. Not phrase-aware, but always available and offline.
 *
 * "auto" prefers sherpa (when configured), then webspeech, then energy.
 */

export function detectComputeBackends() {
    const nav = typeof navigator === "undefined" ? {} : navigator;

    return {
        webnn: "ml" in nav,
        webgpu: "gpu" in nav,
        wasm: typeof WebAssembly === "object",
    };
}

export function pickCompute(requested) {
    const backends = detectComputeBackends();

    if (requested === "webnn") {
        return backends.webnn ? "webnn" : "wasm";
    }

    if (requested === "webgpu") {
        return backends.webgpu ? "webgpu" : "wasm";
    }

    if (requested === "cpu") {
        return "wasm";
    }

    // auto: NPU via WebNN, then GPU, then CPU.
    if (backends.webnn) {
        return "webnn";
    }

    if (backends.webgpu) {
        return "webgpu";
    }

    return "wasm";
}

function phraseMatchers(phrases) {
    return phrases
        .map((phrase) => phrase.trim().toLowerCase())
        .filter(Boolean)
        .map((phrase) => {
            // Tolerate the classic "pi/pi e/pie" mishearing.
            const body = phrase
                .split(/\s+/)
                .map((word) => {
                    if (word === "pi") {
                        return "(?:pi|pie|py|p)";
                    }

                    return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                })
                .join("\\s+");

            return new RegExp(body, "i");
        });
}

function energyEngine({ sensitivity, onWake, onState }) {
    let floor = 0.004;
    let voiced = 0;
    let cooldownUntil = 0;
    let armed = true;

    return {
        name: "energy",
        supportsFeed: true,
        start() {
            onState?.("ready", "energy");
        },
        stop() {},
        feed(samples) {
            let sum = 0;

            for (let i = 0; i < samples.length; i++) {
                sum += samples[i] * samples[i];
            }

            const rms = Math.sqrt(sum / Math.max(1, samples.length));

            if (rms < floor * 1.8) {
                floor = floor * 0.97 + rms * 0.03;
                floor = Math.max(0.0015, Math.min(0.05, floor));
            }

            const threshold = floor * (2.4 + (1 - sensitivity) * 3.0);
            const now = Date.now();

            if (rms > threshold) {
                voiced += 20;
            } else {
                voiced = Math.max(0, voiced - 40);
            }

            if (!armed && voiced < 40) {
                armed = true;
            }

            if (armed && voiced >= 160 && now > cooldownUntil) {
                armed = false;
                voiced = 0;
                cooldownUntil = now + 1500;
                onWake("energy");
            }
        },
    };
}

function speechEngine({ phrases, language, onWake, onState }) {
    const Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;

    if (typeof Recognition !== "function") {
        return undefined;
    }

    const matchers = phraseMatchers(phrases);
    let recognition = null;
    let running = false;
    let cooldownUntil = 0;

    const start = () => {
        if (running) {
            return;
        }

        running = true;
        recognition = new Recognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = language || navigator.language || "en-US";

        recognition.onresult = (event) => {
            let text = "";

            for (let i = event.resultIndex; i < event.results.length; i++) {
                text += event.results[i][0].transcript;
            }

            const normalized = text
                .toLowerCase()
                .replace(/[^a-z0-9 ]/g, " ")
                .replace(/\s+/g, " ")
                .trim();

            if (!normalized || Date.now() < cooldownUntil) {
                return;
            }

            if (matchers.some((matcher) => matcher.test(normalized))) {
                cooldownUntil = Date.now() + 2500;
                onWake("webspeech");
            }
        };

        recognition.onend = () => {
            if (!running) {
                return;
            }

            // Chrome stops on silence; restart politely.
            setTimeout(() => {
                if (!running) {
                    return;
                }

                try {
                    recognition.start();
                } catch {
                    // already started
                }
            }, 250);
        };

        recognition.onerror = (event) => {
            if (event.error === "not-allowed" || event.error === "service-not-allowed") {
                running = false;
                onState?.("error", event.error);
            }
        };

        try {
            recognition.start();
            onState?.("ready", "webspeech");
        } catch (error) {
            running = false;
            onState?.("error", String(error));
        }
    };

    const stop = () => {
        running = false;

        try {
            recognition?.abort();
        } catch {
            // ignore
        }

        recognition = null;
    };

    return { name: "webspeech", supportsFeed: false, start, stop };
}

async function sherpaEngine({ moduleUrl, phrases, sensitivity, compute, onWake, onState }) {
    if (!moduleUrl) {
        return undefined;
    }

    const backend = pickCompute(compute);
    let module;

    try {
        module = await import(moduleUrl);
    } catch (error) {
        onState?.("fallback", `sherpa load failed: ${String(error)}`);
        return undefined;
    }

    const factory = module.createKeywordSpotter ?? module.default?.createKeywordSpotter ?? module.default;

    if (typeof factory !== "function") {
        onState?.("fallback", "wake module has no createKeywordSpotter export");
        return undefined;
    }

    let spotter;

    try {
        spotter = await factory({ sampleRate: 16000, phrases, sensitivity, compute: backend });
    } catch (error) {
        onState?.("fallback", `sherpa init failed: ${String(error)}`);
        return undefined;
    }

    onState?.("ready", `sherpa/${backend}`);

    return {
        name: "sherpa",
        supportsFeed: true,
        backend,
        start() {},
        stop() {
            spotter?.free?.();
        },
        feed(samples) {
            try {
                if (spotter.acceptWaveform(samples)) {
                    onWake("sherpa");
                    spotter.reset?.();
                }
            } catch {
                // ignore a bad frame
            }
        },
    };
}

/**
 * Create the best available wake engine.
 * Resolves to `{ name, supportsFeed, start, stop, feed?, backend? }`.
 */
export async function createWakeEngine(options) {
    const { engine = "auto", phrases, sensitivity, compute, moduleUrl, language, onWake, onState } = options;
    const wanted = engine === "auto" ? "auto" : engine;

    if (wanted === "sherpa" || wanted === "auto") {
        const sherpa = await sherpaEngine({ moduleUrl, phrases, sensitivity, compute, onWake, onState });

        if (sherpa) {
            return sherpa;
        }

        if (wanted === "sherpa") {
            onState?.("fallback", "sherpa unavailable");
        }
    }

    if (wanted === "webspeech" || wanted === "auto") {
        const speech = speechEngine({ phrases, language, onWake, onState });

        if (speech) {
            return speech;
        }

        if (wanted === "webspeech") {
            onState?.("fallback", "Web Speech unavailable");
        }
    }

    return energyEngine({ sensitivity, onWake, onState });
}