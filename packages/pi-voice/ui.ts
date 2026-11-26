/**
 * Terminal feedback. The status bar is the only place the user can see whether
 * Pi is actually hearing them, so it carries a live mic level too.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const STATUS_KEY = "voice";

/** 0..~0.25 RMS -> a block. */
function blockFor(rms: number): string {
    const index = Math.min(BLOCKS.length - 1, Math.max(0, Math.round(rms * 40)));

    return BLOCKS[index];
}

/** A short moving waveform from recent RMS samples. */
export function levelBar(levels: number[]): string {
    if (levels.length === 0) {
        return "";
    }

    return levels.map(blockFor).join("");
}

export interface VoiceStatusInput {
    state: string;
    levels: number[];
    alwaysOn: boolean;
    error?: string;
    /** Mic produced nothing for a while: say so instead of leaving "asleep" unexplained. */
    silent?: boolean;
}

export function voiceStatusText(input: VoiceStatusInput): string {
    if (input.state === "live" || input.state === "sleeping" || input.state === "asleep") {
        const bar = input.state === "asleep" ? "" : levelBar(input.levels.slice(-10));
        const wake = input.alwaysOn ? " ·wake" : "";
        const silent = input.silent ? " ·no mic signal" : "";

        return `voice ${input.state}${bar ? " " + bar : ""}${wake}${silent}`;
    }

    if (input.state === "error") {
        return `voice error${input.error ? ": " + input.error.slice(0, 40) : ""}`;
    }

    return `voice ${input.state}`;
}

export function setVoiceStatus(ctx: ExtensionContext | undefined, text: string | undefined): void {
    try {
        ctx?.ui.setStatus(STATUS_KEY, text);
    } catch {
        // status bar may not exist in every mode
    }
}