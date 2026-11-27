/**
 * Gemini API key resolution, mirroring Pi's own provider order:
 *
 *   explicit config  ->  auth.json (`google`)  ->  environment  ->  Pi registry
 *
 * Pi stores API-key providers in `~/.pi/agent/auth.json` as
 * `{ "<provider>": { "type": "api_key", "key": "..." } }` and only falls back to
 * the provider's env var (GEMINI_API_KEY for `google`). We reproduce that so
 * pi-voice works with the key the user already configured in Pi.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ResolvedKey {
    key: string;
    /** Where it came from, safe to show in status output. */
    source: string;
}

const AUTH_PROVIDERS = ["google", "google-generative-ai", "google-genai"] as const;
const ENV_VARS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_GENAI_API_KEY"] as const;

export function agentDir(): string {
    return process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function authJsonPath(): string {
    return process.env.PI_VOICE_AUTH || process.env.PI_AUTH_FILE || join(agentDir(), "auth.json");
}

interface CredentialShape {
    type?: unknown;
    key?: unknown;
}

/** Read the first usable API key from Pi's auth.json. */
export function readKeyFromAuthJson(path = authJsonPath()): ResolvedKey | undefined {
    let parsed: unknown;

    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return undefined;
    }

    if (!parsed || typeof parsed !== "object") {
        return undefined;
    }

    const data = parsed as Record<string, unknown>;

    for (const provider of AUTH_PROVIDERS) {
        const credential = data[provider];

        if (!credential || typeof credential !== "object") {
            continue;
        }

        const { type, key } = credential as CredentialShape;

        // OAuth credentials (google-antigravity, google-gemini-cli) are not API keys.
        if (type !== undefined && type !== "api_key") {
            continue;
        }

        if (typeof key === "string" && key.trim()) {
            return { key: key.trim(), source: `auth.json (${provider})` };
        }
    }

    return undefined;
}

export function readKeyFromEnv(env: NodeJS.ProcessEnv = process.env): ResolvedKey | undefined {
    for (const name of ENV_VARS) {
        const value = env[name];

        if (value && value.trim()) {
            return { key: value.trim(), source: `env ${name}` };
        }
    }

    return undefined;
}

export interface KeyRegistry {
    getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
}

export interface ResolveOptions {
    /** Explicit key from pi-voice config (highest priority). */
    configKey?: string;
    registry?: KeyRegistry;
    authPath?: string;
}

/** Resolve in Pi's order; returns the source so status output can explain it. */
export async function resolveGeminiKey(options: ResolveOptions = {}): Promise<ResolvedKey | undefined> {
    const explicit = options.configKey?.trim();

    if (explicit) {
        return { key: explicit, source: "config" };
    }

    const stored = readKeyFromAuthJson(options.authPath);

    if (stored) {
        return stored;
    }

    const env = readKeyFromEnv();

    if (env) {
        return env;
    }

    // Last resort: ask Pi's registry (it may resolve OAuth or a computed key).
    for (const provider of AUTH_PROVIDERS) {
        try {
            const key = await options.registry?.getApiKeyForProvider?.(provider);

            if (key && key.trim()) {
                return { key: key.trim(), source: `pi provider ${provider}` };
            }
        } catch {
            // provider not configured; try the next id
        }
    }

    return undefined;
}
/**
 * Explain where the key would come from, without starting voice.
 *
 * `/voice key` and `/voice status` reported the *controller's* last resolution, so
 * with voice off they answered "not resolved" even though a key sat in auth.json —
 * the exact case where the user asks because a start just failed.
 */
export function keySourceLabel(configKey: string, controllerSource?: string): string {
    if (configKey.trim()) {
        return "config (pi-voice.json)";
    }

    if (controllerSource) {
        return controllerSource;
    }

    const stored = readKeyFromAuthJson();

    if (stored) {
        return stored.source;
    }

    const env = readKeyFromEnv();

    if (env) {
        return env.source;
    }

    return "not resolved (no key in pi-voice.json, auth.json or the environment; Pi's provider registry is only asked when voice starts)";
}
