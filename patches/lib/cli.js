// CLI for the patch runner. Everything the daemon does can be done by hand here.
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_DIR,
  PATHS,
  ROOT,
  STATUS_STYLE,
  acquireLock,
  c,
  createLogger,
  errorInfo,
  fileStamp,
  fmtBytes,
  readPidFile,
  readText,
  relTime,
  releaseLock,
  setColor,
  toPosix,
} from "./util.js";
import {
  defaultPiRoots,
  findPatchEntry,
  loadPatchModule,
  loadRegistry,
  registryWatchRoots,
  resolvePatchModule,
} from "./registry.js";
import { loadState, resolveConflicts, saveState, setPatchEnabled, stateSummary } from "./state.js";
import { collectModuleWatchPaths, resolveParams, revertPatches, runPatches, verifyPatches } from "./engine.js";
import { openReport, reportPath, writeConflictReport } from "./report.js";
import { hookStatus, installHook, uninstallHook, ensureHookInstalled, hookTargets } from "./hook.js";
import {
  autostartState,
  daemonInfo,
  daemonLogs,
  daemonStatusText,
  runDaemonForeground,
  setAutostart,
  startDaemon,
  stopDaemon,
} from "./daemon.js";

const VERSION = "1.0.0";

const HELP = `
${c.bold("pi patches")} ${c.gray(`v${VERSION}`)} — ${ROOT}

${c.bold("USAGE")}
  node mainrunner.js <command> [options]

${c.bold("COMMANDS")}
  run                       Apply every enabled patch (idempotent)
  apply [id...]             Apply one or more patches (implies --force)
  revert [id...]            Revert patches using the module hook or the backup
  verify [id...]            Check whether patches are still applied
  status                    Overview: patches, daemon, last run, conflicts
  list                      Registered patches and their module paths
  enable <id>               Enable a patch
  disable <id>              Disable a patch (stops future auto-apply)
  history [id]              Timeline of applies / reverts / failures
  conflicts                 List recorded conflicts (--all, --resolve <id|all>, --reopen)
  report                    Rebuild conflicts.html from stored conflicts (--open)
  daemon <sub>              start | stop | restart | status | logs | autostart
  hook [install|status|uninstall]
                            Wire the runner into pi's launcher (pi-start trigger)
  doctor                    Diagnose environment, registry and patch modules
  reset-state               Reset state.json, keeping backups (--yes)
  help                      This text

${c.bold("OPTIONS")}
  --dry-run        Show what would change, write nothing
  --force          Re-run even when the state says a patch is already applied
  --targets        revert: un-patch every discovered target, even untracked files
  --patch <id>     Limit to one patch (repeatable: --patch a --patch b)
  --json           Machine readable output
  --no-open        Do not open conflicts.html automatically
  --no-report      Do not write conflicts.html
  --trigger <name> Label the run in history/log (e.g. pi-start)
  --no-hook        Do not re-install the pi-start hook during this run
  --no-color       Plain output
  --quiet          Only errors
  --verbose        Include debug logging
  -h, --help       This text

${c.bold("ENV")}
  PI_CODING_AGENT_DIR   overrides ~/.pi/agent
  PI_PATCHES_DIR        overrides the patches folder location
  patch params          any param with an env name (e.g. PI_IMAGE_RESIZE_WIDTH)
`;

// ---------------------------------------------------------------- arg parsing

const VALUE_FLAGS = new Set(["patch", "limit", "lines", "interval", "set", "trigger"]);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      if (VALUE_FLAGS.has(key) && argv[i + 1] && !argv[i + 1].startsWith("--")) {
        const value = argv[++i];
        flags[key] = flags[key] === undefined ? value : [].concat(flags[key], value);
        continue;
      }
      flags[key] = true;
      continue;
    }
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    positional.push(arg);
  }
  return { flags, positional };
}

function collectOnly(flags, positional) {
  const raw = [];
  for (const value of [].concat(flags.patch ?? [])) if (value && value !== true) raw.push(value);
  for (const value of positional) if (value && value !== "all") raw.push(value);
  return [...new Set(raw)];
}

// ---------------------------------------------------------------- output helpers

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleLength(text) {
  return stripAnsi(text).length;
}

