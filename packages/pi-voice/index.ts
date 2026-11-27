export { default } from "./extension.ts";
export { VoiceController } from "./controller.ts";
export { DEFAULT_VOICE_CONFIG, loadVoiceConfig, saveVoiceConfig, patchVoiceConfig } from "./config.ts";
export type { VoiceConfig, WakeEngine, Autonomy } from "./config.ts";
export { capabilitiesFor, describeModels, liveModelIds } from "./capabilities.ts";
export { completeVoiceArguments } from "./completions.ts";
export { PREBUILT_VOICES } from "./voices.ts";
export { resolveGeminiKey, readKeyFromAuthJson } from "./keychain.ts";