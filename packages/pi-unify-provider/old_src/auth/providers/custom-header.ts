import { createSecretRef, isSecretRef } from "../../secret-store.js";
import type { CustomHeaderAuthConfig, AuthCredential } from "../../types.js";
import type { AuthConfigureResult, AuthProviderDefinition, AuthUi } from "../auth-provider.js";
import { BaseAuthProvider } from "../auth-provider.js";

const SECRET_VALUE_PREFIX = "secret:";

function encodeSecretValue(ref: string): string {
  return `${SECRET_VALUE_PREFIX}${ref}`;
}

function decodeSecretValue(value: string): string | undefined {
  if (!value.startsWith(SECRET_VALUE_PREFIX)) return undefined;
  return value.slice(SECRET_VALUE_PREFIX.length);
}

export class CustomHeaderAuthProvider extends BaseAuthProvider<CustomHeaderAuthConfig> {
  get definition(): AuthProviderDefinition {
    return {
      id: "custom-header",
      label: this.config?.label ?? "Custom Header",
      description: this.config?.description ?? "Authenticate with custom header values",
    };
  }

  async getCredential(): Promise<AuthCredential | undefined> {
    const headers = this.config?.headers ?? {};
    return { value: JSON.stringify(headers) };
  }

  async isValid(): Promise<boolean> {
    return Object.keys(this.config?.headers ?? {}).length > 0;
  }

  async configure(ui: AuthUi): Promise<AuthConfigureResult> {
    const prefill = JSON.stringify(this.config?.headers ?? {}, null, 2);
    const edited = await ui.editor(
      `Custom Headers (${this.context.providerLabel})`,
      prefill,
    );

    if (edited === undefined) {
      return { success: false };
    }

    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(edited) as Record<string, string>;
    } catch {
      ui.notify("Invalid JSON for headers", "error");
      return { success: false, error: "Invalid JSON" };
    }

    const nextHeaders: Record<string, string> = {};

    for (const [name, raw] of Object.entries(parsed)) {
      const value = String(raw ?? "").trim();
      if (!value) continue;

      if (value.startsWith("$")) {
        const currentRef = decodeSecretValue(this.config?.headers?.[name] ?? "");
        const ref = currentRef && isSecretRef(currentRef) ? currentRef : createSecretRef();
        await this.context.secretStore.setGenericSecret(ref, value.slice(1));
        nextHeaders[name] = encodeSecretValue(ref);
      } else {
        nextHeaders[name] = value;
      }
    }

    const next: CustomHeaderAuthConfig = {
      method: "custom-header",
      label: this.config?.label,
      description: this.config?.description,
      headers: nextHeaders,
    };

    await this.persist(next);
    this.emit({ status: "valid" });
    return { success: true, config: next };
  }

  async resolveHeaders(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.config?.headers ?? {})) {
      const ref = decodeSecretValue(value);
      if (ref && isSecretRef(ref)) {
        const secret = await this.context.secretStore.getGenericSecret(ref);
        if (!secret) continue;
        out[name] = secret;
      } else {
        out[name] = value;
      }
    }
    return out;
  }

  async revoke(): Promise<void> {
    for (const value of Object.values(this.config?.headers ?? {})) {
      const ref = decodeSecretValue(value);
      if (ref && isSecretRef(ref)) {
        await this.context.secretStore.deleteGenericSecret(ref);
      }
    }

    const next: CustomHeaderAuthConfig = {
      method: "custom-header",
      label: this.config?.label,
      description: this.config?.description,
      headers: {},
    };

    await this.persist(next);
    this.emit({ status: "revoked" });
  }
}
