/**
 * One voice session per workspace, across processes.
 *
 * A lock file records the owning PID. A second Pi
 * process in the same project refuses to start a duplicate Live session instead
 * of opening a second microphone/socket. Stale locks (dead PID) are taken over.
 */

import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir } from "./keychain.ts";

export interface VoiceLock {
    pid: number;
    cwd: string;
    startedAt: string;
    /** Random per-run id: PID alone is not proof of ownership (PIDs get reused). */
    token?: string;
}

/** Stable for the life of this process, so update/release always match. */
const PROCESS_LOCK_TOKEN = randomBytes(8).toString("hex");

/** A lock older than this is taken over even if the PID still exists (reuse). */
const STALE_AFTER_MS = 12 * 60 * 60_000;

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

function isOurs(lock: VoiceLock | undefined): boolean {
    return Boolean(lock && lock.pid === process.pid && lock.token === PROCESS_LOCK_TOKEN);
}

function isStale(lock: VoiceLock): boolean {
    const started = Date.parse(lock.startedAt ?? "");

    return !Number.isFinite(started) || Date.now() - started > STALE_AFTER_MS;
}

export type AcquireResult =
    | { ok: true }
    | { ok: false; lock: VoiceLock };

export function acquireLock(cwd: string): AcquireResult {
    const path = lockPath(cwd);

    try {
        mkdirSync(dirname(path), { recursive: true });
    } catch {
        // a read-only directory must not block voice; the lock is advisory
    }

    // Exclusive create first: two processes starting at the same moment cannot
    // both observe "no lock" and then both write one.
    try {
        const fd = openSync(path, "wx");
        closeSync(fd);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            // Cannot inspect or create (permissions); treat as available.
            writeLock(cwd);

            return { ok: true };
        }
    }

    const existing = readLock(cwd);

    if (
        existing
        && !isOurs(existing)
        && existing.pid !== process.pid
        && isAlive(existing.pid)
        && !isStale(existing)
    ) {
        return { ok: false, lock: existing };
    }

    writeLock(cwd);

    return { ok: true };
}

function writeLock(cwd: string): void {
    const path = lockPath(cwd);
    const lock: VoiceLock = {
        pid: process.pid,
        cwd,
        startedAt: new Date().toISOString(),
        token: PROCESS_LOCK_TOKEN,
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

export function releaseLock(cwd: string): void {
    const existing = readLock(cwd);

    if (!isOurs(existing)) {
        return;
    }

    try {
        unlinkSync(lockPath(cwd));
    } catch {
        // ignore
    }
}