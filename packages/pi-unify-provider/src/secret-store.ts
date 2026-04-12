import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { OAuthTokenData } from "./types.js";

export const SECRET_REF_PREFIX = "$UPSECRET:";
export const SECRET_REF_SUFFIX = "$";
export const SECRETS_PATH = join(homedir(), ".pi", "agent", "unify-provider-secrets.json");

interface SecretsFile {
  version: 1;
  apiKeys: Record<string, string>;
  oauthTokens: Record<string, OAuthTokenData>;
  oauthClientSecrets: Record<string, string>;
  generic: Record<string, string>;
}

function createEmptySecrets(): SecretsFile {
  return {
    version: 1,
    apiKeys: {},
    oauthTokens: {},
    oauthClientSecrets: {},
    generic: {},
  };
}

function extractRefId(ref: string): string | undefined {
  if (!isSecretRef(ref)) return undefined;
  return ref.slice(SECRET_REF_PREFIX.length, -SECRET_REF_SUFFIX.length);
}

export function createSecretRef(): string {
  return `${SECRET_REF_PREFIX}${randomUUID()}${SECRET_REF_SUFFIX}`;
}

export function isSecretRef(value: string | undefined): value is string {
  return !!value && value.startsWith(SECRET_REF_PREFIX) && value.endsWith(SECRET_REF_SUFFIX);
}

export type ApiKeyStatus =
  | { kind: "unset" }
  | { kind: "plain"; apiKey: string }
  | { kind: "secret"; apiKey: string; ref: string }
  | { kind: "missing-secret"; ref: string };

export class SecretStore {
  private data: SecretsFile;

  constructor() {
    this.data = this.load();
  }

  createRef(): string {
    return createSecretRef();
  }

  async getApiKeyStatus(value: string | undefined): Promise<ApiKeyStatus> {
    if (!value?.trim()) {
      return { kind: "unset" };
    }

    if (!isSecretRef(value)) {
      return { kind: "plain", apiKey: value };
    }

    const apiKey = await this.getApiKey(value);
    if (!apiKey) {
      return { kind: "missing-secret", ref: value };
    }

    return { kind: "secret", apiKey, ref: value };
  }

  async setApiKey(ref: string, value: string): Promise<void> {
    const id = extractRefId(ref);
    if (!id) throw new Error("Invalid secret ref");
    this.data.apiKeys[id] = value;
    this.save();
  }

  async getApiKey(ref: string): Promise<string | undefined> {
    const id = extractRefId(ref);
    if (!id) return undefined;
    return this.data.apiKeys[id];
  }

  async deleteApiKey(ref: string): Promise<void> {
    const id = extractRefId(ref);
    if (!id) return;
    delete this.data.apiKeys[id];
    this.save();
  }

  async setOAuthToken(ref: string, token: OAuthTokenData): Promise<void> {
    const id = extractRefId(ref);
    if (!id) throw new Error("Invalid secret ref");
    this.data.oauthTokens[id] = token;
    this.save();
  }

  async getOAuthToken(ref: string): Promise<OAuthTokenData | undefined> {
    const id = extractRefId(ref);
    if (!id) return undefined;
    return this.data.oauthTokens[id];
  }

  async deleteOAuthToken(ref: string): Promise<void> {
    const id = extractRefId(ref);
    if (!id) return;
    delete this.data.oauthTokens[id];
    this.save();
  }

  async setOAuthClientSecret(ref: string, secret: string): Promise<void> {
    const id = extractRefId(ref);
    if (!id) throw new Error("Invalid secret ref");
    this.data.oauthClientSecrets[id] = secret;
    this.save();
  }

  async getOAuthClientSecret(ref: string): Promise<string | undefined> {
    const id = extractRefId(ref);
    if (!id) return undefined;
    return this.data.oauthClientSecrets[id];
  }

  async deleteOAuthClientSecret(ref: string): Promise<void> {
    const id = extractRefId(ref);
    if (!id) return;
    delete this.data.oauthClientSecrets[id];
    this.save();
  }

  async setGenericSecret(ref: string, value: string): Promise<void> {
    const id = extractRefId(ref);
    if (!id) throw new Error("Invalid secret ref");
    this.data.generic[id] = value;
    this.save();
  }

  async getGenericSecret(ref: string): Promise<string | undefined> {
    const id = extractRefId(ref);
    if (!id) return undefined;
    return this.data.generic[id];
  }

  async deleteGenericSecret(ref: string): Promise<void> {
    const id = extractRefId(ref);
    if (!id) return;
    delete this.data.generic[id];
    this.save();
  }

  isOAuthTokenExpired(token: OAuthTokenData, bufferMs = 0): boolean {
    if (!token.expiresAt) return false;
    return Date.now() + bufferMs >= token.expiresAt;
  }

  private load(): SecretsFile {
    if (!existsSync(SECRETS_PATH)) {
      return createEmptySecrets();
    }

    try {
      const text = readFileSync(SECRETS_PATH, "utf8");
      const parsed = JSON.parse(text) as Partial<SecretsFile>;
      return {
        version: 1,
        apiKeys: parsed.apiKeys ?? {},
        oauthTokens: parsed.oauthTokens ?? {},
        oauthClientSecrets: parsed.oauthClientSecrets ?? {},
        generic: parsed.generic ?? {},
      };
    } catch {
      return createEmptySecrets();
    }
  }

  private save(): void {
    const folder = dirname(SECRETS_PATH);
    if (!existsSync(folder)) {
      mkdirSync(folder, { recursive: true });
    }
    writeFileSync(SECRETS_PATH, JSON.stringify(this.data, null, 2), "utf8");
  }
}
