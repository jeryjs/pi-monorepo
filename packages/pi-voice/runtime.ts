/** Shared surface between the `/voice` command and its settings TUI. */

import type { VoiceConfig } from "./config.ts";
import type { VoiceController } from "./controller.ts";

export interface VoiceRuntime {
    getConfig(): VoiceConfig;
    patch(patch: Partial<VoiceConfig>): VoiceConfig;
    controller(): VoiceController | undefined;
    start(): Promise<void>;
    stop(): Promise<void>;
    /** Open a real Live socket per model and report what the server says. */
    diagnose(): Promise<string>;
}