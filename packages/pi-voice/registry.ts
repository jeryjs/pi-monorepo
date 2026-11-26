/**
 * Process-wide controller registry.
 *
 * `/reload` disposes the extension module but not the process, so the live
 * controller (and its Gemini socket) is kept on `globalThis` and reclaimed by the
 * reloaded module. That is what makes `/reload` continue the same voice session
 * instead of resuming an already-closed one (or opening a duplicate).
 */

import type { VoiceController } from "./controller.ts";

interface Entry {
    cwd: string;
    controller: VoiceController;
}

const store = globalThis as unknown as { __piVoiceControllers?: Map<string, Entry> };

function registry(): Map<string, Entry> {
    store.__piVoiceControllers ??= new Map();

    return store.__piVoiceControllers;
}

export function getController(cwd: string): VoiceController | undefined {
    return registry().get(cwd)?.controller;
}

export function setController(cwd: string, controller: VoiceController): void {
    registry().set(cwd, { cwd, controller });
}

export function removeController(cwd: string, controller?: VoiceController): void {
    const entry = registry().get(cwd);

    if (!entry || (controller && entry.controller !== controller)) {
        return;
    }

    registry().delete(cwd);
}