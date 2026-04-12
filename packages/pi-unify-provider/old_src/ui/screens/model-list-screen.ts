import { getWellKnownProvider } from "../../providers/well-known.js";
import type { ModelConfig } from "../../types.js";
import { pickItem } from "../component.js";
import type {
  ModelListRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from "../router/types.js";

function applyResume(route: ModelListRoute, resume?: UiResume): void {
  if (!resume) return;

  if (resume.kind === "model-saved") {
    if (resume.originalId) {
      const index = route.draft.models.findIndex((model) => model.id === resume.originalId);
      if (index >= 0) {
        route.draft.models[index] = resume.model;
        return;
      }
    }
    route.draft.models.push(resume.model);
    return;
  }

  if (resume.kind === "model-deleted") {
    route.draft.models = route.draft.models.filter((model) => model.id !== resume.modelId);
  }
}

function uniqueModelId(baseId: string, models: ModelConfig[]): string {
  if (!models.some((model) => model.id === baseId)) return baseId;
  let i = 1;
  while (models.some((model) => model.id === `${baseId}#${i}`)) {
    i++;
  }
  return `${baseId}#${i}`;
}

export async function runModelListScreen(
  ctx: UiContext,
  route: ModelListRoute,
  resume: UiResume | undefined,
): Promise<UiNavAction> {
  applyResume(route, resume);

  const providerType = route.draft.type;
  const builtins = providerType ? (getWellKnownProvider(providerType)?.hardcodedModels ?? []) : [];

  const action = await pickItem(ctx.cmd, `Models (${route.draft.name || "provider"})`, [
    { label: "Back", value: "back" as const },
    { label: "Add model", value: "add" as const },
    ...(builtins.length
      ? [{ label: "Add from built-in list", detail: `${builtins.length} models`, value: "add-builtin" as const }]
      : []),
    ...route.draft.models.map((model) => ({
      label: model.name || model.id,
      detail: model.id,
      value: { kind: "edit", model } as const,
    })),
  ]);

  if (!action || action === "back") {
    return { kind: "pop" };
  }

  if (action === "add") {
    return {
      kind: "push",
      route: {
        kind: "model-form",
        draft: { id: "", capabilities: { toolCalling: true }, source: "manual" },
        models: route.draft.models,
      },
    };
  }

  if (action === "add-builtin") {
    const selectedBuiltin = await pickItem(
      ctx.cmd,
      "Select built-in model",
      builtins.map((model) => ({
        label: model.name || model.id,
        detail: model.id,
        value: model,
      })),
    );

    if (selectedBuiltin) {
      const next = {
        ...selectedBuiltin,
        id: uniqueModelId(selectedBuiltin.id, route.draft.models),
        source: selectedBuiltin.source ?? "builtin",
      };
      route.draft.models.push(next);
      ctx.cmd.ui.notify(`Added model: ${next.id}`, "info");
    }

    return { kind: "stay" };
  }

  if (typeof action === "object" && action.kind === "edit") {
    return {
      kind: "push",
      route: {
        kind: "model-form",
        draft: { ...action.model },
        models: route.draft.models,
        originalId: action.model.id,
      },
    };
  }

  return { kind: "stay" };
}
