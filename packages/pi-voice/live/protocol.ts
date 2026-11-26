/**
 * Wire protocol for the Gemini Live API (`BidiGenerateContent`, v1beta).
 *
 * Docs: https://ai.google.dev/api/live
 * We speak the raw WebSocket protocol directly (no SDK) so the extension stays
 * dependency-free and can relay 16 kHz/24 kHz PCM with zero re-encoding.
 */

export const LIVE_WS_BASE =
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** Gemini Live input audio format (raw little-endian PCM). */
export const INPUT_MIME = "audio/pcm;rate=16000";
/** Gemini Live output audio format. */
export const OUTPUT_SAMPLE_RATE = 24_000;
/** Gemini Live input sample rate. */
export const INPUT_SAMPLE_RATE = 16_000;

export function liveSocketUrl(apiKey: string): string {
    return `${LIVE_WS_BASE}?key=${encodeURIComponent(apiKey)}`;
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export interface FunctionDeclaration {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    /** "NON_BLOCKING" for async function calling on capable models. */
    behavior?: "NON_BLOCKING";
}

export interface FunctionResponse {
    id?: string;
    name: string;
    response: Record<string, unknown>;
}

export function encodePcmBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function decodePcmBase64(value: string): Uint8Array {
    const buffer = Buffer.from(value, "base64");

    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** Streaming microphone audio. */
export function audioInputMessage(bytes: Uint8Array): string {
    return JSON.stringify({ realtimeInput: { audio: { data: encodePcmBase64(bytes), mimeType: INPUT_MIME } } });
}

/** Mark the end of the current audio stream (mic off / paused). */
export function audioStreamEndMessage(): string {
    return JSON.stringify({ realtimeInput: { audioStreamEnd: true } });
}

/** Manual activity markers (only when automatic VAD is disabled). */
export function activityStartMessage(): string {
    return JSON.stringify({ realtimeInput: { activityStart: {} } });
}

export function activityEndMessage(): string {
    return JSON.stringify({ realtimeInput: { activityEnd: {} } });
}

/** Text that participates in turn-taking (no model call until turnComplete). */
export function realtimeTextMessage(text: string): string {
    return JSON.stringify({ realtimeInput: { text } });
}

/**
 * Explicit conversation content. With `historyConfig.initialHistoryInClientContent`
 * this seeds context without triggering a model call, which is how the extension
 * keeps the voice session aware of Pi cheaply.
 */
export function clientContentMessage(
    turns: { role: "user" | "model"; text: string }[],
    turnComplete: boolean,
): string {
    return JSON.stringify({
        clientContent: {
            turns: turns.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
            turnComplete,
        },
    });
}

export function toolResponseMessage(responses: FunctionResponse[]): string {
    return JSON.stringify({ toolResponse: { functionResponses: responses } });
}

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export interface InlineDataPart {
    inlineData?: { data?: string; mimeType?: string };
    text?: string;
}

export interface ServerContent {
    modelTurn?: { parts?: InlineDataPart[] };
    turnComplete?: boolean;
    interrupted?: boolean;
    generationComplete?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    interactionStatus?: "IN_PROGRESS" | "IDLE" | "REQUIRES_ACTION";
}

export interface ToolCallPayload {
    functionCalls?: { id?: string; name?: string; args?: Record<string, unknown> }[];
}

export interface ServerMessage {
    setupComplete?: Record<string, never>;
    serverContent?: ServerContent;
    toolCall?: ToolCallPayload;
    toolCallCancellation?: { ids?: string[] };
    sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
    goAway?: { timeLeft?: string };
    usageMetadata?: {
        totalTokenCount?: number;
        promptTokenCount?: number;
        responseTokenCount?: number;
    };
    voiceActivity?: { type?: string };
}

/** Parse a server text frame; tolerates keep-alive noise without throwing. */
export function parseServerMessage(raw: string): ServerMessage | undefined {
    if (!raw || raw[0] !== "{") {
        return undefined;
    }

    try {
        const parsed: unknown = JSON.parse(raw);

        return parsed && typeof parsed === "object" ? (parsed as ServerMessage) : undefined;
    } catch {
        return undefined;
    }
}

/** "1.5s" | "3s" | "" -> milliseconds. */
export function durationToMs(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }

    const match = /^([0-9.]+)s$/.exec(value.trim());

    if (!match) {
        return undefined;
    }

    return Number(match[1]) * 1000;
}
