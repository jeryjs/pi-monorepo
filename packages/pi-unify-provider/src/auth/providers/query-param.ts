import { createSecretRef, isSecretRef } from "../../secret-store.js";
import type { QueryParamAuthConfig, AuthCredential } from "../../types.js";
import type { AuthConfigureResult, AuthProviderDefinition, AuthUi } from "../auth-provider.js";
import { BaseAuthProvider } from "../auth-provider.js";

export class QueryParamAuthProvider extends BaseAuthProvider<QueryParamAuthConfig> {
  get definition(): AuthProviderDefinition {
    return {
      id: "query-param",
      label: this.config?.label ?? "Query Param",
      description: this.config?.description ?? "Authenticate with query parameter",
    };
  }

  async getCredential(): Promise<AuthCredential | undefined> {
    const value = this.config?.value?.trim();
    if (!value) {
      return undefined;
    }

    if (!isSecretRef(value)) {
      return { value };
    }

    const secret = await this.context.secretStore.getGenericSecret(value);
    if (!secret) {
      this.emit({ status: "error", error: new Error("Query param secret not found") });
      return undefined;
    }

    return { value: secret };
  }

  async isValid(): Promise<boolean> {
    return !!(await this.getCredential())?.value && !!this.config?.paramName?.trim();
  }

  async configure(ui: AuthUi): Promise<AuthConfigureResult> {
    const paramName = await ui.input(
      `Query Param Name (${this.context.providerLabel})`,
      this.config?.paramName || "api_key",
    );

    if (paramName === undefined) return { success: false };

    const current = await this.getCredential();
    const paramValue = await ui.input(
      `Query Param Value (${this.context.providerLabel})`,
      current?.value || "value...",
    );

    if (paramValue === undefined) return { success: false };

    const trimmedName = paramName.trim();
    const trimmedValue = paramValue.trim();

    if (!trimmedName || !trimmedValue) {
      ui.notify("Query param name and value are required", "error");
      return { success: false, error: "Invalid query param config" };
    }

    const ref = this.config?.value && isSecretRef(this.config.value)
      ? this.config.value
      : createSecretRef();

    await this.context.secretStore.setGenericSecret(ref, trimmedValue);

    const next: QueryParamAuthConfig = {
      method: "query-param",
      label: this.config?.label,
      description: this.config?.description,
      paramName: trimmedName,
      value: ref,
    };

    await this.persist(next);
    this.emit({ status: "valid" });
    return { success: true, config: next };
  }

  async revoke(): Promise<void> {
    const value = this.config?.value;
    if (value && isSecretRef(value)) {
      await this.context.secretStore.deleteGenericSecret(value);
    }

    const next: QueryParamAuthConfig = {
      method: "query-param",
      label: this.config?.label,
      description: this.config?.description,
      paramName: this.config?.paramName ?? "api_key",
      value: undefined,
    };

    await this.persist(next);
    this.emit({ status: "revoked" });
  }
}
