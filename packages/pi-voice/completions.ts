/**
 * `/voice` argument completions.
 *
 * Pi passes the whole argument text after `/voice ` and, when an item is
 * accepted, replaces that whole text with `item.value`. So every value here is
 * a *complete argument*, not just the token being typed — that is what makes
 * nested completion (`model gem…`, `always-on o…`) work.
 *
 * Matching is prefix > word-prefix > subsequence, with state-aware annotations
 * (current model/voice) and ordering.
 */

export interface CompletionItem {
    value: string;
    label: string;
    description?: string;
}

export interface CompletionContext {
    models: { id: string; label: string }[];
    voices: readonly string[];
    currentModel: string;
    currentVoice: string;
    running?: boolean;
}

interface Candidate {
    token: string;
    label: string;
    description?: string;
    /** Higher wins when the query is empty. */
    weight?: number;
}

interface SubcommandSpec {
    name: string;
    aliases?: string[];
    description: string;
    weight?: number;
    values?: (context: CompletionContext) => Candidate[];
}

const ON_OFF = (): Candidate[] => [
    { token: "on", label: "on", description: "enable" },
    { token: "off", label: "off", description: "disable" },
];

const SET_SNIPPETS: { json: string; description: string }[] = [
    { json: '{"alwaysOn":true}', description: "always-on wake word" },
    { json: '{"alwaysOn":false}', description: "push-to-talk only" },
    { json: '{"announce":false}', description: "stop speaking Pi's completion notices" },
    { json: '{"proactiveAudio":true}', description: "let the model ignore speech not aimed at it" },
    { json: '{"bargeIn":false}', description: "never interrupt the model with speech" },
    { json: '{"audio":"native"}', description: "headless ffmpeg audio (no browser tab)" },
    { json: '{"audio":"browser"}', description: "companion page with WebRTC AEC" },
    { json: '{"autonomy":"concierge"}', description: "talk and queue requests only" },
    { json: '{"voiceApprovals":false}', description: "no spoken approval prompts" },
    { json: '{"idleSleepMs":120000}', description: "sleep after 2 minutes of silence" },
    { json: '{"vadSilenceMs":700}', description: "wait longer before ending a turn" },
    { json: '{"searchGrounding":false}', description: "disable Google Search grounding" },
    { json: '{"thinkingLevel":"low"}', description: "cheaper thinking (3.1 Flash / 3.8 ET)" },
    { json: '{"persona":"Be terse."}', description: "add persona instructions" },
];

const SUBCOMMANDS: SubcommandSpec[] = [
    {
        name: "status",
        description: "show session, model, audio and key state",
        weight: 100,
        values: () => [],
    },
    {
        name: "diagnose",
        aliases: ["doctor"],
        description: "open a real Live socket per model and report the server's answer",
        weight: 98,
        values: () => [],
    },
    {
        name: "on",
        aliases: ["start"],
        description: "start the voice session and open the page",
        weight: 95,
        values: () => [],
    },
    {
        name: "off",
        aliases: ["stop"],
        description: "stop the voice session",
        weight: 90,
        values: () => [],
    },
    {
        name: "restart",
        description: "stop then start again",
        weight: 60,
        values: () => [],
    },
    {
        name: "url",
        description: "print the companion page URL",
        weight: 55,
        values: () => [],
    },
    {
        name: "listen",
        aliases: ["wake"],
        description: "start listening now",
        weight: 80,
        values: () => [],
    },
    {
        name: "sleep",
        description: "stop listening until the wake phrase",
        weight: 70,
        values: () => [],
    },
    {
        name: "always-on",
        aliases: ["alwaysOn"],
        description: "toggle the always-on wake listener",
        weight: 85,
        values: ON_OFF,
    },
    {
        name: "model",
        description: "choose the Gemini Live model",
        weight: 88,
        values: (context) =>
            context.models.map((model) => ({
                token: model.id,
                label: model.label,
                description: model.id === context.currentModel ? "current" : model.id,
            })),
    },
    {
        name: "voice-name",
        aliases: ["voicename"],
        description: "choose the prebuilt voice",
        weight: 75,
        values: (context) =>
            context.voices.map((voice) => ({
                token: voice,
                label: voice,
                description: voice === context.currentVoice ? "current" : "prebuilt voice",
            })),
    },
    {
        name: "autonomy",
        description: "concierge | steer | approvals",
        weight: 72,
        values: () => [
            { token: "concierge", label: "concierge", description: "talk + queue requests only" },
            { token: "steer", label: "steer", description: "+ interrupt/steer a running turn" },
            { token: "approvals", label: "approvals", description: "+ answer risky-action prompts by voice" },
        ],
    },
    {
        name: "wake-engine",
        aliases: ["wakeengine"],
        description: "auto | sherpa | webspeech | energy",
        weight: 65,
        values: () => [
            { token: "auto", label: "auto", description: "sherpa when installed, else energy VAD" },
            { token: "sherpa", label: "sherpa", description: "offline phrase spotter (installs on demand)" },
            { token: "webspeech", label: "webspeech", description: "Chrome/Edge recognizer (browser transport)" },
            { token: "energy", label: "energy", description: "local VAD, any loud speech wakes" },
        ],
    },
    {
        name: "sherpa",
        aliases: ["wake-install"],
        description: "install the offline phrase wake word (sherpa-onnx-node + model)",
        weight: 64,
        values: () => [
            { token: "force", label: "force", description: "reinstall even when already set up" },
        ],
    },
    {
        name: "compute",
        description: "auto | cpu | webgpu | webnn",
        weight: 50,
        values: () => [
            { token: "auto", label: "auto", description: "WebNN (NPU) > WebGPU > WASM" },
            { token: "cpu", label: "cpu", description: "WASM on the CPU" },
            { token: "webgpu", label: "webgpu", description: "GPU via WebGPU" },
            { token: "webnn", label: "webnn", description: "NPU via WebNN (Intel AI Boost)" },
        ],
    },
    {
        name: "announce",
        description: "speak Pi's completion notices",
        weight: 55,
        values: ON_OFF,
    },
    {
        name: "debug",
        description: "verbose pi-voice logging (PI_VOICE_DEBUG)",
        weight: 40,
        values: ON_OFF,
    },
    {
        name: "key",
        description: "set the Gemini API key, or show where it comes from",
        weight: 58,
        values: () => [{ token: "clear", label: "clear", description: "forget the stored key" }],
    },
    {
        name: "set",
        description: "patch config with a JSON snippet",
        weight: 45,
        values: () =>
            SET_SNIPPETS.map((snippet) => ({
                token: snippet.json,
                label: snippet.json,
                description: snippet.description,
            })),
    },
    {
        name: "help",
        description: "list subcommands",
        weight: 30,
        values: () => [],
    },
];

