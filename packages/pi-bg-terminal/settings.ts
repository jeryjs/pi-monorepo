import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BACKGROUND_COLLAPSED_TASK_LIMIT_MAX,
  BACKGROUND_COLLAPSED_TASK_LIMIT_MIN,
  BACKGROUND_COLLAPSED_TASK_LIMIT_PRESETS,
  type BackgroundOutputPreview,
  type BackgroundTasksConfig,
} from "./config.ts";

const SETTINGS_COMMAND = "bg-settings";
const COLLAPSED_KEY = "collapsed";
const PREVIEW_KEY = "preview";

const OUTPUT_PREVIEW_LABELS: Record<BackgroundOutputPreview, string> = {
  off: "Off",
  failures: "Failures",
  finished: "Finished",
  all: "All pipe tasks",
};

interface BackgroundTasksSettingsController {
  getConfig(): BackgroundTasksConfig;
  updateConfig(config: BackgroundTasksConfig, ctx: ExtensionContext): void;
}

function collapsedTaskLimitLabel(limit: number): string {
  return limit === 0 ? "Summary only" : String(limit);
}

function collapsedTaskLimitValues(current: number): string[] {
  return [...new Set([...BACKGROUND_COLLAPSED_TASK_LIMIT_PRESETS, current])]
    .sort((left, right) => left - right)
    .map(collapsedTaskLimitLabel);
}

function outputPreviewForLabel(value: string): BackgroundOutputPreview | undefined {
  return (Object.entries(OUTPUT_PREVIEW_LABELS) as Array<[BackgroundOutputPreview, string]>)
    .find(([, label]) => label.toLowerCase() === value.trim().toLowerCase())?.[0];
}

function collapsedTaskLimitForValue(value: string): number | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "summary" || normalized === "summary only" || normalized === "0") return 0;
  const limit = Number(normalized);
  return Number.isInteger(limit)
    && limit >= BACKGROUND_COLLAPSED_TASK_LIMIT_MIN
    && limit <= BACKGROUND_COLLAPSED_TASK_LIMIT_MAX
    ? limit
    : undefined;
}

/**
 * Registers the extension's own `/bg-settings` command.
 *
 * This replacement keeps configuration self-contained: values are persisted by
 * the extension's config module instead of a shared settings store.
 */
export function registerBackgroundTasksSettings(
  pi: ExtensionAPI,
  controller: BackgroundTasksSettingsController,
): void {
  const applyCollapsed = (value: string, ctx: ExtensionContext): boolean => {
    const limit = collapsedTaskLimitForValue(value);
    if (limit === undefined) return false;
    controller.updateConfig({ ...controller.getConfig(), collapsedTaskLimit: limit }, ctx);
    return true;
  };

  const applyPreview = (value: string, ctx: ExtensionContext): boolean => {
    const preview = outputPreviewForLabel(value);
    if (preview === undefined) return false;
    controller.updateConfig({ ...controller.getConfig(), outputPreview: preview }, ctx);
    return true;
  };

  pi.registerCommand(SETTINGS_COMMAND, {
    description: "Configure the background task widget (collapsed rows and output preview)",
    getArgumentCompletions: (prefix: string) => {
      const trimmed = prefix.trimStart();
      const [key, ...rest] = trimmed.split(/\s+/);
      if (!key || rest.length === 0) {
        const keys = [
          { value: COLLAPSED_KEY, label: "collapsed: task rows shown when collapsed" },
          { value: PREVIEW_KEY, label: "preview: which pipe rows show output" },
        ];
        if (!key) return keys;
        const collapsedMatch = COLLAPSED_KEY.startsWith(key);
        const previewMatch = PREVIEW_KEY.startsWith(key);
        const matches = keys.filter((_, index) => index === 0 ? collapsedMatch : previewMatch);
        return matches.length > 0 ? matches : null;
      }
      if (key === COLLAPSED_KEY) {
        return collapsedTaskLimitValues(controller.getConfig().collapsedTaskLimit)
          .map((value) => ({ value: `${COLLAPSED_KEY} ${value}`, label: value }))
          .filter((item) => item.value.startsWith(trimmed));
      }
      if (key === PREVIEW_KEY) {
        return Object.values(OUTPUT_PREVIEW_LABELS)
          .map((value) => ({ value: `${PREVIEW_KEY} ${value}`, label: value }))
          .filter((item) => item.value.startsWith(trimmed));
      }
      return null;
    },
    handler: async (args, ctx) => {
      const [rawKey, ...rest] = args.trim().split(/\s+/);
      const suppliedValue = rest.join(" ");

      if (!rawKey) {
        const collapsed = await ctx.ui.select(
          "Collapsed task rows (before the widget is expanded)",
          collapsedTaskLimitValues(controller.getConfig().collapsedTaskLimit),
        );
        if (collapsed && !applyCollapsed(collapsed, ctx)) {
          ctx.ui.notify(`Invalid collapsed task count: ${collapsed}`, "error");
        }
        const preview = await ctx.ui.select(
          "Which pipe tasks include their latest output?",
          Object.values(OUTPUT_PREVIEW_LABELS),
        );
        if (preview && !applyPreview(preview, ctx)) {
          ctx.ui.notify(`Invalid output preview: ${preview}`, "error");
        }
        return;
      }

      if (rawKey === COLLAPSED_KEY) {
        const value = suppliedValue || await ctx.ui.select(
          "Collapsed task rows (before the widget is expanded)",
          collapsedTaskLimitValues(controller.getConfig().collapsedTaskLimit),
        );
        if (!value) return;
        if (!applyCollapsed(value, ctx)) {
          ctx.ui.notify(`Invalid collapsed task count: ${value}`, "error");
        }
        return;
      }

      if (rawKey === PREVIEW_KEY) {
        const value = suppliedValue || await ctx.ui.select(
          "Which pipe tasks include their latest output?",
          Object.values(OUTPUT_PREVIEW_LABELS),
        );
        if (!value) return;
        if (!applyPreview(value, ctx)) {
          ctx.ui.notify(`Invalid output preview: ${value}`, "error");
        }
        return;
      }

      ctx.ui.notify(`Unknown setting "${rawKey}". Use "${COLLAPSED_KEY}" or "${PREVIEW_KEY}".`, "error");
    },
  });
}

export { OUTPUT_PREVIEW_LABELS };
