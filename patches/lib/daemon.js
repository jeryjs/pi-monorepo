// Background watcher: re-applies patches whenever pi (or a patch source) changes.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  PATHS,
  ROOT,
  acquireLock,
  clearPidFile,
  errorInfo,
  isPidAlive,
  nowIso,
  readPidFile,
  releaseLock,
  tailFile,
  writePidFile,
} from "./util.js";
import { defaultPiRoots, loadRegistry, registryWatchRoots } from "./registry.js";
import { loadState, saveState } from "./state.js";
import { collectModuleWatchPaths, runPatches } from "./engine.js";

const IGNORED_NAMES = new Set([
  "state.json",
  "runner.log",
  "runner.log.1",
  "runner.pid",
  "conflicts.html",
  "conflicts.data.js",
  ".lock",
  "backups",
]);

function ignored(name) {
  if (!name) return true;
  if (IGNORED_NAMES.has(name)) return true;
  if (/\.(html|data\.js)$/i.test(name) && /^conflicts/i.test(name)) return true;
  if (name.startsWith("backups")) return true;
  if (name.includes(".tmp-")) return true;
  // dotfiles: .lock, screenshots, scratch dirs — never a patch source
  if (name.startsWith(".")) return true;
  return false;
}

export function daemonInfo() {
  const pidFile = readPidFile();
  const alive = Boolean(pidFile?.pid && isPidAlive(pidFile.pid));
  return { ...(pidFile || {}), alive, pidFile: PATHS.pid };
}

export function daemonStatusText() {
  const info = daemonInfo();
  if (!info.pid) return "not running (no pid file)";
  if (!info.alive) return `stale pid file (pid ${info.pid} is gone)`;
  return `running (pid ${info.pid}${info.startedAt ? `, since ${info.startedAt}` : ""})`;
}

/** Start the daemon detached; it survives this CLI process. */
export function startDaemon({ logger } = {}) {
  const info = daemonInfo();
  if (info.pid && info.alive) return { ok: true, already: true, pid: info.pid };
  if (info.pid) clearPidFile();
  mkdirSync(ROOT, { recursive: true });
  const out = openSync(PATHS.log, "a");
  const child = spawn(process.execPath, [PATHS.main, "daemon", "--foreground"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.unref();
  closeSync(out);
  return { ok: true, already: false, pid: child.pid };
}

export function stopDaemon({ logger } = {}) {
  const info = daemonInfo();
  if (!info.pid || !info.alive) {
    clearPidFile();
    return { ok: true, already: true };
  }
  const pid = info.pid;
  try {
    process.kill(pid);
  } catch (err) {
    logger?.warn(`could not signal pid ${pid}: ${errorInfo(err).message}`);
  }
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) break;
    const until = Date.now() + 100;
    while (Date.now() < until) {
      /* tiny sleep without timers in this sync path */
    }
  }
  if (isPidAlive(pid) && process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* ignore */
    }
  }
  clearPidFile();
  return { ok: true, already: false, pid };
}

export function daemonLogs(lines = 40) {
  return tailFile(PATHS.log, lines);
}

// ---------------------------------------------------------------- autostart

export function autostartFile() {
  if (process.platform !== "win32") return null;
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "pi-patches.vbs");
}

export function autostartState() {
  const file = autostartFile();
  return { supported: Boolean(file), file, enabled: Boolean(file && existsSync(file)) };
}

export function setAutostart(enabled) {
  const file = autostartFile();
  if (!file) {
    throw new Error("autostart is only implemented for Windows (write a systemd unit or cron entry elsewhere)");
  }
  if (!enabled) {
    if (existsSync(file)) unlinkSync(file);
    return { enabled: false, file };
  }
  mkdirSync(dirname(file), { recursive: true });
  const script = [
    "' pi patches — start the patch runner daemon hidden at login",
    "Set sh = CreateObject(\"WScript.Shell\")",
    `sh.CurrentDirectory = "${ROOT.replace(/"/g, '""')}"`,
    `sh.Run """${process.execPath}"" ""${PATHS.main}"" daemon start", 0, False`,
    "",
  ].join("\r\n");
  writeFileSync(file, script, "utf8");
  return { enabled: true, file };
}