function score(query: string, text: string): number {
    if (!query) {
        return 1;
    }

    const haystack = text.toLowerCase();

    if (haystack.startsWith(query)) {
        return 100 - haystack.length * 0.01;
    }

    const at = haystack.indexOf(query);

    if (at >= 0) {
        return 60 - at;
    }

    // Subsequence: "awon" -> "always-on".
    let cursor = 0;

    for (const character of haystack) {
        if (character === query[cursor]) {
            cursor++;

            if (cursor === query.length) {
                return 20;
            }
        }
    }

    return -1;
}

function rank(query: string, candidates: Candidate[]): Candidate[] {
    const normalized = query.trim().toLowerCase();

    return candidates
        .map((candidate, index) => {
            const primary = score(normalized, candidate.label);
            const secondary = score(normalized, candidate.description ?? "") * 0.6;
            const best = Math.max(primary, secondary);
            const weighted = normalized ? best : candidate.weight ?? 0;

            return { candidate, index, value: weighted };
        })
        .filter((entry) => entry.value >= 0)
        .sort((a, b) => b.value - a.value || a.index - b.index)
        .map((entry) => entry.candidate);
}

function subcommandItems(query: string): CompletionItem[] {
    const candidates: Candidate[] = SUBCOMMANDS.map((spec) => ({
        token: spec.name,
        label: spec.name,
        description: spec.description,
        weight: spec.weight,
    }));

    return rank(query, candidates).map((candidate) => ({
        value: candidate.token,
        label: candidate.label,
        description: candidate.description,
    }));
}

function findSubcommand(name: string): SubcommandSpec | undefined {
    return SUBCOMMANDS.find((spec) => spec.name === name || spec.aliases?.includes(name));
}

/**
 * Complete the text after `/voice `. Returns `[]` when nothing matches, so Pi
 * can fall back to its own providers.
 */
export function completeVoiceArguments(argumentText: string, context: CompletionContext): CompletionItem[] {
    const raw = argumentText ?? "";
    const text = raw.replace(/^\s+/, "");
    const space = text.indexOf(" ");

    if (space === -1) {
        return subcommandItems(text);
    }

    const name = text.slice(0, space);
    const rest = text.slice(space + 1);
    const spec = findSubcommand(name);

    if (!spec) {
        // "mod " while typing: complete the subcommand from the whole text.
        return subcommandItems(text);
    }

    if (!spec.values) {
        return [];
    }

    let candidates = spec.values(context);

    // For `set`, a typed JSON prefix is matched against the snippet itself.
    if (spec.name === "set" && /\{\s*"?[\w]*$/.test(rest.trim())) {
        const normalized = rest.trim().toLowerCase();
        candidates = candidates.filter((candidate) => candidate.token.toLowerCase().startsWith(normalized) || normalized === "{" || normalized === "");

        if (candidates.length === 0) {
            candidates = spec.values(context);
        }
    }

    return rank(rest, candidates).map((candidate) => ({
        value: `${name} ${candidate.token}`,
        label: candidate.label,
        description: candidate.description,
    }));
}