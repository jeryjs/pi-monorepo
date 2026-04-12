import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ModelConfig, ProviderConfig, ProvidersDatabase } from "./types.js";

export const DB_PATH = join(homedir(), ".pi", "agent", "unify-providers-db.json");

type ChangeListener = () => void;

function now() {
  return Date.now();
}

export class ConfigStore {
  private db: ProvidersDatabase;
  private listeners: ChangeListener[] = [];

  constructor() {
    this.db = this.load();
  }

  getProvider(name: string): ProviderConfig | undefined {
    return this.db.providers[name];
  }

  getAllProviders(): ProviderConfig[] {
    return Object.values(this.db.providers);
  }

  getProviderNames(): string[] {
    return Object.keys(this.db.providers);
  }

  hasProvider(name: string): boolean {
    return !!this.db.providers[name];
  }

  upsertProvider(provider: ProviderConfig): ProviderConfig {
    const normalizedName = provider.name.trim();
    const existing = this.db.providers[normalizedName];

    const next: ProviderConfig = {
      ...provider,
      name: normalizedName,
      createdAt: existing?.createdAt ?? provider.createdAt ?? now(),
      updatedAt: now(),
    };

    this.db.providers[normalizedName] = next;
    this.save();
    this.notifyChange();
    return next;
  }

  removeProvider(name: string): boolean {
    if (!this.db.providers[name]) {
      return false;
    }
    delete this.db.providers[name];
    this.save();
    this.notifyChange();
    return true;
  }

  updateProvider(name: string, patch: Partial<ProviderConfig>): ProviderConfig | undefined {
    const current = this.db.providers[name];
    if (!current) {
      return undefined;
    }

    const merged: ProviderConfig = {
      ...current,
      ...patch,
      name: patch.name?.trim() || current.name,
      createdAt: current.createdAt,
      updatedAt: now(),
    };

    if (merged.name !== name) {
      delete this.db.providers[name];
    }

    this.db.providers[merged.name] = merged;
    this.save();
    this.notifyChange();
    return merged;
  }

  setProviderModels(name: string, models: ModelConfig[]): ProviderConfig | undefined {
    return this.updateProvider(name, {
      models,
      lastFetchTime: now(),
      lastFetchError: undefined,
    });
  }

  markFetchError(name: string, message: string): ProviderConfig | undefined {
    return this.updateProvider(name, {
      lastFetchTime: now(),
      lastFetchError: message,
    });
  }

  importJson(raw: string): { success: boolean; count: number; error?: string } {
    try {
      const parsed = JSON.parse(raw) as Partial<ProvidersDatabase>;
      if (!parsed || typeof parsed !== "object" || !parsed.providers || typeof parsed.providers !== "object") {
        return { success: false, count: 0, error: "Invalid format: providers object missing" };
      }

      let count = 0;
      for (const provider of Object.values(parsed.providers as Record<string, ProviderConfig>)) {
        if (!provider?.name?.trim()) {
          continue;
        }
        this.upsertProvider({
          ...provider,
          name: provider.name.trim(),
          createdAt: provider.createdAt ?? now(),
          updatedAt: now(),
        });
        count++;
      }

      return { success: true, count };
    } catch (error) {
      return { success: false, count: 0, error: String(error) };
    }
  }

  exportJson(pretty = true): string {
    return JSON.stringify(this.db, null, pretty ? 2 : 0);
  }

  onDidChange(listener: ChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) {
        this.listeners.splice(i, 1);
      }
    };
  }

  private notifyChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private load(): ProvidersDatabase {
    if (!existsSync(DB_PATH)) {
      return { version: 2, providers: {} };
    }

    try {
      const text = readFileSync(DB_PATH, "utf8");
      const parsed = JSON.parse(text) as Partial<ProvidersDatabase>;
      if (!parsed || typeof parsed !== "object" || typeof parsed.providers !== "object") {
        return { version: 2, providers: {} };
      }

      return {
        version: 2,
        providers: parsed.providers as Record<string, ProviderConfig>,
      };
    } catch {
      return { version: 2, providers: {} };
    }
  }

  private save(): void {
    const folder = dirname(DB_PATH);
    if (!existsSync(folder)) {
      mkdirSync(folder, { recursive: true });
    }
    writeFileSync(DB_PATH, JSON.stringify(this.db, null, 2), "utf8");
  }
}
