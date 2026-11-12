import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type BackgroundOutputPreview = "off" | "failures" | "finished" | "all";

export interface BackgroundTasksConfig {
  collapsedTaskLimit: number;
  outputPreview: BackgroundOutputPreview;
}

export const BACKGROUND_TASKS_SETTINGS_NAMESPACE = "background-tasks";
export const BACKGROUND_COLLAPSED_TASK_LIMIT_MIN = 0;
export const BACKGROUND_COLLAPSED_TASK_LIMIT_MAX = 10;
export const BACKGROUND_COLLAPSED_TASK_LIMIT_PRESETS = [0, 1, 3, 5] as const;

const CONFIG_FILE_NAME = "pi-bg-terminal.json";

export const DEFAULT_BACKGROUND_TASKS_CONFIG: BackgroundTasksConfig = {
  collapsedTaskLimit: 0,
  outputPreview: "finished",
};

function isCollapsedTaskLimit(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= BACKGROUND_COLLAPSED_TASK_LIMIT_MIN
    && value <= BACKGROUND_COLLAPSED_TASK_LIMIT_MAX;
}

function isOutputPreview(value: unknown): value is BackgroundOutputPreview {
  return value === "off"
    || value === "failures"
    || value === "finished"
    || value === "all";
}

export function normalizeBackgroundTasksConfig(value: unknown): BackgroundTasksConfig {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_BACKGROUND_TASKS_CONFIG };
  }
  const input = value as {
    collapsedTaskLimit?: unknown;
    outputPreview?: unknown;
  };
  return {
    collapsedTaskLimit: isCollapsedTaskLimit(input.collapsedTaskLimit)
      ? input.collapsedTaskLimit
      : DEFAULT_BACKGROUND_TASKS_CONFIG.collapsedTaskLimit,
    outputPreview: isOutputPreview(input.outputPreview)
      ? input.outputPreview
      : DEFAULT_BACKGROUND_TASKS_CONFIG.outputPreview,
  };
}

/** Path of this extension's own settings file inside Pi's agent directory. */
export function getBackgroundTasksConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILE_NAME);
}

function readSettingsFile(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    // A missing, unreadable, or corrupt file falls back to defaults.
    return {};
  }
}

function writeSettingsFile(path: string, namespace: string, value: unknown): void {
  const data = readSettingsFile(path);
  data[namespace] = value;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

export function loadBackgroundTasksConfig(
  path = getBackgroundTasksConfigPath(),
): BackgroundTasksConfig {
  return normalizeBackgroundTasksConfig(
    readSettingsFile(path)[BACKGROUND_TASKS_SETTINGS_NAMESPACE],
  );
}

export function saveBackgroundTasksConfig(
  config: BackgroundTasksConfig,
  path = getBackgroundTasksConfigPath(),
): void {
  writeSettingsFile(
    path,
    BACKGROUND_TASKS_SETTINGS_NAMESPACE,
    normalizeBackgroundTasksConfig(config),
  );
}
