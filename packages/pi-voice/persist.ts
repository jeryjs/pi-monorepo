/**
 * File-backed resumption state.
 *
 * Session entries disappear with `--no-session` and may be unavailable after a
 * restart, so the latest handle is also written to the agent directory, keyed by
 * workspace. Resumption tokens are valid for two hours after a session ends.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir } from "./keychain.ts";

export interface PersistedVoiceState {
    handle?: string;
    model?: string;
    voice?: string;
    cwd?: string;
    updatedAt?: string;
}

const FILE = "pi-voice-state.json";
const TTL_MS = 2 * 60 * 60_000;

function statePath(): string {
    return process.env.PI_VOICE_STATE || join(agentDir(), FILE);
}

function keyFor(cwd: string): string {
    return createHash("sha1").update(cwd).digest("hex").slice(0, 16);
}

function readAll(): Record<string, PersistedVoiceState> {
    try {
        const parsed: unknown = JSON.parse(readFileSync(statePath(), "utf8"));

        return parsed && typeof parsed === "object" ? (parsed as Record<string, PersistedVoiceState>) : {};
    } catch {
        return {};
    }
}

function writeAll(data: Record<string, PersistedVoiceState>): void {
    const path = statePath();

    try {
        mkdirSync(dirname(path), { recursive: true });
        const temporary = `${path}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
        renameSync(temporary, path);
    } catch {
        // A read-only agent directory must not break voice.
    }
}

export function loadPersistedHandle(cwd: string): PersistedVoiceState | undefined {
    const entry = readAll()[keyFor(cwd)];

    if (!entry?.handle) {
        return undefined;
    }

    if (entry.cwd && entry.cwd !== cwd) {
        return undefined;
    }

    const age = entry.updatedAt ? Date.now() - Date.parse(entry.updatedAt) : Number.POSITIVE_INFINITY;

    if (!Number.isFinite(age) || age > TTL_MS) {
        return undefined;
    }

    return entry;
}

export function savePersistedHandle(cwd: string, state: Omit<PersistedVoiceState, "cwd" | "updatedAt">): void {
    const data = readAll();
    const key = keyFor(cwd);
    const previous = data[key];

    // Do not let a late write from an older connection overwrite a newer handle.
    if (previous?.handle && previous.handle !== state.handle && previous.updatedAt) {
        const age = Date.now() - Date.parse(previous.updatedAt);

        if (Number.isFinite(age) && age < 1500) {
            return;
        }
    }

    data[key] = { ...state, cwd, updatedAt: new Date().toISOString() };
    writeAll(data);
}

export function clearPersistedHandle(cwd: string): void {
    const data = readAll();
    const key = keyFor(cwd);

    if (key in data) {
        delete data[key];
        writeAll(data);
    }
}