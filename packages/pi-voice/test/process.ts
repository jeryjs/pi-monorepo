/**
 * Process-lifetime tests for the audio transport.
 *
 * The bug these exist for: `child.kill()` only signals the process Node spawned.
 * On Windows that is usually a shim (chocolatey's `ffmpeg.exe` launches the real
 * `ffmpeg.exe` as its own child), so killing it orphaned the real binary with the
 * microphone still open. Every `/voice off` and every settings-driven restart
 * leaked another ffmpeg/ffplay pair, and the next start failed with "device busy".
 *
 * These tests spawn a real parent → grandchild chain and assert both are gone, so
 * they fail on Windows if `killTree` stops using a tree-aware kill. They use
 * `node` itself as the payload, so they need no ffmpeg.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { killAllManaged, killTree, managedPids, spawnManaged } from "../audio/process.ts";

let passed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    await fn();
    passed++;
    console.log("  ok  " + name);
}

/** A parent node process that itself spawns a long-lived grandchild. */
function spawnChain(): { parent: ReturnType<typeof spawnManaged>; grandchildPid: number } {
    const script = `
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
        console.log(JSON.stringify({ grandchild: child.pid }));
        setTimeout(() => {}, 60000);
    `;
    const parent = spawnManaged(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    return { parent, grandchildPid: -1 };
}

function alive(pid: number): boolean {
    if (!Number.isFinite(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return predicate();
}

// ---------------------------------------------------------------------------

await test("spawnManaged tracks the child and forgets it once it exits", async () => {
    const child = spawnManaged(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { stdio: "ignore" });

    assert.ok(typeof child.pid === "number" && child.pid > 0, "expected a pid");
    assert.ok(managedPids().includes(child.pid as number), "child should be tracked");

    await waitFor(() => !managedPids().includes(child.pid as number));
    assert.equal(managedPids().includes(child.pid as number), false, "child should be untracked after exit");
});

await test("killTree takes the grandchildren too", async () => {
    const { parent } = spawnChain();

    // Read the grandchild pid the parent printed.
    let buffer = "";
    const grandchildPid = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no grandchild pid; saw ${JSON.stringify(buffer)}`)), 8000);

        parent.stdout?.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();

            const match = buffer.match(/\{"grandchild":(\d+)\}/);

            if (match) {
                clearTimeout(timer);
                resolve(Number(match[1]));
            }
        });
    });

    assert.ok(alive(parent.pid as number), "parent should be running");
    assert.ok(alive(grandchildPid), `grandchild ${grandchildPid} should be running`);

    killTree(parent);

    assert.equal(
        await waitFor(() => !alive(parent.pid as number) && !alive(grandchildPid)),
        true,
        `parent ${parent.pid} / grandchild ${grandchildPid} should both be gone`,
    );
});

await test("killAllManaged clears the registry and every child", async () => {
    const first = spawnManaged(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const second = spawnManaged(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });

    assert.equal(managedPids().length >= 2, true, "both children should be tracked");

    killAllManaged();

    assert.deepEqual(managedPids(), [], "registry should be empty");
    assert.equal(await waitFor(() => !alive(first.pid as number) && !alive(second.pid as number)), true, "both should be gone");
});

await test("killTree on an already-exited child is a no-op", () => {
    const child = spawnManaged(process.execPath, ["-e", "0"], { stdio: "ignore" });

    assert.doesNotThrow(() => killTree(child));
    assert.doesNotThrow(() => killTree(child));
});

// ---------------------------------------------------------------------------

killAllManaged();

console.log(`\n${passed} process checks passed`);
