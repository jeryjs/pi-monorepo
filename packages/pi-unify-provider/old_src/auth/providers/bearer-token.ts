import { createSecretRef, isSecretRef } from "../../secret-store.js";
import type { BearerTokenAuthConfig, AuthCredential } from "../../types.js";
import type { AuthConfigureResult, AuthProviderDefinition, AuthUi } from "../auth-provider.js";
import { BaseAuthProvider } from "../auth-provider.js";

export class BearerTokenAuthProvider extends BaseAuthProvider<BearerTokenAuthConfig> {
  get definition(): AuthProviderDefinition {
    return {
      id: "bearer-token",
      label: this.config?.label ?? "Bearer Token",
      description: this.config?.description ?? "Authenticate with bearer token",
    };
  }

  async getCredential(): Promise<AuthCredential | undefined> {
    const token = this.config?.token?.trim();
    if (!token) return undefined;

    if (!isSecretRef(token)) {
      return { value: token, tokenType: "Bearer" };
    }

    const secret = await this.context.secretStore.getGenericSecret(token);
    if (!secret) {
      this.emit({ status: "error", error: new Error("Bearer token secret not found") });
      return undefined;
    }

    return { value: secret, tokenType: "Bearer" };
  }

  async isValid(): Promise<boolean> {
    return !!(await this.getCredential())?.value;
  }

  async configure(ui: AuthUi): Promise<AuthConfigureResult> {
    const current = await this.getCredential();
    const value = await ui.input(`Bearer Token (${this.context.providerLabel})`, current?.value ?? "token...");
    if (value === undefined) {
      return { success: false };
    }

    const token = value.trim();
    if (!token) {
      await this.revoke();
      return { success: true, config: this.config };
    }

    const ref = this.config?.token && isSecretRef(this.config.token)
      ? this.config.token
      : createSecretRef();

    await this.context.secretStore.setGenericSecret(ref, token);

    const next: BearerTokenAuthConfig = {
      method: "bearer-token",
      label: this.config?.label,
      description: this.config?.description,
      token: ref,
      headerName: this.config?.headerName,
    };

    await this.persist(next);
    this.emit({ status: "valid" });
    return { success: true, config: next };
  }

  async revoke(): Promise<void> {
    const token = this.config?.token;
    if (token && isSecretRef(token)) {
      await this.context.secretStore.deleteGenericSecret(token);
    }

    const next: BearerTokenAuthConfig = {
      method: "bearer-token",
      label: this.config?.label,
      description: this.config?.description,
      token: undefined,
      headerName: this.config?.headerName,
    };

    await this.persist(next);
    this.emit({ status: "revoked" });
  }
}
