/**
 * Builds the `setup` message for a Live session from config + capabilities.
 *
 * Every field is filtered through the model capability table, so switching to a
 * smaller/preview model never sends a field it would reject.
 *
 * The object is rebuilt on every connect (not once) so callers can degrade
 * features — e.g. drop Google Search grounding after a quota refusal — and have
 * the retry pick it up.
 */

import type { ModelCapabilities } from "../capabilities.ts";
import { normalizeModelId } from "../capabilities.ts";
import type { VoiceConfig } from "../config.ts";
import type { FunctionDeclaration } from "./protocol.ts";

export interface SetupInput {
    config: VoiceConfig;
    capabilities: ModelCapabilities;
    systemInstruction: string;
    tools: FunctionDeclaration[];
}

type Json = Record<string, unknown>;

function thinkingConfig(config: VoiceConfig, capabilities: ModelCapabilities): Json | undefined {
    if (capabilities.thinking === "none") {
        return undefined;
    }

    if (capabilities.thinking === "budget") {
        return config.thinkingBudget > 0 ? { thinkingBudget: Math.round(config.thinkingBudget) } : undefined;
    }

    // "level" and "interleaved" both accept thinkingLevel on current models.
    // Extended-thinking models reject setup unless a level is supplied.
    const level = config.thinkingLevel || (capabilities.thinkingRequired ? "low" : "");

    return level ? { thinkingLevel: level } : undefined;
}

function speechConfig(config: VoiceConfig): Json {
    const voiceConfig: Json = { prebuiltVoiceConfig: { voiceName: config.voice } };
    const speech: Json = { voiceConfig };

    if (config.language) {
        speech.languageCode = config.language;
    }

    return speech;
}

function transcription(config: VoiceConfig): Json {
    const base: Json = {};

    if (config.language) {
        base.languageCodes = [config.language];
    }

    if (config.customVocabulary.length > 0) {
        base.customVocabulary = config.customVocabulary;
    }

    return base;
}

function build(input: SetupInput, handle: string | undefined): Json {
    const { config, capabilities } = input;

    const generationConfig: Json = {
        responseModalities: ["AUDIO"],
        temperature: config.temperature,
        speechConfig: speechConfig(config),
        // Lower media resolution keeps vision cheap when screen share is used.
        mediaResolution: "MEDIA_RESOLUTION_LOW",
    };

    if (config.affectiveDialog && capabilities.affectiveDialog !== false) {
        generationConfig.enableAffectiveDialog = true;
    }

    const thinking = thinkingConfig(config, capabilities);

    if (thinking) {
        generationConfig.thinkingConfig = thinking;
    }

    const tools: Json[] = [];

    if (input.tools.length > 0) {
        tools.push({ functionDeclarations: input.tools });
    }

    if (config.searchGrounding && capabilities.searchGrounding) {
        tools.push({ googleSearch: {} });
    }

    const setup: Json = {
        model: "models/" + normalizeModelId(config.model),
        generationConfig,
        systemInstruction: { parts: [{ text: input.systemInstruction }] },
        // Sliding-window compression removes the 15-minute audio-session cap.
        contextWindowCompression: { slidingWindow: {} },
        realtimeInputConfig: {
            automaticActivityDetection: {
                disabled: false,
                prefixPaddingMs: Math.round(config.vadPrefixMs),
                silenceDurationMs: Math.round(config.vadSilenceMs),
                startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
                endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
            },
            activityHandling: config.bargeIn ? "START_OF_ACTIVITY_INTERRUPTS" : "NO_INTERRUPTION",
            turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
        },
    };

    if (tools.length > 0) {
        setup.tools = tools;
    }

    if (config.inputTranscription) {
        setup.inputAudioTranscription = transcription(config);
    }

    if (config.outputTranscription) {
        setup.outputAudioTranscription = {};
    }

    if (config.proactiveAudio || config.proactiveVideo) {
        setup.proactivity = {
            ...(config.proactiveAudio ? { proactiveAudio: true } : {}),
            ...(config.proactiveVideo ? { proactiveVideo: true } : {}),
        };
    }

    // Always declare resumption: the server only starts emitting handles once the
    // session has activity, so a session that connects and stays quiet used to
    // persist nothing at all.
    setup.sessionResumption = handle ? { handle } : {};

    return setup;
}

/** Returns a builder so the session can pass its current resumption handle. */
export function createSetupBuilder(input: SetupInput): (handle: string | undefined) => Json {
    return (handle) => build(input, handle);
}