function padCell(text, width) {
  const gap = width - visibleLength(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

function clip(text, width) {
  const plain = String(text);
  if (visibleLength(plain) <= width) return plain;
  return `${plain.slice(0, Math.max(1, width - 1))}…`;
}

/** columns: [{ label, key, width, max }] */
function table(columns, rows, { indent = "  " } = {}) {
  if (!rows.length) return `${indent}${c.gray("(nothing)")}`;
  const cells = rows.map((row) =>
    columns.map((col) => {
      const value = typeof col.value === "function" ? col.value(row) : row[col.key];
      return value === undefined || value === null || value === "" ? c.gray("—") : String(value);
    }),
  );
  const widths = columns.map((col, i) => {
    const natural = Math.max(visibleLength(col.label), ...cells.map((row) => visibleLength(row[i])));
    const max = col.max || col.width || 60;
    return Math.min(natural, max);
  });
  const head = `${indent}${columns.map((col, i) => c.bold(padCell(col.label.toUpperCase(), widths[i]))).join("  ")}`;
  const sep = `${indent}${c.gray(widths.map((w) => "─".repeat(w)).join("  "))}`;
  const body = cells.map(
    (row) => `${indent}${row.map((cell, i) => padCell(clip(cell, widths[i]), widths[i])).join("  ")}`,
  );
  return [head, sep, ...body].join("\n");
}

function banner(title, subtitle) {
  const width = Math.max(visibleLength(title) + 4, 60);
  const line = c.gray("─".repeat(width));
  return [
    "",
    `${c.bold(title)}${subtitle ? `  ${c.gray(subtitle)}` : ""}`,
    line,
  ].join("\n");
}

function kv(pairs, { indent = "  " } = {}) {
  const width = Math.max(...pairs.map((p) => visibleLength(p[0])));
  return pairs
    .filter((p) => p[1] !== undefined && p[1] !== null && p[1] !== "")
    .map((p) => `${indent}${c.gray(padCell(p[0], width))}  ${p[1]}`)
    .join("\n");
}

function statusPill(status) {
  const text = String(status ?? "unknown");
  const padded = ` ${text} `;
  switch (text) {
    case "applied":
    case "ok":
    case "reverted":
      return text === "reverted" ? c.magenta(padded) : c.bgGreen(padded);
    case "failed":
    case "conflict":
    case "error":
      return c.bgRed(padded);
    case "clean":
      return c.cyan(padded);
    case "would-apply":
    case "pending":
    case "drift":
    case "no-targets":
    case "missing":
      return c.bgYellow(padded);
    case "disabled":
    case "skipped":
      return c.gray(padded);
    default: {
      const paint = STATUS_STYLE[text] || c.white;
      return paint(padded);
    }
  }
}

function jsonOut(value) {
  console.log(JSON.stringify(value, null, 2));
}

function loggerFor(flags) {
  return createLogger({
    level: flags.verbose ? "debug" : "info",
    quiet: true,
    echo: false,
  });
}

function err(message) {
  console.error(`${c.red("✗")} ${message}`);
}

function ok(message) {
  console.log(`${c.green("✓")} ${message}`);
}

// ---------------------------------------------------------------- commands

function printRunResult(result, flags) {
  const rows = result.results.map((r) => ({
    id: r.id,
    status: statusPill(r.status),
    files: `${r.files.filter((f) => ["applied", "applied-unverified", "would-apply", "reverted"].includes(f.status)).length}/${r.files.length}`,
    params: Object.entries(r.params || {}).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(";") : v}`).join(" ") || c.gray("—"),
    message: r.message,
  }));
  console.log(
    banner(
      result.action === "revert" ? "revert" : flags["dry-run"] ? "run (dry-run)" : "run",
      `${result.durationMs}ms · trigger ${result.trigger}${result.dryRun ? " · no files written" : ""}`,
    ),
  );
  console.log(
    table(
      [
        { label: "patch", key: "id", max: 24 },
        { label: "status", key: "status", max: 16 },
        { label: "files", key: "files", max: 8 },
        { label: "params", key: "params", max: 34 },
        { label: "result", key: "message", max: 46 },
      ],
      rows,
    ),
  );

  for (const r of result.results) {
    const interesting = r.files.filter((f) => f.status !== "clean" && f.status !== "skipped");
    if (!interesting.length) continue;
    console.log(`\n  ${c.bold(r.id)}`);
    for (const f of interesting) {
      const detail = f.diffStat ? c.gray(` +${f.diffStat.added}/-${f.diffStat.removed}`) : "";
      const size = f.bytesBefore !== undefined && f.bytesAfter !== undefined ? c.gray(` ${fmtBytes(f.bytesBefore)}→${fmtBytes(f.bytesAfter)}`) : "";
      console.log(`    ${statusPill(f.status)} ${toPosix(f.file)}${size}${detail}`);
      if (f.summary) console.log(`      ${c.gray(f.summary)}`);
    }
    if (r.warnings && r.warnings.length) {
      for (const warning of r.warnings) {
        console.log(`    ${c.yellow("!")} param ${warning.param}: ${warning.reason} (from ${warning.source}) → using ${JSON.stringify(warning.used)}`);
      }
    }
  }

  if (result.conflictList && result.conflictList.length) {
    console.log(`\n${c.red("conflicts")} ${result.conflictList.length}`);
    for (const conflict of result.conflictList) {
      const where = conflict.file ? ` ${c.gray(toPosix(conflict.file))}` : "";
      console.log(`  ${conflict.severity === "warn" ? c.yellow("warn") : c.red("error")} ${c.bold(conflict.patchId)} ${conflict.kind}${where}`);
      console.log(`    ${conflict.message}`);
      if (conflict.stack) {
        const first = conflict.stack.split(/\r?\n/).slice(0, 3).join("\n    ");
        console.log(c.gray(`    ${first}`));
      }
    }
    if (result.report) {
      console.log(
        `\n  ${c.cyan("report")} ${toPosix(result.report.file)}${result.report.opened ? c.gray(" (opened)") : ""}`,
      );
      console.log(`  ${c.gray("copy the stacktrace to your agent, or run:")} node mainrunner.js report --open`);
    }
  } else if (result.changed === 0) {
    console.log(`\n  ${c.green("✓")} everything already up to date`);
  }

  if (result.autoResolved) {
    console.log(`
  ${c.green("✓")} closed ${result.autoResolved} previously reported conflict(s)`);
  }

  if (!flags["dry-run"] && result.changed > 0) {
    console.log(`\n  ${c.yellow("↻")} restart pi to pick up patched files`);
  }
}

async function cmdRun(flags, positional, { force = false, action = "apply" } = {}) {
  const registry = loadRegistry();
  const state = loadState();
  const logger = loggerFor(flags);
  const only = collectOnly(flags, positional);
  const lock = acquireLock({ owner: "cli", steal: Boolean(flags.force) });
  if (!lock.ok) {
    err(`another run is in progress (pid ${lock.holder?.pid}, owner ${lock.holder?.owner}) — use --force to take over`);
    return 1;
  }
  try {
    const result =
      action === "revert"
        ? await revertPatches({
            registry,
            state,
            logger,
            opts: {
              only,
              dryRun: Boolean(flags["dry-run"]),
              allTargets: Boolean(flags.targets),
              trigger: flags.trigger || "cli",
              noReport: Boolean(flags["no-report"]),
              open: !flags["no-open"],
            },
          })
        : await runPatches({
            registry,
            state,
            logger,
            opts: {
              only,
              dryRun: Boolean(flags["dry-run"]),
              force: force || Boolean(flags.force),
              trigger: flags.trigger || "cli",
              noReport: Boolean(flags["no-report"]),
              open: !flags["no-open"],
            },
          });
    saveState(state);
    if (action !== "revert" && !flags["dry-run"] && !flags["no-hook"] && !flags.quiet) {
      const heal = ensureHookInstalled({ logger });
      if (heal.healed) console.log(`  ${c.green("✓")} re-installed the pi-start hook (launcher was reset)`);
    }
    if (flags.json) {
      jsonOut(result);
    } else if (!flags.quiet) {
      printRunResult(result, flags);
    } else if (!result.ok) {
      err(`${result.conflicts} conflict(s) — see ${toPosix(reportPath(registry.settings?.report))}`);
    }
    return result.ok ? 0 : 1;
  } finally {
    releaseLock();
  }
}

function cmdStatus(flags) {
  const registry = loadRegistry();
  const state = loadState();
  const summary = stateSummary(state);
  const daemon = daemonInfo();
  const patchStates = Object.values(state.patches);

  if (flags.json) {
    jsonOut({ summary, daemon, patches: patchStates, registry: registry.patches, paths: PATHS });
    return 0;
  }

  console.log(banner("pi patches — status", ROOT));
  console.log(
    kv([
      ["daemon", daemon.alive ? c.green(`running (pid ${daemon.pid})`) : c.gray("stopped")],
      ["autostart", autostartState().enabled ? c.green("on") : c.gray("off")],
      ["last run", summary.lastRunAt ? `${relTime(summary.lastRunAt)} ${c.gray(state.runner.lastTrigger || "")}` : c.gray("never")],
      ["runs", String(summary.runs)],
      ["files changed", String(summary.filesChanged)],
      ["registry", toPosix(PATHS.registry)],
      ["state", toPosix(PATHS.state)],
      ["report", toPosix(reportPath(registry.settings?.report))],
    ]),
  );

  console.log(`\n${c.bold("patches")}`);
  const rows = registry.patches.map((entry) => {
    const patchState = state.patches[entry.id] || {};
    const applied = (patchState.files || []).filter((f) => f.status === "applied" || f.status === "applied-unverified");
    const enabled = entry.enabled !== false && patchState.enabled !== false;
    return {
      id: entry.id,
      name: entry.name || "",
      status: statusPill(patchState.status || "unknown"),
      enabled: enabled ? c.green("yes") : c.gray("no"),
      files: String(applied.length),
      last: patchState.lastRunAt ? relTime(patchState.lastRunAt) : c.gray("never"),
      params: Object.entries(patchState.params || {})
        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(";") : v}`)
        .join(" "),
    };
  });
  console.log(
    table(
      [
        { label: "id", key: "id", max: 26 },
        { label: "status", key: "status", max: 16 },
        { label: "on", key: "enabled", max: 4 },
        { label: "files", key: "files", max: 6 },
        { label: "last run", key: "last", max: 14 },
        { label: "params", key: "params", max: 40 },
      ],
      rows,
    ),
  );

  const open = (state.conflicts || []).filter((x) => !x.resolved);
  console.log(
    `\n${c.bold("conflicts")} ${open.length ? c.red(String(open.length)) : c.green("0")}` +
      (open.length ? `  ${c.gray("see")} ${toPosix(reportPath(registry.settings?.report))}` : ""),
  );
  if (open.length) {
    for (const conflict of open.slice(0, 5)) {
      console.log(`  ${c.red("•")} ${c.bold(conflict.patchId)} ${conflict.kind}: ${conflict.message}`);
    }
    if (open.length > 5) console.log(`  ${c.gray(`… ${open.length - 5} more`)}`);
  }
  return 0;
}

