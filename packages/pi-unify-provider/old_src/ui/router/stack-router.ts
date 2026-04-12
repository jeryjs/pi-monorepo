import type { UiContext, UiNavAction, UiResume, UiRoute } from "./types.js";
import { runProviderListScreen } from "../screens/provider-list-screen.js";
import { runProviderFormScreen } from "../screens/provider-form-screen.js";
import { runModelListScreen } from "../screens/model-list-screen.js";
import { runModelFormScreen } from "../screens/model-form-screen.js";
import { runAuthMethodScreen } from "../screens/auth-method-screen.js";
import { runWellKnownProviderListScreen } from "../screens/well-known-provider-list-screen.js";

export async function runUiStack(ctx: UiContext, initialRoute: UiRoute): Promise<void> {
  const stack: UiRoute[] = [initialRoute];
  let resume: UiResume | undefined;

  while (stack.length > 0) {
    const current = stack[stack.length - 1]!;
    const action = await dispatchRoute(ctx, current, resume);
    resume = undefined;

    switch (action.kind) {
      case "stay":
        continue;
      case "push":
        stack.push(action.route);
        continue;
      case "replace":
        stack[stack.length - 1] = action.route;
        continue;
      case "pop":
        stack.pop();
        resume = action.resume;
        continue;
      case "exit":
        return;
      default:
        assertNever(action);
    }
  }
}

async function dispatchRoute(ctx: UiContext, route: UiRoute, resume?: UiResume): Promise<UiNavAction> {
  switch (route.kind) {
    case "provider-list":
      return runProviderListScreen(ctx, route, resume);
    case "well-known-provider-list":
      return runWellKnownProviderListScreen(ctx, route, resume);
    case "provider-form":
      return runProviderFormScreen(ctx, route, resume);
    case "auth-method":
      return runAuthMethodScreen(ctx, route, resume);
    case "model-list":
      return runModelListScreen(ctx, route, resume);
    case "model-form":
      return runModelFormScreen(ctx, route, resume);
    default:
      return assertNever(route);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
