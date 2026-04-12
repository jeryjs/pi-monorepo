import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { OAuth2TokenData, SecretsDatabase } from "./types.ts";

export const SECRET_REF_PREFIX = "$UPSECRET:";
export const SECRET_REF_SUFFIX = "$";

const SECRETS_PATH = join(homedir(), ".pi", "agent", "unify-provider-secrets.json");

function createEmptySecrets(): SecretsDatabase {
	return {
		version: 1,
		apiKeys: {},
		oauthTokens: {},
		generic: {},
	};
}

function ensureParent(filePath: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
}

function readSecrets(filePath: string): SecretsDatabase {
	if (!existsSync(filePath)) {
		return createEmptySecrets();
	}
	const raw = readFileSync(filePath, "utf8");
	const parsed = JSON.parse(raw) as SecretsDatabase;
	if (parsed.version !== 1) {
		throw new Error(`Invalid secret store format at ${filePath}`);
	}
	return parsed;
}

function writeSecrets(filePath: string, secrets: SecretsDatabase): void {
	ensureParent(filePath);
	writeFileSync(filePath, JSON.stringify(secrets, null, "\t"), "utf8");
}

function extractRefId(ref: string): string | undefined {
	if (!isSecretRef(ref)) return undefined;
	return ref.slice(SECRET_REF_PREFIX.length, -SECRET_REF_SUFFIX.length);
}

export function isSecretRef(value: string): boolean {
	return value.startsWith(SECRET_REF_PREFIX) && value.endsWith(SECRET_REF_SUFFIX);
}

export function createSecretRef(): string {
	return `${SECRET_REF_PREFIX}${randomUUID()}${SECRET_REF_SUFFIX}`;
}

export class SecretStore {
	private readonly filePath: string;

	constructor(filePath = SECRETS_PATH) {
		this.filePath = filePath;
	}

	private load(): SecretsDatabase {
		return readSecrets(this.filePath);
	}

	private save(secrets: SecretsDatabase): void {
		writeSecrets(this.filePath, secrets);
	}

	createRef(): string {
		return createSecretRef();
	}

	setApiKey(ref: string, value: string): void {
		const id = extractRefId(ref);
		if (!id) throw new Error("Invalid API key secret ref");
		const db = this.load();
		db.apiKeys[id] = value;
		this.save(db);
	}

	getApiKey(ref: string): string | undefined {
		const id = extractRefId(ref);
		if (!id) return undefined;
		return this.load().apiKeys[id];
	}

	deleteApiKey(ref: string): void {
		const id = extractRefId(ref);
		if (!id) return;
		const db = this.load();
		delete db.apiKeys[id];
		this.save(db);
	}

	setOAuthToken(ref: string, token: OAuth2TokenData): void {
		const id = extractRefId(ref);
		if (!id) throw new Error("Invalid OAuth token ref");
		const db = this.load();
		db.oauthTokens[id] = token;
		this.save(db);
	}

	getOAuthToken(ref: string): OAuth2TokenData | undefined {
		const id = extractRefId(ref);
		if (!id) return undefined;
		return this.load().oauthTokens[id];
	}

	deleteOAuthToken(ref: string): void {
		const id = extractRefId(ref);
		if (!id) return;
		const db = this.load();
		delete db.oauthTokens[id];
		this.save(db);
	}

	setGeneric(ref: string, value: string): void {
		const id = extractRefId(ref);
		if (!id) throw new Error("Invalid generic secret ref");
		const db = this.load();
		db.generic[id] = value;
		this.save(db);
	}

	getGeneric(ref: string): string | undefined {
		const id = extractRefId(ref);
		if (!id) return undefined;
		return this.load().generic[id];
	}

	deleteGeneric(ref: string): void {
		const id = extractRefId(ref);
		if (!id) return;
		const db = this.load();
		delete db.generic[id];
		this.save(db);
	}
}