function cmdList(flags) {
  const registry = loadRegistry();
  const state = loadState();
  if (flags.json) {
    jsonOut(
      registry.patches.map((entry) => ({
        ...entry,
        resolvedModule: resolvePatchModule(entry),
        state: state.patches[entry.id] || null,
      })),
    );
    return 0;
  }
  console.log(banner("registered patches", `${registry.patches.length} in ${toPosix(PATHS.registry)}`));
  console.log(
    table(
      [
        { label: "id", key: "id", max: 26 },
        { label: "name", key: "name", max: 34 },
        { label: "prio", key: "priority", max: 6 },
        { label: "module", key: "module", max: 62 },
      ],
      registry.patches.map((entry) => ({
        id: entry.id,
        name: entry.name || "",
        priority: String(entry.priority ?? 100),
        module: resolvePatchModule(entry) ? toPosix(resolvePatchModule(entry)) : c.red(`missing: ${entry.module || "?"}`),
      })),
    ),
  );
  const missing = registry.patches.filter((entry) => !resolvePatchModule(entry));
  if (missing.length) {
    console.log(`\n${c.yellow("!")} ${missing.length} patch module(s) could not be found — check the "module" paths.`);
  }
  return 0;
}

function cmdToggle(flags, positional, enabled) {
  const ids = collectOnly(flags, positional);
  if (!ids.length) {
    err(`usage: node mainrunner.js ${enabled ? "enable" : "disable"} <patch-id>`);
    return 2;
  }
  const registry = loadRegistry();
  const state = loadState();
  let code = 0;
  for (const id of ids) {
    const entry = findPatchEntry(registry, id);
    if (!entry) {
      err(`unknown patch: ${id} (see: node mainrunner.js list)`);
      code = 2;
      continue;
    }
    const rec = setPatchEnabled(state, id, enabled);
    rec.status = enabled ? rec.status || "pending" : "disabled";
    console.log(`${enabled ? c.green("✓ enabled ") : c.gray("⊘ disabled")} ${c.bold(id)} ${c.gray(entry.name || "")}`);
  }
  saveState(state);
  return code;
}

