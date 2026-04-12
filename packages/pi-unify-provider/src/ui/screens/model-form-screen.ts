import type {
  ModelFormRoute,
  UiContext,
  UiNavAction,
  UiResume,
} from "../router/types.js";
import { pickItem } from "../component.js";
import type { ModelConfig } from "../../types.js";

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

function validateModelIdUnique(id: string, models: ModelConfig[], originalId?: string): string | undefined {
  const trimmed = id.trim();
  if (!trimmed) return "Model ID is required";
  if (originalId && trimmed === originalId) return undefined;
  if (models.some((model) => model.id === trimmed)) return "Model ID already exists";
  return undefined;
}

export async function runModelFormScreen(
  ctx: UiContext,
  route: ModelFormRoute,
  _resume: UiResume | undefined,
): Promise<UiNavAction> {
  const model = route.draft;
  const editing = !!route.originalId;

  const action = await pickItem(ctx.cmd, editing ? `Edit model: ${route.originalId}` : "Add model", [
    { label: "Back", value: "back" as const },
    { label: "Model ID", detail: model.id || "(required)", value: "id" as const },
    { label: "Display Name", detail: model.name || "(optional)", value: "name" as const },
    {
      label: "Context Window",
      detail: model.contextWindow ? String(model.contextWindow) : "(optional)",
      value: "context" as const,
    },
    {
      label: "Max Output Tokens",
      detail: model.maxOutputTokens ? String(model.maxOutputTokens) : "(optional)",
      value: "max-output" as const,
    },
    {
      label: "Tool Calling",
      detail: model.capabilities?.toolCalling ? "enabled" : "disabled",
      value: "tool-calling" as const,
    },
    {
      label: "Reasoning",
      detail: model.capabilities?.reasoning ? "enabled" : "disabled",
      value: "reasoning" as const,
    },
    {
      label: "Image Input",
      detail: model.capabilities?.imageInput ? "enabled" : "disabled",
      value: "image-input" as const,
    },
    { label: "Save", value: "save" as const },
    ...(editing ? [{ label: "Delete", value: "delete" as const }] : []),
  ]);

  if (!action || action === "back") {
    return { kind: "pop", resume: { kind: "noop" } };
  }

  if (action === "id") {
    const input = await ctx.cmd.ui.input("Model ID", model.id || "gpt-4o");
    if (input !== undefined) {
      model.id = input.trim();
    }
    return { kind: "stay" };
  }

  if (action === "name") {
    const input = await ctx.cmd.ui.input("Display Name", model.name || "GPT-4o");
    if (input !== undefined) {
      model.name = input.trim() || undefined;
    }
    return { kind: "stay" };
  }

  if (action === "context") {
    const input = await ctx.cmd.ui.input("Context Window", model.contextWindow ? String(model.contextWindow) : "128000");
    if (input !== undefined) {
      const parsed = parseOptionalPositiveInt(input);
      if (parsed !== undefined) model.contextWindow = parsed;
      if (parsed === undefined) ctx.cmd.ui.notify("Must be a positive integer", "warning");
    }
    return { kind: "stay" };
  }

  if (action === "max-output") {
    const input = await ctx.cmd.ui.input("Max Output Tokens", model.maxOutputTokens ? String(model.maxOutputTokens) : "8192");
    if (input !== undefined) {
      const parsed = parseOptionalPositiveInt(input);
      if (parsed !== undefined) model.maxOutputTokens = parsed;
      if (parsed === undefined) ctx.cmd.ui.notify("Must be a positive integer", "warning");
    }
    return { kind: "stay" };
  }

  if (action === "tool-calling") {
    model.capabilities = {
      ...(model.capabilities ?? {}),
      toolCalling: !model.capabilities?.toolCalling,
    };
    return { kind: "stay" };
  }

  if (action === "reasoning") {
    model.capabilities = {
      ...(model.capabilities ?? {}),
      reasoning: !model.capabilities?.reasoning,
    };
    return { kind: "stay" };
  }

  if (action === "image-input") {
    model.capabilities = {
      ...(model.capabilities ?? {}),
      imageInput: !model.capabilities?.imageInput,
    };
    return { kind: "stay" };
  }

  if (action === "delete" && route.originalId) {
    return {
      kind: "pop",
      resume: {
        kind: "model-deleted",
        modelId: route.originalId,
      },
    };
  }

  const idError = validateModelIdUnique(model.id, route.models, route.originalId);
  if (idError) {
    ctx.cmd.ui.notify(idError, "error");
    return { kind: "stay" };
  }

  return {
    kind: "pop",
    resume: {
      kind: "model-saved",
      model,
      originalId: route.originalId,
    },
  };
}
