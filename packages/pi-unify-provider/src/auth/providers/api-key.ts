import { createSecretRef, isSecretRef } from "../../secret-store.js";
import type { ApiKeyAuthConfig, AuthCredential } from "../../types.js";
import type { AuthConfigureResult, AuthProviderDefinition, AuthUi } from "../auth-provider.js";
import { BaseAuthProvider } from "../auth-provider.js";

export class ApiKeyAuthProvider extends BaseAuthProvider<ApiKeyAuthConfig> {
  get definition(): AuthProviderDefinition {
    return {
      id: "api-key",
      label: this.config?.label ?? "API Key",
      description: this.config?.description ?? "Authenticate with API key",
    };
  }

  async getSummaryDetail(): Promise<string | undefined> {
    const status = await this.context.secretStore.getApiKeyStatus(this.config?.apiKey);
    switch (status.kind) {
      case "unset":
        return "Not configured";
      case "plain":
        return "Stored in config";
      case "secret":
        return "Stored in secret store";
      case "missing-secret":
        return "Missing secret, reconfigure";
    }
  }

  async getCredential(): Promise<AuthCredential | undefined> {
    const value = this.config?.apiKey?.trim();
    if (!value) {
      return undefined;
    }

    if (!isSecretRef(value)) {
      return { value };
    }

    const secret = await this.context.secretStore.getApiKey(value);
    if (!secret) {
      this.emit({ status: "error", error: new Error("API key secret not found") });
      return undefined;
    }

    return { value: secret };
  }

  async isValid(): Promise<boolean> {
    const credential = await this.getCredential();
    return !!credential?.value;
  }

  async configure(ui: AuthUi): Promise<AuthConfigureResult> {
    const current = await this.getCredential();
    const input = await ui.input(`API Key (${this.context.providerLabel})`, current?.value ?? "sk-...");
    if (input === undefined) {
      return { success: false };
    }

    const apiKey = input.trim();
    if (!apiKey) {
      const old = this.config?.apiKey;
      if (old && isSecretRef(old)) {
        await this.context.secretStore.deleteApiKey(old);
      }

      const next: ApiKeyAuthConfig = {
        method: "api-key",
        label: this.config?.label,
        description: this.config?.description,
        apiKey: undefined,
        headerName: this.config?.headerName,
        prefix: this.config?.prefix,
      };

      await this.persist(next);
      this.emit({ status: "revoked" });
      return { success: true, config: next };
    }

    const ref = this.config?.apiKey && isSecretRef(this.config.apiKey)
      ? this.config.apiKey
      : createSecretRef();

    await this.context.secretStore.setApiKey(ref, apiKey);

    const next: ApiKeyAuthConfig = {
      method: "api-key",
      label: this.config?.label,
      description: this.config?.description,
      apiKey: ref,
      headerName: this.config?.headerName,
      prefix: this.config?.prefix,
    };

    await this.persist(next);
    this.emit({ status: "valid" });
    return { success: true, config: next };
  }

  async revoke(): Promise<void> {
    const ref = this.config?.apiKey;
    if (ref && isSecretRef(ref)) {
      await this.context.secretStore.deleteApiKey(ref);
    }

    const next: ApiKeyAuthConfig = {
      method: "api-key",
      label: this.config?.label,
      description: this.config?.description,
      apiKey: undefined,
      headerName: this.config?.headerName,
      prefix: this.config?.prefix,
    };

    await this.persist(next);
    this.emit({ status: "revoked" });
  }
}