function cmdHistory(flags, positional) {
  const state = loadState();
  const ids = collectOnly(flags, positional);
  const limit = Number(flags.limit || 30);
  const entries = (ids.length ? state.history.filter((h) => ids.includes(h.patchId)) : state.history).slice(0, limit);
  if (flags.json) {
    jsonOut(entries);
    return 0;
  }
  console.log(banner("history", `${entries.length} of ${state.history.length} entries`));
  if (!entries.length) {
    console.log(`  ${c.gray("no history yet")}`);
    return 0;
  }
  console.log(
    table(
      [
        { label: "when", value: (e) => relTime(e.ts), max: 12 },
        { label: "patch", key: "patchId", max: 24 },
        { label: "action", key: "action", max: 10 },
        { label: "status", value: (e) => statusPill(e.status), max: 16 },
        { label: "message", key: "message", max: 56 },
      ],
      entries,
    ),
  );
  return 0;
}

function cmdConflicts(flags, positional = []) {
  const registry = loadRegistry();
  const state = loadState();
  const recorded = state.conflicts || [];

  if (flags.clear) {
    const count = recorded.length;
    state.conflicts = [];
    saveState(state);
    ok(`cleared ${count} recorded conflict(s)`);
    return 0;
  }

  if (flags.resolve !== undefined || flags.reopen !== undefined) {
    const raw = flags.reopen !== undefined ? flags.reopen : flags.resolve;
    const reopen = flags.reopen !== undefined;
    const want = String((typeof raw === "string" && raw) || positional.join(" ") || "").trim();
    if (!want) {
      err(`${reopen ? "--reopen" : "--resolve"} needs a conflict id, a patch id, or "all"`);
      return 2;
    }
    const result = resolveConflicts(state, {
      all: want === "all",
      ids: want === "all" ? [] : [want],
      by: "cli",
      reopen,
    });
    if (!result.changed) {
      err(`no ${reopen ? "resolved" : "open"} conflict matched "${want}"`);
      console.log(`  ${c.gray("see:")} node mainrunner.js conflicts --all`);
      return 1;
    }
    saveState(state);
    ok(`${reopen ? "re-opened" : "resolved"} ${result.changed} conflict(s) — ${reopen ? "back in the open list" : "kept in state, excluded from open counts"}`);
    return 0;
  }

  const open = recorded.filter((x) => !x.resolved);
  const resolved = recorded.filter((x) => x.resolved);
  const rows = flags.all ? [...open, ...resolved] : open;

  if (flags.json) {
    jsonOut(flags.all ? recorded : open);
    return 0;
  }

  console.log(banner("conflicts", `${open.length} open${resolved.length ? ` · ${resolved.length} resolved` : ""}`));
  if (!rows.length) {
    console.log(`  ${c.green("✓")} none — every patch applied cleanly on its last run`);
    return 0;
  }
  console.log(
    table(
      [
        { label: "when", value: (x) => relTime(x.ts), max: 12 },
        { label: "state", value: (x) => (x.resolved ? c.green("resolved") : c.red("open")), max: 8 },
        { label: "sev", value: (x) => (x.severity === "warn" ? c.yellow("warn") : c.red("error")), max: 6 },
        { label: "patch", key: "patchId", max: 20 },
        { label: "kind", key: "kind", max: 12 },
        { label: "message", key: "message", max: 46 },
        { label: "id", key: "id", max: 20 },
      ],
      rows,
    ),
  );
  if (open.length) {
    console.log(`
  ${c.gray("resolve one:")} node mainrunner.js conflicts --resolve <id>`);
    console.log(`  ${c.gray("resolve all:")} node mainrunner.js conflicts --resolve all   ${c.gray("· they also auto-close when the patch runs clean again")}`);
  }
  console.log(`  ${c.gray("full report:")} node mainrunner.js report --open`);
  return open.length ? 1 : 0;
}

