/**
 * Child-process lifetime for the audio transport.
 *
 * `child.kill()` only signals the process Node spawned. On Windows that is often
 * a shim (a chocolatey/`scoop`/winget wrapper named `ffmpeg.exe` that launches
 * the real `ffmpeg.exe` as its own child), so killing it orphaned the real
 * process with the microphone still open: ffmpeg/ffplay accumulated after every
 * `/voice off`, `/voice restart` and settings change, and the next start hit
 * "device busy".
 *
 * Everything the transport spawns is therefore (a) spawned with its own process
 * group on POSIX, (b) killed as a tree, and (c) registered here so a crash or an
 * unexpected exit still reaps it.
 */

import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

/** Pids we spawned and have not confirmed dead yet. */
const managed = new Map<number, ChildProcess>();

let exitHookInstalled = false;

function installExitHook(): void {
    if (exitHookInstalled) {
        return;
    }

    exitHookInstalled = true;

    // Synchronous: an async kill would not be awaited by "exit". This is the net
    // that catches a Pi crash or a `/reload` that drops the transport.
    process.once("exit", () => {
        for (const child of managed.values()) {
            killTree(child);
        }
    });
}

/**
 * Spawn a long-lived child with the house rules applied:
 *
 * - POSIX: `detached` puts the child in its own process group so the whole group
 *   can be signalled at once (ffmpeg spawns threads, not children, but shims do
 *   spawn children).
 * - Windows: left attached; tree removal goes through `taskkill /T`.
 * - Tracked, so `killAllManaged()` and the `exit` hook can reap it.
 */
export function spawnManaged(
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
    installExitHook();

    const child = spawn(command, args, {
        ...options,
        // A new process group is what makes the POSIX group kill possible. On
        // Windows `detached` would instead create a new console (and break the
        // console-signal behaviour we rely on), so it stays attached there.
        detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;

    if (typeof child.pid === "number") {
        managed.set(child.pid, child);
        child.once("close", () => managed.delete(child.pid as number));
        child.once("error", () => managed.delete(child.pid as number));
    }

    return child;
}

/**
 * Stop tracking a child without killing it (the caller already reaped it).
 */
export function forgetManaged(child: ChildProcess): void {
    if (typeof child.pid === "number") {
        managed.delete(child.pid);
    }
}

/**
 * Kill a child *and everything it spawned*, best-effort and synchronously.
 *
 * Windows: `taskkill /T /F` walks the live tree, which is the only way to reach a
 * grandchild that Node has no handle on. POSIX: signal the process group.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
    const pid = child.pid;

    if (typeof pid !== "number" || child.exitCode !== null || child.signalCode !== null) {
        forgetManaged(child);

        return;
    }

    if (process.platform === "win32") {
        try {
            spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
                timeout: 10_000,
            });
        } catch {
            // taskkill missing or refused: fall back to the direct signal below.
        }
    } else {
        try {
            // Negative pid = the whole process group (see spawnManaged's `detached`).
            process.kill(-pid, signal);

            return;
        } catch {
            // No group (spawned elsewhere, or already reaped): signal the child.
        }
    }

    try {
        child.kill(signal);
    } catch {
        // already gone
    }
}

/** Pids still tracked. Used by the leak test and `/voice status`. */
export function managedPids(): number[] {
    return [...managed.keys()];
}

/** Reap every tracked child. Called by the exit hook and by tests. */
export function killAllManaged(): void {
    for (const child of [...managed.values()]) {
        killTree(child);
    }

    managed.clear();
}
