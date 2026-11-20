// conflicts.html: a self-contained, offline report you can hand straight to an agent.
import { spawn } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { HOST, PATHS, ROOT, ensureDir, errorInfo, nowIso, readText, relToRoot, writeAtomic, c } from "./util.js";
import { resolvePatchModule } from "./registry.js";

/** Sibling data file the page re-reads on refresh (a <script> load, so file:// needs no CORS). */
export function reportDataPath(settings = {}) {
  const html = reportPath(settings);
  return html.toLowerCase().endsWith(".html") ? html.slice(0, -5) + ".data.js" : html + ".data.js";
}

export function reportPath(settings = {}) {
  const configured = settings?.path || "conflicts.html";
  return isAbsolute(configured) ? configured : join(ROOT, configured);
}

function shortFiles(patchState) {
  return (patchState?.files || []).map((f) => ({
    file: f.file,
    status: f.status,
    summary: f.summary || "",
    backup: f.backup || null,
    bytesBefore: f.bytesBefore,
    bytesAfter: f.bytesAfter,
    hashBefore: f.hashBefore ? f.hashBefore.slice(0, 12) : null,
    hashAfter: f.hashAfter ? f.hashAfter.slice(0, 12) : null,
    diffStat: f.diffStat || null,
    diffPreview: f.diffPreview || null,
    appliedAt: f.appliedAt || null,
    revertedAt: f.revertedAt || null,
    revertedVia: f.revertedVia || null,
  }));
}

export function buildReportData({ registry, state, conflicts, settings }) {
  const patches = registry.patches.map((entry) => {
    const patchState = state.patches?.[entry.id] || {};
    return {
      id: entry.id,
      name: entry.name || entry.id,
      description: entry.description || "",
      enabled: entry.enabled !== false && patchState.enabled !== false,
      registryEnabled: entry.enabled !== false,
      stateEnabled: patchState.enabled !== false,
      status: patchState.status || "unknown",
      version: patchState.version || entry.version || null,
      module: resolvePatchModule(entry) || entry.module || null,
      tags: entry.tags || [],
      priority: entry.priority ?? 100,
      params: patchState.params || entry.params || {},
      paramSources: patchState.paramSources || {},
      counters: patchState.counters || {},
      lastRunAt: patchState.lastRunAt || null,
      appliedAt: patchState.appliedAt || null,
      lastSummary: patchState.lastSummary || "",
      lastError: patchState.lastError || null,
      files: shortFiles(patchState),
      history: (patchState.history || []).slice(0, 10),
    };
  });

  // The report always shows everything recorded (open and resolved); the headline counts open.
  const recorded = Array.isArray(state.conflicts) && state.conflicts.length ? state.conflicts : conflicts;
  const open = recorded.filter((x) => !x.resolved);
  const byStatus = (status) => patches.filter((p) => p.status === status).length;
  const summary = {
    conflicts: open.length,
    resolved: recorded.length - open.length,
    errors: open.filter((x) => x.severity !== "warn").length,
    warnings: open.filter((x) => x.severity === "warn").length,
    patches: patches.length,
    applied: byStatus("applied") + byStatus("clean"),
    clean: byStatus("clean"),
    failed: byStatus("failed"),
    disabled: patches.filter((p) => !p.enabled).length,
    reverted: byStatus("reverted"),
    drift: byStatus("drift"),
    filesChanged: state.stats?.filesChanged || 0,
    lastRunAt: state.runner?.lastRunAt || null,
    lastDurationMs: state.runner?.lastDurationMs ?? null,
  };

  return {
    meta: {
      generatedAt: nowIso(),
      reportFile: reportPath(settings),
      dataFile: reportDataPath(settings),
      refreshSeconds: Number.isFinite(Number(settings?.refreshSeconds)) ? Number(settings.refreshSeconds) : 5,
      patchesDir: ROOT,
      stateFile: PATHS.state,
      registryFile: PATHS.registry,
      logFile: PATHS.log,
      host: HOST,
    },
    summary,
    conflicts: recorded.map((x) => ({
      ...x,
      patchModule: (() => {
        const entry = registry.patches.find((p) => p.id === x.patchId);
        return entry ? resolvePatchModule(entry) : null;
      })(),
    })),
    patches,
    runs: (state.runs || []).slice(0, 25),
    history: (state.history || []).slice(0, 60),
    commands: [
      { label: "Apply everything", cmd: "node mainrunner.js run" },
      { label: "Re-apply one patch", cmd: "node mainrunner.js apply image-resize --force" },
      { label: "Revert one patch", cmd: "node mainrunner.js revert image-resize" },
      { label: "Check status", cmd: "node mainrunner.js status" },
      { label: "Verify applied state", cmd: "node mainrunner.js verify" },
      { label: "Diagnose", cmd: "node mainrunner.js doctor" },
      { label: "Show history", cmd: "node mainrunner.js history" },
      { label: "Mark a conflict resolved", cmd: "node mainrunner.js conflicts --resolve <id>" },
      { label: "Resolve every open conflict", cmd: "node mainrunner.js conflicts --resolve all" },
      { label: "Reopen a resolved conflict", cmd: "node mainrunner.js conflicts --reopen <id>" },
      { label: "Watch log", cmd: "node mainrunner.js daemon logs" },
    ],
  };
}

export function writeConflictReport({ registry, state, conflicts, settings }) {
  const file = reportPath(settings);
  ensureDir(dirname(file));
  const template = readText(PATHS.template);
  if (!template) throw new Error(`report template missing: ${PATHS.template}`);
  const data = buildReportData({ registry, state, conflicts, settings });
  const json = JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  // The data file is written first so a page polling it never sees a mismatched pair.
  writeAtomic(reportDataPath(settings), "window.__PI_PATCHES_DATA__ = " + json + ";\n");
  writeAtomic(file, template.replace("/*__PI_PATCHES_DATA__*/null", json));
  return file;
}

/** `start "" "./conflicts.html"` on Windows, from the patches folder. */
export function openReport(file, logger) {
  try {
    const cwd = dirname(file);
    const rel = `./${file.slice(cwd.length + 1)}`;
    if (process.platform === "win32") {
      const child = spawn("cmd.exe", ["/c", "start", "", rel], {
        cwd,
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.on("error", (err) => logger?.warn(`could not open report: ${errorInfo(err).message}`));
      child.unref();
      return true;
    }
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(cmd, [file], { cwd, detached: true, stdio: "ignore" });
    child.on("error", (err) => logger?.warn(`could not open report: ${errorInfo(err).message}`));
    child.unref();
    return true;
  } catch (err) {
    logger?.warn(`could not open report: ${errorInfo(err).message}`);
    return false;
  }
}

export function describeConflict(conflict) {
  return `${conflict.severity === "warn" ? "warn" : "error"} ${conflict.kind} in ${relToRoot(conflict.file || "")}`;
}