function cmdReport(flags) {
  const registry = loadRegistry();
  const state = loadState();
  const conflicts = state.conflicts || [];
  const file = writeConflictReport({ registry, state, conflicts, settings: registry.settings?.report });
  ok(`wrote ${toPosix(file)} (${conflicts.length} conflict(s))`);
  if (flags.open) {
    const opened = openReport(file, loggerFor(flags));
    console.log(`  ${opened ? c.green("opened in your browser") : c.yellow("could not open automatically")} ${c.gray(openHint(file))}`);
  } else {
    console.log(`  ${c.gray("open it with:")} ${openHint(file)}`);
  }
  return 0;
}

/** The shell command that opens a file in the local browser, per platform. */
function openHint(file) {
  const target = toPosix(file);
  if (process.platform === "win32") return `start "" "${target}"`;
  return `${process.platform === "darwin" ? "open" : "xdg-open"} "${target}"`;
}

async function cmdVerify(flags, positional) {
  const registry = loadRegistry();
  const state = loadState();
  const logger = loggerFor(flags);
  const only = collectOnly(flags, positional);
  const result = await verifyPatches({ registry, state, logger, opts: { only } });
  if (flags.json) {
    jsonOut(result);
    return result.ok ? 0 : 1;
  }
  console.log(banner("verify", result.ok ? "all patches applied" : "attention needed"));
  console.log(
    table(
      [
        { label: "patch", key: "id", max: 26 },
        { label: "status", value: (r) => statusPill(r.status), max: 16 },
        { label: "applied", value: (r) => String(r.counts?.applied ?? 0), max: 8 },
        { label: "drift", value: (r) => String(r.counts?.drift ?? 0), max: 6 },
        { label: "missing", value: (r) => String(r.counts?.missing ?? 0), max: 8 },
        { label: "note", key: "message", max: 46 },
      ],
      result.rows,
    ),
  );
  const drift = result.rows.filter((r) => r.status === "drift");
  if (drift.length) {
    console.log(`\n  ${c.yellow("!")} ${drift.length} patch(es) are no longer applied — run ${c.bold("node mainrunner.js run")}`);
  }
  return result.ok ? 0 : 1;
}

