/**
 * One voice session per workspace, across processes.
 *
 * A lock file records the owning PID (and page URL in browser mode). A second Pi
 * process in the same project refuses to start a duplicate Live session instead
 * of opening a second microphone/socket. Stale locks (dead PID) are taken over.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir } from "./keychain.ts";

export interface VoiceLock {
    pid: number;
    cwd: string;
    startedAt: string;
    url?: string;
}

function lockPath(cwd: string): string {
    const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 16);

    return join(agentDir(), `pi-voice-${hash}.lock`);
}

function isAlive(pid: number): boolean {
    if (pid === process.pid) {
        return true;
    }

    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        // EPERM means the process exists but we cannot signal it.
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

export function readLock(cwd: string): VoiceLock | undefined {
    try {
        const parsed: unknown = JSON.parse(readFileSync(lockPath(cwd), "utf8"));

        if (!parsed || typeof parsed !== "object") {
            return undefined;
        }

        const lock = parsed as VoiceLock;

        return typeof lock.pid === "number" ? lock : undefined;
    } catch {
        return undefined;
    }
}

export type AcquireResult =
    | { ok: true }
    | { ok: false; lock: VoiceLock };

export function acquireLock(cwd: string): AcquireResult {
    const existing = readLock(cwd);

    if (existing && existing.pid !== process.pid && isAlive(existing.pid)) {
        return { ok: false, lock: existing };
    }

    writeLock(cwd, existing);

    return { ok: true };
}

function writeLock(cwd: string, previous?: VoiceLock): void {
    const path = lockPath(cwd);
    const lock: VoiceLock = {
        pid: process.pid,
        cwd,
        startedAt: new Date().toISOString(),
        ...(previous?.pid === process.pid && previous.url ? { url: previous.url } : {}),
    };

    try {
        mkdirSync(dirname(path), { recursive: true });
        const temporary = `${path}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
        renameSync(temporary, path);
    } catch {
        // The lock is advisory; a read-only directory should not block voice.
    }
}

/** Record the page URL (browser transport) so a second process can point at it. */
export function updateLockUrl(cwd: string, url: string | undefined): void {
    const existing = readLock(cwd);

    if (!existing || existing.pid !== process.pid) {
        return;
    }

    try {
        const path = lockPath(cwd);
        const temporary = `${path}.tmp`;
        writeFileSync(temporary, `${JSON.stringify({ ...existing, url }, null, 2)}\n`, "utf8");
        renameSync(temporary, path);
    } catch {
        // ignore
    }
}

export function releaseLock(cwd: string): void {
    const existing = readLock(cwd);

    if (!existing || existing.pid !== process.pid) {
        return;
    }

    try {
        unlinkSync(lockPath(cwd));
    } catch {
        // ignore
    }
}