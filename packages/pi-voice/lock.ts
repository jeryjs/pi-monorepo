/**
 * One voice session per workspace, across processes.
 *
 * A lock file records the owning PID. A second Pi
 * process in the same project refuses to start a duplicate Live session instead
 * of opening a second microphone/socket. Stale locks (dead PID) are taken over.
 */

import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
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
    | { ok: false; lock: VoiceLock; reason: "busy" | "unwritable" };

/** How long a takeover claim is trusted before another process may steal it. */
const CLAIM_TTL_MS = 5000;

function claimPath(cwd: string): string {
    return `${lockPath(cwd)}.claim`;
}

/**
 * Serialise stale-lock takeover.
 *
 * Exclusive creation only protects the "no lock yet" case. Taking over a stale
 * lock used to be read-modify-write through one shared temp file, so two Pi
 * processes starting together both read the stale entry, both wrote, and both were
 * told they owned the workspace — two sockets and two microphones, which is what
 * the lock exists to prevent.
 */
function acquireClaim(cwd: string): boolean {
    const path = claimPath(cwd);

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = openSync(path, "wx");
            closeSync(fd);

            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                // Cannot use a claim file here (permissions); the lock stays advisory.
                return true;
            }
        }

        // Someone else is mid-takeover. A crashed process leaves the claim behind, so
        // an ancient one is broken and retried once.
        if (attempt === 0) {
            try {
                const age = Date.now() - statSync(path).mtimeMs;

                if (age <= CLAIM_TTL_MS) {
                    return false;
                }

                unlinkSync(path);
                continue;
            } catch {
                return false;
            }
        }

        return false;
    }

    return false;
}

function releaseClaim(cwd: string): void {
    try {
        unlinkSync(claimPath(cwd));
    } catch {
        // already gone
    }
}

export function acquireLock(cwd: string): AcquireResult {
    const path = lockPath(cwd);

    try {
        mkdirSync(dirname(path), { recursive: true });
    } catch {
        // a read-only directory must not block voice; the lock is advisory
    }

    // Exclusive create first: two processes starting at the same moment cannot
    // both observe "no lock" and then both write one.
    let created = false;

    try {
        const fd = openSync(path, "wx");
        closeSync(fd);
        created = true;
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
        return { ok: false, lock: existing, reason: "busy" };
    }

    if (created) {
        return writeLock(cwd) ? { ok: true } : { ok: false, lock: existing ?? selfLock(cwd), reason: "unwritable" };
    }

    // Stale, empty or ours: take it over under a claim, then confirm the write won.
    if (!acquireClaim(cwd)) {
        const winner = readLock(cwd);

        return { ok: false, lock: winner ?? existing ?? selfLock(cwd), reason: "busy" };
    }

    try {
        const again = readLock(cwd);

        if (again && !isOurs(again) && again.pid !== process.pid && isAlive(again.pid) && !isStale(again)) {
            return { ok: false, lock: again, reason: "busy" };
        }

        if (!writeLock(cwd)) {
            return { ok: false, lock: again ?? existing ?? selfLock(cwd), reason: "unwritable" };
        }

        const written = readLock(cwd);

        return isOurs(written)
            ? { ok: true }
            : { ok: false, lock: written ?? again ?? selfLock(cwd), reason: "busy" };
    } finally {
        releaseClaim(cwd);
    }
}

/** A lock belonging to this process, for error messages when there is no other. */
function selfLock(cwd: string): VoiceLock {
    return { pid: process.pid, cwd, startedAt: new Date().toISOString(), token: PROCESS_LOCK_TOKEN };
}

/** Write the lock atomically (unique temp name). Returns false only on real failure. */
function writeLock(cwd: string): boolean {
    const path = lockPath(cwd);
    const lock = selfLock(cwd);
    // A shared `${path}.tmp` was the second half of the takeover race: two writers
    // clobbered the same temporary file, one rename failed, and the failure was
    // swallowed while both callers were told they held the lock.
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;

    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(temporary, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
        renameSync(temporary, path);

        return true;
    } catch (error) {
        try {
            unlinkSync(temporary);
        } catch {
            // ignore
        }

        const code = (error as NodeJS.ErrnoException).code;

        // A read-only agent directory cannot hold a lock at all. Reporting it as
        // "busy" would be a lie, so the caller gets a distinct reason.
        return false;
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