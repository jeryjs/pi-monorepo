import type { AuthConfig } from "../types.js";
import type { AuthProvider, AuthProviderContext } from "./auth-provider.js";
import { getAuthMethodCtor } from "./definitions.js";

export function createAuthProviderForMethod(
  context: AuthProviderContext,
  method: AuthConfig["method"],
  config?: AuthConfig,
): AuthProvider {
  const Ctor = getAuthMethodCtor(method);
  return new Ctor(context, config && config.method === method ? config : { method } as AuthConfig);
}
