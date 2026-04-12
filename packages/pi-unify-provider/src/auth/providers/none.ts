import type { AuthConfigureResult, AuthProviderDefinition, AuthUi } from "../auth-provider.js";
import { BaseAuthProvider } from "../auth-provider.js";
import type { NoAuthConfig } from "../../types.js";

export class NoneAuthProvider extends BaseAuthProvider<NoAuthConfig> {
  get definition(): AuthProviderDefinition {
    return {
      id: "none",
      label: "None",
      description: "No authentication",
    };
  }

  async getCredential() {
    return undefined;
  }

  async isValid(): Promise<boolean> {
    return true;
  }

  async configure(_ui: AuthUi): Promise<AuthConfigureResult> {
    const next: NoAuthConfig = { method: "none" };
    await this.persist(next);
    this.emit({ status: "valid" });
    return { success: true, config: next };
  }

  async revoke(): Promise<void> {
    const next: NoAuthConfig = { method: "none" };
    await this.persist(next);
    this.emit({ status: "revoked" });
  }
}
