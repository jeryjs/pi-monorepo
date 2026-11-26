/**
 * Per-model capability table for the Gemini Live API.
 * Keep in sync with:
 *   https://ai.google.dev/gemini-api/docs/live-api/tools
 *   https://ai.google.dev/gemini-api/docs/live-api/capabilities
 *
 * The extension is model-agnostic: everything it sends is filtered through this
 * table so an older/smaller Live model still works without special-casing.
 */

export type ThinkingMode = "level" | "budget" | "interleaved" | "none";

export interface ModelCapabilities {
    /** Model id without the `models/` prefix. */
    id: string;
    label: string;
    /** Synchronous function calling (model waits for the tool result). */
    syncTools: boolean;
    /** Asynchronous function calling (`behavior: NON_BLOCKING`). */
    asyncTools: boolean;
    /** FunctionResponse `scheduling` (INTERRUPT | WHEN_IDLE | SILENT). */
    toolScheduling: boolean;
    thinking: ThinkingMode;
    /** Model rejects setup unless a thinking level is supplied. */
    thinkingRequired?: boolean;
    /** Supports `generationConfig.enableAffectiveDialog` (default true). */
    affectiveDialog?: boolean;
    searchGrounding: boolean;
    nativeAudio: boolean;
    /** Approximate context window in tokens. */
    contextWindow: number;
}

const TABLE: readonly ModelCapabilities[] = [
    {
        id: "gemini-3.8-live",
        label: "Gemini 3.8 Live",
        syncTools: true,
        asyncTools: true,
        toolScheduling: true,
        thinking: "interleaved",
        affectiveDialog: false,
        searchGrounding: true,
        nativeAudio: true,
        contextWindow: 128_000,
    },
    {
        id: "gemini-3.8-live-extended-thinking",
        label: "Gemini 3.8 Live Extended Thinking",
        syncTools: false,
        asyncTools: true,
        toolScheduling: false,
        thinking: "level",
        thinkingRequired: true,
        affectiveDialog: false,
        searchGrounding: true,
        nativeAudio: true,
        contextWindow: 128_000,
    },
    {
        id: "gemini-3.1-flash-live-preview",
        label: "Gemini 3.1 Flash Live (lowest latency)",
        syncTools: true,
        asyncTools: false,
        toolScheduling: false,
        thinking: "level",
        affectiveDialog: false,
        searchGrounding: true,
        nativeAudio: true,
        contextWindow: 128_000,
    },
    {
        id: "gemini-2.5-flash-native-audio-preview-12-2025",
        label: "Gemini 2.5 Flash Native Audio",
        syncTools: true,
        asyncTools: true,
        toolScheduling: true,
        thinking: "budget",
        affectiveDialog: false,
        searchGrounding: true,
        nativeAudio: true,
        contextWindow: 128_000,
    },
];

/** Assumed capabilities for an unknown-but-plausible Live model id. */
const FALLBACK: Omit<ModelCapabilities, "id" | "label"> = {
    syncTools: true,
    asyncTools: false,
    toolScheduling: false,
    thinking: "none",
    searchGrounding: true,
    nativeAudio: true,
    contextWindow: 128_000,
};

export function normalizeModelId(id: string): string {
    return id.replace(/^models\//, "").trim();
}

export function capabilitiesFor(id: string): ModelCapabilities {
    const normalized = normalizeModelId(id);
    const found = TABLE.find((entry) => entry.id === normalized);

    if (found) {
        return found;
    }

    return { id: normalized, label: normalized, ...FALLBACK };
}

export function liveModelIds(): string[] {
    return TABLE.map((entry) => entry.id);
}

export function describeModels(): string {
    return TABLE.map((entry) => `${entry.id} (${entry.label})`).join("\n  ");
}