// ---------------------------------------------------------------- foreground loop

/**
 * Long-lived watcher. Runs immediately, then on any relevant fs event (debounced)
 * and on a slow interval as a safety net for missed events.
 */
export async function runDaemonForeground({ logger, intervalMs } = {}) {
  writePidFile({ role: "daemon" });
  const watchers = new Map();
  let running = false;
  let pending = false;
  let debounceTimer = null;
  let intervalTimer = null;
  let stopping = false;

  const initial = loadState();
  initial.runner.pid = process.pid;
  initial.runner.startedAt = nowIso();
  saveState(initial);

  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    logger?.info(`daemon shutting down (${signal})`);
    for (const w of watchers.values()) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    clearPidFile();
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => logger?.error(`uncaught: ${errorInfo(err).stack}`));
  process.on("unhandledRejection", (err) => logger?.error(`unhandled rejection: ${errorInfo(err).stack}`));

  function scheduleRun(trigger, delayMs = 0) {
    if (stopping) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void runOnce(trigger);
    }, Math.max(0, delayMs));
  }

  async function runOnce(trigger) {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      const lock = acquireLock({ owner: "daemon" });
      if (!lock.ok) {
        logger?.warn(`skipping run (${trigger}): another run holds the lock (pid ${lock.holder?.pid})`);
        return;
      }
      const registry = loadRegistry();
      const state = loadState();
      state.runner.pid = process.pid;
      state.runner.startedAt = state.runner.startedAt || nowIso();
      const result = await runPatches({ registry, state, logger, opts: { trigger } });
      saveState(state);
      logger?.info(
        `run (${trigger}) done in ${result.durationMs}ms — changed ${result.changed}, conflicts ${result.conflicts}, patches ${result.results
          .map((r) => `${r.id}:${r.status}`)
          .join(",")}`,
      );
      await syncWatchers(registry, state);
      if (intervalTimer) clearInterval(intervalTimer);
      const every = Number(registry.settings?.watch?.intervalMs ?? intervalMs ?? 300_000);
      intervalTimer = setInterval(() => scheduleRun("interval"), Math.max(15_000, every));
    } catch (err) {
      logger?.error(`run (${trigger}) failed: ${errorInfo(err).stack}`);
    } finally {
      releaseLock();
      running = false;
      if (pending) {
        pending = false;
        scheduleRun("queued", 750);
      }
    }
  }

  function addWatcher(dir) {
    if (watchers.has(dir)) return;
    try {
      const watcher = watch(dir, { recursive: false }, (_event, filename) => {
        const name = filename ? String(filename) : "";
        if (ignored(name)) return;
        logger?.debug(`fs change in ${dir}: ${name}`);
        scheduleRun(`watch:${name || dir}`, 1200);
      });
      watcher.on("error", (err) => {
        logger?.warn(`watcher error on ${dir}: ${errorInfo(err).message}`);
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
        watchers.delete(dir);
      });
      watchers.set(dir, watcher);
      logger?.debug(`watching ${dir}`);
    } catch (err) {
      logger?.warn(`cannot watch ${dir}: ${errorInfo(err).message}`);
    }
  }

  async function syncWatchers(registry, state) {
    const roots = new Set([
      ...defaultPiRoots(),
      ...registryWatchRoots(registry),
      ...(await collectModuleWatchPaths({ registry, state, logger })),
    ]);
    for (const dir of roots) {
      if (existsSync(dir)) addWatcher(dir);
    }
  }

  logger?.info(`daemon started (pid ${process.pid}) — patches dir ${ROOT}`);
  await runOnce("daemon-start");
  if (!intervalTimer) {
    const every = Number(intervalMs ?? 300_000);
    intervalTimer = setInterval(() => scheduleRun("interval"), Math.max(15_000, every));
  }
  // keep the event loop alive
  await new Promise(() => {});
}
