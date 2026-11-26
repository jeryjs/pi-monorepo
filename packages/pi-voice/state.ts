/**
 * Session-bound voice state.
 *
 * The Gemini resumption handle is persisted as a custom session entry so a
 * restarted Pi process can rejoin the *same* logical voice conversation
 * (tokens stay valid for 2 hours after the previous session ends).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { log } from "./util.ts";

export const VOICE_STATE_ENTRY = "voice.state";

export interface VoiceSessionState {
    /** Last Gemini session-resumption handle. */
    handle?: string;
    /** Pi session id this handle belongs to. */
    sessionId?: string;
    updatedAt?: string;
    /** Last selection, mirrored for convenience. */
    model?: string;
    voice?: string;
}

function entriesOf(ctx: ExtensionContext): unknown[] {
    const manager = ctx.sessionManager as unknown as {
        getBranch?: () => unknown[];
        getEntries?: () => unknown[];
        getMessages?: () => unknown[];
        entries?: unknown[];
    };

    try {
        if (typeof manager.getBranch === "function") {
            return manager.getBranch() ?? [];
        }

        if (typeof manager.getEntries === "function") {
            return manager.getEntries() ?? [];
        }

        if (Array.isArray(manager.entries)) {
            return manager.entries;
        }
    } catch (error) {
        log("state", "cannot read session entries", error);
    }

    return [];
}

function dataOf(entry: unknown): VoiceSessionState | undefined {
    if (!entry || typeof entry !== "object") {
        return undefined;
    }

    const record = entry as { customType?: unknown; type?: unknown; data?: unknown };

    if (record.customType !== VOICE_STATE_ENTRY) {
        return undefined;
    }

    return record.data && typeof record.data === "object" ? (record.data as VoiceSessionState) : undefined;
}

export function readVoiceState(ctx: ExtensionContext): VoiceSessionState {
    const entries = entriesOf(ctx);

    for (let i = entries.length - 1; i >= 0; i--) {
        const state = dataOf(entries[i]);

        if (state) {
            return state;
        }
    }

    return {};
}

export function persistVoiceState(pi: ExtensionAPI, state: VoiceSessionState): void {
    try {
        pi.appendEntry(VOICE_STATE_ENTRY, { ...state, updatedAt: new Date().toISOString() });
    } catch (error) {
        log("state", "appendEntry failed", error);
    }
}