async function cmdHook(flags, positional) {
  const action = positional[0] || "status";
  if (action === "status") {
    const status = hookStatus();
    if (flags.json) {
      jsonOut(status);
      return status.installed ? 0 : 1;
    }
    console.log(banner("pi-start hook", ROOT));
    console.log(
      kv([
        ["trigger", `${toPosix(status.trigger)} ${status.triggerExists ? c.green("✓") : c.red("missing")}`],
        ["installed",
          !status.hasTargets
            ? c.gray("no launcher found")
            : status.allInstalled
              ? c.green("yes (every launcher)")
              : status.installed
                ? c.yellow("partial")
                : c.gray("no")],
        ["disabled", status.disabledEnv ? c.yellow("yes — PI_PATCHES_DISABLE=1 is set") : c.gray("no")],
      ]),
    );
    console.log(`
${c.bold("launchers")}`);
    console.log(
      table(
        [
          { label: "kind", key: "kind", max: 6 },
          { label: "hook", value: (row) => (row.installed ? c.green("installed") : row.exists ? c.yellow("missing") : c.gray("absent")), max: 12 },
          { label: "what", key: "label", max: 40 },
          { label: "file", key: "file", max: 62 },
        ],
        status.targets,
      ),
    );
    if (!status.installed) console.log(`
  ${c.gray("install with")} node mainrunner.js hook install`);
    return status.installed ? 0 : 1;
  }
  if (action === "install" || action === "uninstall") {
    const result = action === "install" ? installHook({ dryRun: Boolean(flags["dry-run"]) }) : uninstallHook({ dryRun: Boolean(flags["dry-run"]) });
    if (flags.json) {
      jsonOut(result);
      return result.ok ? 0 : 1;
    }
    console.log(banner(`hook ${action}`, ROOT));
    for (const change of result.changes) {
      const icon = change.action === "installed" || change.action === "would-install" || change.action === "removed" || change.action === "would-remove"
        ? c.green("✓")
        : change.action === "missing" ? c.red("✗") : c.gray("·");
      console.log(`  ${icon} ${c.bold(padCell(change.action, 13))} ${toPosix(change.file)} ${c.gray(change.label || "")}`);
    }
    if (result.message) console.log(`  ${c.yellow(result.message)}`);
    if (action === "install" && result.ok) {
      console.log(`
  ${c.gray("patches now apply in the background whenever pi starts (takes effect on the next pi launch)")}`);
      console.log(`  ${c.gray("disable ad hoc with")} PI_PATCHES_DISABLE=1 ${c.gray("or")} node mainrunner.js hook uninstall`);
    }
    return result.ok ? 0 : 1;
  }
  err(`unknown hook action: ${action}`);
  console.log(`  ${c.gray("install | status | uninstall")}`);
  return 2;
}

