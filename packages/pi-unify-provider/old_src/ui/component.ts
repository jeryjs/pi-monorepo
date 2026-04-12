import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

export interface SelectItem<T> {
  label: string;
  detail?: string;
  value: T;
}

export async function pickItem<T>(
  ctx: ExtensionCommandContext,
  title: string,
  items: Array<SelectItem<T>>,
): Promise<T | undefined> {
  const options = items.map((item) => item.detail ? `${item.label} — ${item.detail}` : item.label);
  const selected = await ctx.ui.select(title, options);
  if (!selected) return undefined;

  const index = options.indexOf(selected);
  if (index < 0) return undefined;
  return items[index]?.value;
}

export async function promptRequired(
  ctx: ExtensionCommandContext,
  title: string,
  placeholder?: string,
  initial?: string,
): Promise<string | undefined> {
  const value = await ctx.ui.input(title, initial ?? placeholder);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) {
    ctx.ui.notify("Value is required", "warning");
    return undefined;
  }
  return trimmed;
}

export async function promptJson(
  ctx: ExtensionCommandContext,
  title: string,
  prefill = "{}",
): Promise<Record<string, string> | undefined> {
  const text = await ctx.ui.editor(title, prefill);
  if (text === undefined) return undefined;

  try {
    const parsed = JSON.parse(text) as Record<string, string>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      ctx.ui.notify("JSON must be an object", "error");
      return undefined;
    }
    return parsed;
  } catch {
    ctx.ui.notify("Invalid JSON", "error");
    return undefined;
  }
}
