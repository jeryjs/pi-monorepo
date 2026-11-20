import {
  DynamicBorder,
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import {
  BACKGROUND_COLLAPSED_TASK_LIMIT_MAX,
  BACKGROUND_COLLAPSED_TASK_LIMIT_MIN,
  BACKGROUND_COLLAPSED_TASK_LIMIT_PRESETS,
  type BackgroundOutputPreview,
  type BackgroundTasksConfig,
} from "./config.ts";

const SETTINGS_COMMAND = "bg-terminal-settings";
const MAX_VISIBLE_SETTINGS = 10;

const COLLAPSED_SETTING_ID = "collapsedTaskLimit";
const PREVIEW_SETTING_ID = "outputPreview";

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
    .find(([, label]) => label === value)?.[0];
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
 * Settings menu modeled on Pi's own `/settings` screen: a themed `SettingsList`
 * between two dynamic borders, with search enabled and Enter/Space cycling each
 * value. The list updates its own display, so changes persist immediately.
 */
class BackgroundTasksSettingsComponent extends Container {
  private readonly settingsList: SettingsList;

  constructor(
    getConfig: () => BackgroundTasksConfig,
    updateConfig: (config: BackgroundTasksConfig) => void,
    onCancel: () => void,
  ) {
    super();
    const config = getConfig();
    const items: SettingItem[] = [
      {
        id: COLLAPSED_SETTING_ID,
        label: "Collapsed tasks",
        description: "Number of task rows shown below the editor before the widget is expanded",
        currentValue: collapsedTaskLimitLabel(config.collapsedTaskLimit),
        values: collapsedTaskLimitValues(config.collapsedTaskLimit),
      },
      {
        id: PREVIEW_SETTING_ID,
        label: "Output preview",
        description: "Which pipe-task rows include their latest output line",
        currentValue: OUTPUT_PREVIEW_LABELS[config.outputPreview],
        values: Object.values(OUTPUT_PREVIEW_LABELS),
      },
    ];

    this.addChild(new DynamicBorder());
    this.settingsList = new SettingsList(
      items,
      Math.min(items.length, MAX_VISIBLE_SETTINGS),
      getSettingsListTheme(),
      (id, newValue) => {
        const current = getConfig();
        if (id === COLLAPSED_SETTING_ID) {
          const limit = collapsedTaskLimitForValue(newValue);
          if (limit !== undefined) updateConfig({ ...current, collapsedTaskLimit: limit });
          return;
        }
        if (id === PREVIEW_SETTING_ID) {
          const preview = outputPreviewForLabel(newValue);
          if (preview !== undefined) updateConfig({ ...current, outputPreview: preview });
        }
      },
      onCancel,
      { enableSearch: true },
    );
    this.addChild(this.settingsList);
    this.addChild(new DynamicBorder());
  }

  handleInput(data: string): void {
    this.settingsList.handleInput(data);
  }
}

/** Registers the extension's own `/bg-terminal-settings` command. */
export function registerBackgroundTasksSettings(
  pi: ExtensionAPI,
  controller: BackgroundTasksSettingsController,
): void {
  pi.registerCommand(SETTINGS_COMMAND, {
    description: "Configure the background task widget (collapsed rows and output preview)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Background task settings require Pi TUI mode.", "warning");
        return;
      }
      await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) =>
        new BackgroundTasksSettingsComponent(
          () => controller.getConfig(),
          (config) => controller.updateConfig(config, ctx),
          () => done(undefined),
        )
      );
    },
  });
}

export { OUTPUT_PREVIEW_LABELS };