async function cmdDoctor(flags) {
  const checks = [];
  const add = (level, name, detail) => checks.push({ level, name, detail });

  add("ok", "node", `${process.version} (${process.platform}/${process.arch})`);
  add("ok", "patches dir", toPosix(ROOT));
  add("info", "agent dir", toPosix(AGENT_DIR));

  // writability
  try {
    const probe = join(ROOT, `.doctor-${fileStamp()}.tmp`);
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    add("ok", "writable", "patches dir is writable");
  } catch (err) {
    add("error", "writable", `cannot write to ${toPosix(ROOT)}: ${errorInfo(err).message}`);
  }

  // registry + state parse
  let registry = null;
  let state = null;
  try {
    registry = loadRegistry();
    add("ok", "registry", `${registry.patches.length} patch(es) in ${toPosix(PATHS.registry)}`);
  } catch (err) {
    add("error", "registry", errorInfo(err).message);
  }
  try {
    state = loadState();
    add("ok", "state", `${Object.keys(state.patches).length} patch record(s), ${state.runs.length} run(s)`);
  } catch (err) {
    add("error", "state", errorInfo(err).message);
  }

  if (registry) {
    for (const entry of registry.patches) {
      const file = resolvePatchModule(entry);
      if (!file) {
        add("error", `module ${entry.id}`, `not found: ${entry.module || join(entry.id, "index.js")}`);
        continue;
      }
      try {
        const mod = await loadPatchModule(entry);
        const { params, warnings } = resolveParams(entry, mod);
        const ctx = {
          patch: entry,
          mod,
          params,
          state,
          registry,
          settings: registry.settings,
          agentDir: AGENT_DIR,
          patchesDir: ROOT,
          paths: PATHS,
          dryRun: true,
        };
        let targetCount = "n/a";
        try {
          targetCount = String((await mod.targets(ctx)).length);
        } catch (err) {
          add("error", `targets ${entry.id}`, errorInfo(err).message);
        }
        add(
          "ok",
          `module ${entry.id}`,
          `${toPosix(file)} · targets ${targetCount} · params ${JSON.stringify(params)}`,
        );
        for (const warning of warnings) {
          add("warn", `param ${entry.id}.${warning.param}`, `${warning.reason} (from ${warning.source}) — using ${JSON.stringify(warning.used)}`);
        }
      } catch (err) {
        add("error", `module ${entry.id}`, errorInfo(err).message);
      }
    }
    const roots = [...new Set([...defaultPiRoots(), ...registryWatchRoots(registry)])];
    add("info", "watch roots", roots.length ? roots.map(toPosix).join(", ") : "none");
    if (state) {
      const extra = await collectModuleWatchPaths({ registry, state, logger: loggerFor(flags) });
      if (extra.length) add("info", "patch watch paths", extra.map(toPosix).join(", "));
    }
  }

  const hook = hookStatus();
  add(
    hook.installed ? "ok" : "warn",
    "pi-start hook",
    !hook.hasTargets
      ? `no pi launcher found — looked for ${hook.targets.map((t) => toPosix(t.file)).join(", ")}`
      : hook.installed
        ? `${hook.allInstalled ? "installed" : "partially installed"} in ${hook.targets.filter((t) => t.installed).map((t) => toPosix(t.file)).join(", ")}`
        : `not installed — run: node mainrunner.js hook install`,
  );
  if (hook.disabledEnv) add("warn", "hook disabled", "PI_PATCHES_DISABLE=1 is set, the trigger exits immediately");

  const daemon = daemonInfo();
  add(daemon.alive ? "ok" : "info", "daemon", daemonStatusText());
  const autostart = autostartState();
  add("info", "autostart", autostart.supported ? (autostart.enabled ? `on (${toPosix(autostart.file)})` : "off") : "unsupported on this platform");

  // patch env vars
  const envs = Object.entries(process.env)
    .filter(([key]) => /^PI_.*(WIDTH|HEIGHT|MAX|SIZE)/.test(key))
    .map(([key, value]) => `${key}=${value}`);
  add("info", "patch env", envs.length ? envs.join(" ") : "no patch-related env vars set");

  if (flags.json) {
    jsonOut({ checks, daemon, autostart });
    return checks.some((x) => x.level === "error") ? 1 : 0;
  }

  console.log(banner("doctor", ROOT));
  const icon = { ok: c.green("✓"), warn: c.yellow("!"), error: c.red("✗"), info: c.gray("·") };
  const width = Math.max(...checks.map((x) => x.name.length));
  for (const check of checks) {
    console.log(`  ${icon[check.level] || "·"} ${c.bold(padCell(check.name, width))}  ${check.detail}`);
  }
  const errors = checks.filter((x) => x.level === "error").length;
  const warns = checks.filter((x) => x.level === "warn").length;
  console.log(
    `\n  ${errors ? c.red(`${errors} error(s)`) : c.green("no errors")}${warns ? `, ${c.yellow(`${warns} warning(s)`)}` : ""}`,
  );
  return errors ? 1 : 0;
}

function cmdResetState(flags) {
  if (!flags.yes) {
    err("this deletes state.json (backups are kept). Re-run with --yes");
    return 2;
  }
  const backup = `${PATHS.state}.${fileStamp()}.bak`;
  try {
    if (existsSync(PATHS.state)) writeFileSync(backup, readText(PATHS.state) || "", "utf8");
    const fresh = loadState();
    fresh.patches = {};
    fresh.runs = [];
    fresh.history = [];
    fresh.conflicts = [];
    fresh.stats = { runs: 0, applied: 0, reverted: 0, failed: 0, conflicts: 0, filesChanged: 0 };
    saveState(fresh);
    ok(`state reset${existsSync(backup) ? ` (old file: ${toPosix(backup)})` : ""}`);
    return 0;
  } catch (err2) {
    err(`could not reset state: ${errorInfo(err2).message}`);
    return 1;
  }
}

