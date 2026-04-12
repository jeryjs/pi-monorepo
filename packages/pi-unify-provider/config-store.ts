import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionDatabase, ProviderConfigRecord } from "./types.js";

const DB_PATH = join(homedir(), ".pi", "agent", "unify-providers-db.json");

function createEmptyDb(): ExtensionDatabase {
	return {
		version: 2,
		providers: [],
	};
}

function ensureParent(filePath: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
}

function readDb(filePath: string): ExtensionDatabase {
	if (!existsSync(filePath)) {
		return createEmptyDb();
	}
	const raw = readFileSync(filePath, "utf8");
	const parsed = JSON.parse(raw) as ExtensionDatabase;
	if (parsed.version !== 2 || !Array.isArray(parsed.providers)) {
		throw new Error(`Invalid unify provider DB format at ${filePath}`);
	}
	return parsed;
}

function writeDb(filePath: string, db: ExtensionDatabase): void {
	ensureParent(filePath);
	writeFileSync(filePath, JSON.stringify(db, null, "\t"), "utf8");
}

export class ConfigStore {
	constructor(private readonly filePath = DB_PATH) {}

	get path(): string {
		return this.filePath;
	}

	load(): ExtensionDatabase {
		return readDb(this.filePath);
	}

	save(db: ExtensionDatabase): void {
		writeDb(this.filePath, db);
	}

	getProviders(): ProviderConfigRecord[] {
		return this.load().providers;
	}

	getProvider(name: string): ProviderConfigRecord | undefined {
		return this.getProviders().find((p) => p.name === name);
	}

	replaceProviders(providers: ProviderConfigRecord[]): void {
		this.save({ version: 2, providers });
	}

	upsertProvider(provider: ProviderConfigRecord): void {
		const db = this.load();
		const next = db.providers.filter((p) => p.name !== provider.name);
		next.push(provider);
		this.save({ ...db, providers: next });
	}

	removeProvider(name: string): void {
		const db = this.load();
		const next = db.providers.filter((p) => p.name !== name);
		this.save({ ...db, providers: next });
	}
}
