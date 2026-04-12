import type { AuthConfig, AuthCredential } from "../types.js";
import type { SecretStore } from "../secret-store.js";

export interface AuthUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface AuthProviderDefinition {
  id: string;
  label: string;
  description?: string;
}

export interface AuthConfigureResult {
  success: boolean;
  config?: AuthConfig;
  error?: string;
}

export type AuthStatus = "valid" | "expired" | "revoked" | "error";

export interface AuthStatusChange {
  status: AuthStatus;
  error?: Error;
}

export interface AuthProviderContext {
  providerId: string;
  providerLabel: string;
  secretStore: SecretStore;
  persistAuthConfig?: (auth: AuthConfig) => Promise<void>;
}

export interface AuthProvider {
  readonly definition: AuthProviderDefinition;
  getConfig(): AuthConfig | undefined;
  getSummaryDetail?(): Promise<string | undefined>;
  getCredential(): Promise<AuthCredential | undefined>;
  getExpiryBufferMs(): number;
  isValid(): Promise<boolean>;
  configure(ui: AuthUi): Promise<AuthConfigureResult>;
  refresh?(ui?: AuthUi): Promise<boolean>;
  revoke(): Promise<void>;
  onDidChangeStatus(listener: (change: AuthStatusChange) => void): () => void;
  dispose?(): void;
}

export abstract class BaseAuthProvider<T extends AuthConfig> implements AuthProvider {
  private listeners: Array<(change: AuthStatusChange) => void> = [];

  constructor(protected readonly context: AuthProviderContext, protected config?: T) {}

  abstract get definition(): AuthProviderDefinition;
  abstract getCredential(): Promise<AuthCredential | undefined>;
  abstract isValid(): Promise<boolean>;
  abstract configure(ui: AuthUi): Promise<AuthConfigureResult>;
  abstract revoke(): Promise<void>;

  getConfig(): T | undefined {
    return this.config;
  }

  getExpiryBufferMs(): number {
    return 0;
  }

  onDidChangeStatus(listener: (change: AuthStatusChange) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) {
        this.listeners.splice(i, 1);
      }
    };
  }

  protected emit(change: AuthStatusChange): void {
    for (const listener of this.listeners) {
      listener(change);
    }
  }

  protected async persist(next: T): Promise<void> {
    this.config = next;
    await this.context.persistAuthConfig?.(next);
  }
}