async function cmdDaemon(flags, positional) {
  const sub = flags.foreground ? "foreground" : positional[0] || "status";
  const logger = createLogger({
    level: flags.verbose ? "debug" : "info",
    quiet: false,
    // In foreground mode stdout/stderr already point at runner.log, so echoing would
    // write every line twice.
    echo: sub !== "foreground" && sub !== "run",
  });
  switch (sub) {
    case "start": {
      const result = startDaemon({ logger });
      if (result.already) ok(`daemon already running (pid ${result.pid})`);
      else ok(`daemon started (pid ${result.pid}) — logs: ${toPosix(PATHS.log)}`);
      return 0;
    }
    case "stop": {
      const result = stopDaemon({ logger });
      if (result.already) console.log(`${c.gray("⊘")} daemon was not running`);
      else ok(`daemon stopped (pid ${result.pid})`);
      return 0;
    }
    case "restart": {
      stopDaemon({ logger });
      const result = startDaemon({ logger });
      ok(`daemon restarted (pid ${result.pid})`);
      return 0;
    }
    case "status": {
      const info = daemonInfo();
      if (flags.json) {
        jsonOut({ ...info, autostart: autostartState() });
        return 0;
      }
      console.log(banner("daemon", ROOT));
      console.log(
        kv([
          ["state", info.alive ? c.green(`running (pid ${info.pid})`) : c.gray("stopped")],
          ["since", info.startedAt ? `${info.startedAt} (${relTime(info.startedAt)})` : c.gray("—")],
          ["pid file", toPosix(PATHS.pid)],
          ["log", toPosix(PATHS.log)],
          ["autostart", autostartState().enabled ? c.green("on") : c.gray("off")],
        ]),
      );
      return 0;
    }
    case "logs": {
      const lines = daemonLogs(Number(flags.lines || 40));
      if (!lines.length) {
        console.log(`${c.gray("(no log output yet)")} ${toPosix(PATHS.log)}`);
        return 0;
      }
      console.log(lines.join("\n"));
      return 0;
    }
    case "autostart": {
      const action = positional[1] || "status";
      if (action === "status") {
        const state = autostartState();
        console.log(
          kv([
            ["supported", state.supported ? "yes" : "no"],
            ["enabled", state.enabled ? c.green("yes") : c.gray("no")],
            ["file", state.file ? toPosix(state.file) : c.gray("—")],
          ]),
        );
        return 0;
      }
      if (action !== "on" && action !== "off") {
        err("usage: node mainrunner.js daemon autostart <on|off|status>");
        return 2;
      }
      try {
        const result = setAutostart(action === "on");
        ok(`autostart ${result.enabled ? "enabled" : "disabled"} ${c.gray(toPosix(result.file))}`);
        return 0;
      } catch (err2) {
        err(errorInfo(err2).message);
        return 1;
      }
    }
    case "run":
    case "--foreground":
    case "foreground": {
      await runDaemonForeground({ logger, intervalMs: Number(flags.interval || 0) || undefined });
      return 0;
    }
    default:
      err(`unknown daemon subcommand: ${sub}`);
      console.log(`  ${c.gray("start | stop | restart | status | logs | autostart <on|off> | foreground")}`);
      return 2;
  }
}

// ---------------------------------------------------------------- entry

export async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  if (flags.color) setColor(true);
  if (flags["no-color"]) setColor(false);

  const command = positional.shift() || (flags.help ? "help" : "");
  if ((flags.help && command !== "help") || command === "") {
    console.log(HELP);
    return 0;
  }

  switch (command) {
    case "run":
      return cmdRun(flags, positional);
    case "apply":
      return cmdRun(flags, positional, { force: true });
    case "revert":
      return cmdRun(flags, positional, { action: "revert" });
    case "verify":
      return cmdVerify(flags, positional);
    case "status":
      return cmdStatus(flags);
    case "list":
    case "ls":
      return cmdList(flags);
    case "enable":
      return cmdToggle(flags, positional, true);
    case "disable":
      return cmdToggle(flags, positional, false);
    case "history":
    case "log":
      return cmdHistory(flags, positional);
    case "conflicts":
      return cmdConflicts(flags, positional);
    case "report":
      return cmdReport(flags);
    case "hook":
      return cmdHook(flags, positional);
    case "doctor":
      return cmdDoctor(flags);
    case "daemon":
      return cmdDaemon(flags, positional);
    case "reset-state":
      return cmdResetState(flags);
    case "version":
    case "--version":
      console.log(VERSION);
      return 0;
    case "help":
      console.log(HELP);
      return 0;
    default:
      err(`unknown command: ${command}`);
      console.log(HELP);
      return 2;
  }
}

export { HELP, VERSION };
