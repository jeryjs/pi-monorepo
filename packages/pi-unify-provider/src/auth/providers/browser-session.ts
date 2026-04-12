import { createSecretRef, isSecretRef } from "../../secret-store.js";
import type { BrowserSessionAuthConfig, AuthCredential } from "../../types.js";
import type { AuthConfigureResult, AuthProviderDefinition, AuthUi } from "../auth-provider.js";
import { BaseAuthProvider } from "../auth-provider.js";

export class BrowserSessionAuthProvider extends BaseAuthProvider<BrowserSessionAuthConfig> {
  get definition(): AuthProviderDefinition {
    return {
      id: "browser-session",
      label: this.config?.label ?? "Browser Session",
      description: this.config?.description ?? "Authenticate with browser session token/cookie",
    };
  }

  async getCredential(): Promise<AuthCredential | undefined> {
    const raw = this.config?.sessionToken?.trim();
    if (!raw) return undefined;

    if (!isSecretRef(raw)) {
      return { value: raw };
    }

    const secret = await this.context.secretStore.getGenericSecret(raw);
    if (!secret) {
      this.emit({ status: "error", error: new Error("Browser session secret not found") });
      return undefined;
    }

    return { value: secret };
  }

  async isValid(): Promise<boolean> {
    return !!(await this.getCredential())?.value;
  }

  async configure(ui: AuthUi): Promise<AuthConfigureResult> {
    if (this.config?.loginUrl) {
      ui.notify(`Open this URL to login: ${this.config.loginUrl}`, "info");
    }

    const current = await this.getCredential();
    const token = await ui.input(
      `Session Token/Cookie (${this.context.providerLabel})`,
      current?.value || "session token...",
    );

    if (token === undefined) return { success: false };

    const trimmed = token.trim();
    if (!trimmed) {
      await this.revoke();
      return { success: true, config: this.config };
    }

    const ref = this.config?.sessionToken && isSecretRef(this.config.sessionToken)
      ? this.config.sessionToken
      : createSecretRef();

    await this.context.secretStore.setGenericSecret(ref, trimmed);

    const next: BrowserSessionAuthConfig = {
      method: "browser-session",
      label: this.config?.label,
      description: this.config?.description,
      sessionToken: ref,
      loginUrl: this.config?.loginUrl,
    };

    await this.persist(next);
    this.emit({ status: "valid" });
    return { success: true, config: next };
  }

  async revoke(): Promise<void> {
    const token = this.config?.sessionToken;
    if (token && isSecretRef(token)) {
      await this.context.secretStore.deleteGenericSecret(token);
    }

    const next: BrowserSessionAuthConfig = {
      method: "browser-session",
      label: this.config?.label,
      description: this.config?.description,
      sessionToken: undefined,
      loginUrl: this.config?.loginUrl,
    };

    await this.persist(next);
    this.emit({ status: "revoked" });
  }
}
