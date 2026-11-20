// The engine: resolve params, discover targets, apply / revert / verify, record everything.
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AGENT_DIR,
  PATHS,
  ROOT,
  asArray,
  countLines,
  ensureDir,
  errorInfo,
  fileStamp,
  fmtBytes,
  nowIso,
  previewDiff,
  readText,
  relToRoot,
  sha256,
  shortHash,
  sortByPriority,
  writeAtomic,
} from "./util.js";
import { loadPatchModule, patchLabel, resolvePatchModule } from "./registry.js";
import {
  DEFAULT_LIMITS,
  getPatchState,
  pushHistory,
  recordConflicts,
  recordRun,
  upsertFileRecord,
} from "./state.js";
import { openReport, writeConflictReport } from "./report.js";

const HINTS = {
  "module-load":
    "The patch module could not be imported. Check the module path in patches.json, then run `node mainrunner.js doctor`. Usually a syntax error or a bad import path.",
  discovery:
    "The patch could not work out where to apply itself (targets() threw). Most often pi moved/renamed the files it patches. Update targets() in the patch module.",
  transform:
    "The patch found its target but the rewrite threw. The file layout probably changed upstream — update transform() and the anchor regex in the patch module.",
  "anchor-missing":
    "The patch anchor no longer exists in this file. pi most likely changed that code. Update the anchor in the patch module, or disable the patch if it is obsolete.",
  verify:
    "The patch was written but the post-write verification failed. The file may be read-only, or the transform is not idempotent.",
  write:
    "Writing the patched file failed (permissions, file locked by a running pi, or a read-only install).",
  revert:
    "Revert could not restore this file: no module revert hook and either no backup or the file changed since the patch was applied.",
  state:
    "state.json could not be read or written. Fix or delete it (a fresh one is created automatically).",
  runtime:
    "Unexpected error while running the patch. The stacktrace below is the exact failure.",
};

function coerceParam(def, raw) {
  const type = String(def.type || "string").toLowerCase();
  if (type === "int" || type === "integer") {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, reason: `expected an integer, got ${JSON.stringify(raw)}` };
    if (def.min !== undefined && n < def.min) return { ok: false, reason: `must be >= ${def.min}` };
    if (def.max !== undefined && n > def.max) return { ok: false, reason: `must be <= ${def.max}` };
    return { ok: true, value: n };
  }
  if (type === "number" || type === "float") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, reason: `expected a number, got ${JSON.stringify(raw)}` };
    return { ok: true, value: n };
  }
  if (type === "boolean" || type === "bool") {
    const s = String(raw).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return { ok: true, value: true };
    if (["0", "false", "no", "off"].includes(s)) return { ok: true, value: false };
    return { ok: false, reason: `expected a boolean, got ${JSON.stringify(raw)}` };
  }
  if (type === "list" || type === "paths") {
    const parts = asArray(raw)
      .flatMap((v) => String(v).split(/[;\n]/))
      .map((s) => s.trim())
      .filter(Boolean);
    return { ok: true, value: parts };
  }
  return { ok: true, value: raw === undefined ? def.default : String(raw) };
}

/**
 * Param precedence: env var > patches.json override > module default.
 * Env wins so `PI_IMAGE_RESIZE_WIDTH=320 node mainrunner.js run` just works.
 */
export function resolveParams(entry, mod) {
  const params = {};
  const sources = {};
  const warnings = [];
  for (const def of asArray(mod.params)) {
    const key = def.key || def.name;
    if (!key) continue;
    let raw = def.default;
    let source = "default";
    if (entry.params && key in entry.params) {
      raw = entry.params[key];
      source = "patches.json";
    }
    if (def.env && process.env[def.env] !== undefined && String(process.env[def.env]).trim() !== "") {
      raw = process.env[def.env];
      source = `env ${def.env}`;
    }
    const res = coerceParam(def, raw);
    if (!res.ok) {
      warnings.push({ param: key, source, raw, reason: res.reason, used: def.default });
      params[key] = def.default;
      sources[key] = `default (invalid value from ${source}: ${res.reason})`;
      continue;
    }
    params[key] = res.value;
    sources[key] = source;
  }
  for (const [key, value] of Object.entries(entry.params || {})) {
    if (!(key in params)) {
      params[key] = value;
      sources[key] = "patches.json";
    }
  }
  return { params, sources, warnings };
}

function makeConflict({ patch, file, kind, severity = "error", message, error, hint, extra }) {
  const info = error ? errorInfo(error) : null;
  return {
    id: `cf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    ts: nowIso(),
    patchId: patch?.id ?? "unknown",
    patchName: patch ? patchLabel(patch) : "unknown",
    module: patch?.module ?? null,
    file: file ?? null,
    kind,
    severity,
    message: message || info?.message || "unknown conflict",
    stack: info?.stack || "",
    hint: hint || HINTS[kind] || "",
    extra: extra ?? null,
    resolved: false,
  };
}

function pruneBackups(dir, keep, logger) {
  if (!Number.isFinite(keep) || keep <= 0) return;
  let entries;
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".bak")).sort();
  } catch {
    return;
  }
  const extra = entries.slice(0, Math.max(0, entries.length - keep));
  for (const name of extra) {
    try {
      unlinkSync(join(dir, name));
    } catch (err) {
      logger?.debug(`could not prune backup ${name}: ${err.message}`);
    }
  }
}

function saveBackup(patchId, file, content, settings, logger) {
  const dir = join(ROOT, settings.backups?.dir || "backups", patchId);
  ensureDir(dir);
  const target = join(dir, `${fileStamp()}_${basename(file)}.bak`);
  writeAtomic(target, content);
  pruneBackups(dir, settings.backups?.keepPerPatch ?? 200, logger);
  return target;
}

function targetContent(target) {
  if (typeof target === "string") return { file: target, content: readText(target) };
  const file = target.file;
  const disk = readText(file);
  if (disk === undefined) return { file, content: undefined };
  if (typeof target.content === "string" && sha256(target.content) === sha256(disk)) {
    return { file, content: disk };
  }
  return { file, content: disk };
}

function buildContext({ entry, mod, registry, state, logger, params, sources, dryRun }) {
  return {
    patch: entry,
    mod,
    params,
    sources,
    state,
    registry,
    settings: registry.settings || {},
    agentDir: AGENT_DIR,
    patchesDir: ROOT,
    paths: PATHS,
    dryRun,
    logger,
  };
}

/**
 * Apply every enabled patch. Idempotent: a patch that is already applied reports "clean".
 * Never throws for a single patch failing — failures become conflicts.
 */
export async function runPatches({ registry, state, logger, opts = {} }) {
  const settings = registry.settings || {};
  const limits = { ...DEFAULT_LIMITS, ...(settings.history || {}) };
  const dryRun = Boolean(opts.dryRun);
  const force = Boolean(opts.force);
  const only = opts.only && opts.only.length ? new Set(opts.only) : null;
  const startedAt = nowIso();
  const t0 = Date.now();
  const conflicts = [];
  const results = [];

  const entries = [...registry.patches].sort(sortByPriority);
  for (const entry of entries) {
    if (only && !only.has(entry.id)) continue;
    const patchState = getPatchState(state, entry.id);
    patchState.counters.runs = (patchState.counters.runs || 0) + 1;
    const result = {
      id: entry.id,
      name: patchLabel(entry),
      module: resolvePatchModule(entry),
      status: "skipped",
      enabled: true,
      params: {},
      paramSources: {},
      warnings: [],
      files: [],
      message: "",
      changed: 0,
    };
    results.push(result);

    if (entry.enabled === false || patchState.enabled === false) {
      result.enabled = false;
      result.status = "disabled";
      patchState.status = "disabled";
      patchState.lastRunAt = nowIso();
      continue;
    }

    let mod;
    try {
      mod = await loadPatchModule(entry);
    } catch (err) {
      result.status = "failed";
      patchState.status = "failed";
      patchState.counters.failures = (patchState.counters.failures || 0) + 1;
      patchState.lastError = errorInfo(err).message;
      patchState.lastRunAt = nowIso();
      const conflict = makeConflict({ patch: entry, kind: "module-load", error: err });
      conflicts.push(conflict);
      pushHistory(state, entry.id, { action: "apply", status: "failed", message: conflict.message }, limits);
      continue;
    }

    const { params, sources, warnings } = resolveParams(entry, mod);
    result.params = params;
    result.paramSources = sources;
    result.warnings = warnings;
    result.version = mod.version || entry.version || null;
    patchState.params = params;
    patchState.paramSources = sources;
    patchState.version = result.version;

    const ctx = buildContext({ entry, mod, registry, state, logger, params, sources, dryRun });

    let targets;
    try {
      targets = await mod.targets(ctx);
    } catch (err) {
      result.status = "failed";
      patchState.status = "failed";
      patchState.counters.failures = (patchState.counters.failures || 0) + 1;
      patchState.lastError = errorInfo(err).message;
      patchState.lastRunAt = nowIso();
      const conflict = makeConflict({ patch: entry, kind: "discovery", error: err });
      conflicts.push(conflict);
      pushHistory(state, entry.id, { action: "apply", status: "failed", message: conflict.message }, limits);
      continue;
    }

    targets = asArray(targets).filter(Boolean);
    // A task-only patch (build step, generated artifact) legitimately has no file targets.
    if (!targets.length && typeof mod.task !== "function") {
      result.status = "no-targets";
      patchState.status = "no-targets";
      patchState.lastRunAt = nowIso();
      pushHistory(
        state,
        entry.id,
        { action: "apply", status: "no-targets", message: "patch found no target files to patch" },
        limits,
      );
      continue;
    }

    for (const target of targets) {
      const { file, content } = targetContent(target);
      const required = typeof target === "object" ? target.required !== false : true;
      const label = typeof target === "object" ? target.label || null : null;
      if (content === undefined) {
        result.files.push({ file, status: "missing", required, label, summary: "file not found" });
        if (required) {
          conflicts.push(
            makeConflict({
              patch: entry,
              file,
              kind: "discovery",
              severity: "warn",
              message: `target file is missing: ${file}`,
            }),
          );
        }
        continue;
      }

      let res;
      try {
        res = await mod.transform(ctx, file, content);
      } catch (err) {
        result.files.push({ file, status: "failed", required, label, summary: errorInfo(err).message });
        patchState.counters.failures = (patchState.counters.failures || 0) + 1;
        conflicts.push(makeConflict({ patch: entry, file, kind: "transform", error: err }));
        continue;
      }

      if (res && res.missingAnchor && required) {
        conflicts.push(
          makeConflict({
            patch: entry,
            file,
            kind: "anchor-missing",
            severity: "warn",
            message: res.summary || `patch anchor not found in ${basename(file)}`,
          }),
        );
      }

      if (!res || res.unchanged || res.content === content) {
        result.files.push({ file, status: "clean", required, label, summary: res?.summary || "already patched" });
        continue;
      }

      const beforeHash = sha256(content);
      const afterHash = sha256(res.content);
      const diff = previewDiff(content, res.content);
      if (dryRun) {
        result.files.push({
          file,
          status: "would-apply",
          required,
          label,
          summary: res.summary || "would patch",
          hashBefore: beforeHash,
          hashAfter: afterHash,
          diffStat: { added: diff.added, removed: diff.removed },
        });
        result.changed++;
        continue;
      }

      let backupPath = null;
      try {
        backupPath = saveBackup(entry.id, file, content, settings, logger);
      } catch (err) {
        conflicts.push(
          makeConflict({
            patch: entry,
            file,
            kind: "write",
            message: `could not write backup before patching: ${errorInfo(err).message}`,
            error: err,
          }),
        );
        result.files.push({ file, status: "failed", required, label, summary: "backup failed" });
        continue;
      }

      try {
        writeAtomic(file, res.content);
      } catch (err) {
        result.files.push({ file, status: "failed", required, label, summary: `write failed: ${errorInfo(err).message}` });
        patchState.counters.failures = (patchState.counters.failures || 0) + 1;
        conflicts.push(makeConflict({ patch: entry, file, kind: "write", error: err }));
        continue;
      }

      let verified = true;
      let verifyMessage = "";
      const written = readText(file);
      if (written === undefined || sha256(written) !== afterHash) {
        verified = false;
        verifyMessage = "file content after write does not match what the patch produced";
      } else if (typeof mod.verify === "function") {
        try {
          const v = await mod.verify(ctx, file, written);
          if (v && v.ok === false) {
            verified = false;
            verifyMessage = v.message || "module verification failed";
          }
        } catch (err) {
          verified = false;
          verifyMessage = errorInfo(err).message;
          conflicts.push(makeConflict({ patch: entry, file, kind: "verify", error: err }));
        }
      }
      if (!verified && !conflicts.some((x) => x.file === file && x.kind === "verify")) {
        conflicts.push(
          makeConflict({ patch: entry, file, kind: "verify", message: verifyMessage || "verification failed" }),
        );
      }

      const fileRecord = {
        file,
        status: verified ? "applied" : "applied-unverified",
        required,
        label,
        summary: res.summary || "",
        hashBefore: beforeHash,
        hashAfter: afterHash,
        backup: backupPath ? relToRoot(backupPath) : null,
        bytesBefore: Buffer.byteLength(content),
        bytesAfter: Buffer.byteLength(res.content),
        linesBefore: countLines(content),
        linesAfter: countLines(res.content),
        diffStat: { added: diff.added, removed: diff.removed },
        diffPreview: diff.preview,
        appliedAt: nowIso(),
        params: { ...params },
        patchVersion: result.version,
      };
      upsertFileRecord(patchState, fileRecord);
      result.files.push({ ...fileRecord, verified });
      result.changed++;
      state.stats.filesChanged = (state.stats.filesChanged || 0) + 1;
    }

    if (!dryRun) {
      // Records for files that no longer exist (pi uninstalled, release pruned) must stop
      // claiming to be applied, otherwise `status` and `revert` lie about the install.
      for (const record of patchState.files) {
        if (record.status !== "applied" && record.status !== "applied-unverified") continue;
        if (existsSync(record.file)) continue;
        record.status = "missing";
        record.missingAt = nowIso();
        result.files.push({ file: record.file, status: "missing", required: false, summary: "file no longer exists" });
      }
    }

    // Optional module task: a build / generated-artifact / sync step that has no file of its
    // own to transform. It runs in the same pass, state and history as the file targets.
    if (typeof mod.task === "function") {
      const taskFile = `task:${entry.id}`;
      const taskLabelText = mod.taskLabel || "task";
      try {
        const taskRes = (await mod.task({ ...ctx, mode: dryRun ? "verify" : "apply" })) || {};
        const summary = taskRes.summary || "";
        if (taskRes.changed && dryRun) {
          result.files.push({ file: taskFile, status: "would-apply", required: false, label: taskLabelText, summary: summary || "would run" });
        } else if (taskRes.changed) {
          result.files.push({ file: taskFile, status: "applied", required: false, label: taskLabelText, summary: summary || "ran" });
          result.changed++;
        } else {
          result.files.push({ file: taskFile, status: "clean", required: false, label: taskLabelText, summary: summary || "up to date" });
        }
        patchState.task = { lastRunAt: nowIso(), summary, changed: Boolean(taskRes.changed) };
        if (taskRes.ok === false) {
          conflicts.push(
            makeConflict({ patch: entry, kind: "task", severity: "warn", message: taskRes.message || summary || "task reported a problem" }),
          );
        }
      } catch (err) {
        result.files.push({ file: taskFile, status: "failed", required: false, label: taskLabelText, summary: errorInfo(err).message });
        patchState.counters.failures = (patchState.counters.failures || 0) + 1;
        conflicts.push(makeConflict({ patch: entry, kind: "task", error: err }));
      }
    }

    const failedFiles = result.files.filter((f) => f.status === "failed").length;
    const appliedFiles = result.files.filter((f) => f.status === "applied" || f.status === "applied-unverified").length;
    const wouldApply = result.files.filter((f) => f.status === "would-apply").length;
    const cleanFiles = result.files.filter((f) => f.status === "clean").length;

    if (failedFiles > 0) result.status = "failed";
    else if (dryRun && wouldApply > 0) result.status = "would-apply";
    else if (appliedFiles > 0) result.status = "applied";
    else if (cleanFiles > 0) result.status = "clean";
    else result.status = "no-targets";

    result.message =
      result.status === "applied"
        ? `${appliedFiles} file(s) patched${cleanFiles ? `, ${cleanFiles} already up to date` : ""}`
        : result.status === "clean"
          ? "already up to date"
          : result.status === "would-apply"
            ? `${wouldApply} file(s) would be patched`
            : result.status === "failed"
              ? `${failedFiles} file(s) failed`
              : "nothing to do";

    patchState.status = result.status === "would-apply" ? patchState.status || "pending" : result.status;
    patchState.lastRunAt = nowIso();
    patchState.lastSummary = result.message;
    if (result.status === "applied") {
      patchState.appliedAt = nowIso();
      patchState.counters.applied = (patchState.counters.applied || 0) + 1;
      state.stats.applied = (state.stats.applied || 0) + 1;
    }
    if (result.status === "failed") {
      patchState.counters.failures = (patchState.counters.failures || 0) + 1;
      state.stats.failed = (state.stats.failed || 0) + 1;
    }
    pushHistory(
      state,
      entry.id,
      {
        action: dryRun ? "dry-run" : "apply",
        status: result.status,
        message: result.message,
        params: { ...params },
        files: result.files.filter((f) => f.status !== "clean").map((f) => ({ file: f.file, status: f.status })),
      },
      limits,
    );
  }

  const durationMs = Date.now() - t0;
  const run = {
    id: `run_${Date.now().toString(36)}`,
    startedAt,
    finishedAt: nowIso(),
    durationMs,
    trigger: opts.trigger || "cli",
    dryRun,
    ok: conflicts.filter((x) => x.severity !== "warn").length === 0,
    patches: results.map((r) => ({ id: r.id, status: r.status, changed: r.changed })),
    changed: results.reduce((sum, r) => sum + r.changed, 0),
    conflicts: conflicts.length,
  };

  if (!dryRun) {
    recordRun(state, run, limits);
    recordConflicts(state, conflicts, limits);

  // A patch that runs clean again has fixed itself: close its open conflicts automatically so
  // the report and `conflicts` stop nagging about errors that are already gone.
  if (!dryRun && !opts.noAutoResolve) {
    const healed = new Set(
      results
        .filter((r) => (r.status === "applied" || r.status === "clean") && !conflicts.some((x) => x.patchId === r.id))
        .map((r) => r.id),
    );
    let autoResolved = 0;
    for (const conflict of state.conflicts || []) {
      if (conflict.resolved || !healed.has(conflict.patchId)) continue;
      conflict.resolved = true;
      conflict.resolvedAt = nowIso();
      conflict.resolvedBy = "auto";
      autoResolved += 1;
    }
    if (autoResolved) run.autoResolved = autoResolved;
  }
    for (const conflict of conflicts) {
      const patchState = state.patches[conflict.patchId];
      if (patchState) patchState.counters.conflicts = (patchState.counters.conflicts || 0) + 1;
    }
  }

  let report = null;
  if (conflicts.length && !opts.noReport && !dryRun) {
    report = handleConflicts({ registry, state, conflicts, logger, opts });
  } else if (!opts.noReport && !dryRun && settings?.report?.alwaysWrite !== false) {
    // Keep conflicts.html + conflicts.data.js current even on a clean run, so an open page
    // can simply refresh instead of showing yesterday's conflicts.
    try {
      const file = writeConflictReport({ registry, state, conflicts: [], settings: settings.report });
      report = { file, opened: false };
    } catch (err) {
      logger?.warn(`could not refresh the report: ${errorInfo(err).message}`);
    }
  }

  return { ...run, results, conflictList: conflicts, report };
}

/** Write conflicts.html and (rate-limited) open it for the user. */
export function handleConflicts({ registry, state, conflicts, logger, opts = {} }) {
  const settings = registry.settings?.report || {};
  let file = null;
  try {
    file = writeConflictReport({ registry, state, conflicts, settings });
  } catch (err) {
    logger?.error(`could not write conflict report: ${errorInfo(err).message}`);
    return null;
  }
  let opened = false;
  if (settings.openOnConflict !== false && opts.open !== false) {
    const last = state.runner?.lastReportOpenedAt ? Date.parse(state.runner.lastReportOpenedAt) : 0;
    const min = Number(settings.minOpenIntervalMs ?? 60_000);
    if (!last || Date.now() - last > min) {
      opened = openReport(file, logger);
      if (opened) {
        state.runner.lastReportOpenedAt = nowIso();
      }
    } else {
      logger?.info(`conflict report not re-opened (opened ${Math.round((Date.now() - last) / 1000)}s ago)`);
    }
  }
  return { file, opened };
}

/**
 * Revert a patch: module.revert() first (content-aware), otherwise the pre-patch backup.
 * A backup is only restored when the file still matches what the patch produced.
 */
export async function revertPatches({ registry, state, logger, opts = {} }) {
  const settings = registry.settings || {};
  const limits = { ...DEFAULT_LIMITS, ...(settings.history || {}) };
  const only = opts.only && opts.only.length ? new Set(opts.only) : null;
  const dryRun = Boolean(opts.dryRun);
  const conflicts = [];
  const results = [];
  const startedAt = nowIso();
  const t0 = Date.now();

  for (const entry of [...registry.patches].sort(sortByPriority)) {
    if (only && !only.has(entry.id)) continue;
    const patchState = getPatchState(state, entry.id);
    const result = { id: entry.id, name: patchLabel(entry), status: "skipped", files: [], message: "" };
    results.push(result);
    let records = patchState.files.filter(
      (f) => f.status === "applied" || f.status === "applied-unverified" || f.status === "reverted",
    );
    // Files already known gone (uninstalled pi, pruned release) are not worth reporting again.
    const knownMissing = new Set(patchState.files.filter((f) => f.status === "missing").map((f) => f.file));
    records = records.filter((f) => !knownMissing.has(f.file));

    let mod = null;
    try {
      mod = await loadPatchModule(entry);
    } catch {
      /* module may be gone; backups still work */
    }

    // --targets: revert everything the patch module can find, even files we never recorded
    // (state loss, or a file patched by an older version of this runner).
    if (opts.allTargets && mod && typeof mod.targets === "function") {
      try {
        const probeParams = resolveParams(entry, mod);
        const probe = buildContext({ entry, mod, registry, state, logger, params: probeParams.params, sources: probeParams.sources, dryRun: true });
        const found = asArray(await mod.targets(probe)).filter(Boolean).map((t) => (typeof t === "string" ? t : t.file));
        const known = new Set(records.map((r) => r.file));
        for (const file of found) {
          if (file && !known.has(file)) records.push({ file, status: "applied", untracked: true });
        }
      } catch (err) {
        logger?.warn(`--targets discovery failed for ${entry.id}: ${errorInfo(err).message}`);
      }
    }

    const hasTask = Boolean(mod && typeof mod.task === "function");
    if (!records.length && !hasTask) {
      result.status = "skipped";
      result.message = "no applied files recorded";
      continue;
    }

    const { params, sources } = mod ? resolveParams(entry, mod) : { params: patchState.params || {}, sources: {} };
    const ctx = buildContext({ entry, mod, registry, state, logger, params, sources, dryRun, mode: "revert" });

    let reverted = 0;
    for (const record of records) {
      const current = readText(record.file);
      if (current === undefined) {
        result.files.push({ file: record.file, status: "missing", summary: "file not found" });
        continue;
      }
      let restored;
      let how = null;
      if (mod && typeof mod.revert === "function") {
        try {
          const res = await mod.revert(ctx, record.file, current);
          if (res && typeof res.content === "string" && res.content !== current) {
            restored = res.content;
            how = "module revert";
          } else if (res && res.unchanged) {
            result.files.push({ file: record.file, status: "clean", summary: "already unpatched" });
            if (!dryRun) {
              record.status = "reverted";
              record.revertedAt = nowIso();
            }
            continue;
          }
        } catch (err) {
          conflicts.push(makeConflict({ patch: entry, file: record.file, kind: "revert", error: err }));
        }
      }
      if (restored === undefined && record.backup) {
        const backupAbs = join(ROOT, record.backup);
        const backupText = existsSync(backupAbs) ? readText(backupAbs) : undefined;
        if (backupText === undefined) {
          conflicts.push(
            makeConflict({
              patch: entry,
              file: record.file,
              kind: "revert",
              message: `backup is missing: ${record.backup}`,
            }),
          );
        } else if (record.hashAfter && sha256(current) !== record.hashAfter) {
          conflicts.push(
            makeConflict({
              patch: entry,
              file: record.file,
              kind: "revert",
              message: "file changed after the patch was applied (pi update?) — restore skipped on purpose",
            }),
          );
        } else {
          restored = backupText;
          how = `backup ${record.backup}`;
        }
      }
      if (restored === undefined && mod && typeof mod.transform === "function") {
        // Last resort before calling this a failure: ask the patch whether the file is even
        // patched. A patch that never wrote anything (the config was already tuned, the file
        // was patched by an older runner, the record is stale) has nothing to undo — saying so
        // is more useful than a conflict for a file that is already in its original state.
        try {
          const probe = await mod.transform(ctx, record.file, current);
          if (!probe || probe.unchanged || probe.content === current || probe.content === undefined) {
            result.files.push({ file: record.file, status: "clean", summary: "nothing to revert (patch is not applied)" });
            if (!dryRun) {
              record.status = "reverted";
              record.revertedAt = nowIso();
              record.revertedVia = "no-op (never applied)";
            }
            continue;
          }
        } catch {
          /* fall through to the failure below */
        }
      }
      if (restored === undefined) {
        if (!conflicts.some((x) => x.file === record.file)) {
          conflicts.push(
            makeConflict({
              patch: entry,
              file: record.file,
              kind: "revert",
              message: "no module revert hook and no usable backup for this file",
            }),
          );
        }
        result.files.push({ file: record.file, status: "failed", summary: "cannot revert" });
        continue;
      }
      if (dryRun) {
        result.files.push({ file: record.file, status: "would-apply", summary: `would revert via ${how}` });
        reverted++;
        continue;
      }
      try {
        writeAtomic(record.file, restored);
        record.status = "reverted";
        record.revertedAt = nowIso();
        record.revertedVia = how;
        reverted++;
        result.files.push({ file: record.file, status: "reverted", summary: how });
      } catch (err) {
        conflicts.push(makeConflict({ patch: entry, file: record.file, kind: "write", error: err }));
        result.files.push({ file: record.file, status: "failed", summary: "write failed" });
      }
    }

    if (hasTask) {
      const taskFile = `task:${entry.id}`;
      const taskLabelText = mod.taskLabel || "task";
      try {
        const taskRes = (await mod.task({ ...ctx, mode: "revert" })) || {};
        if (dryRun) {
          result.files.push({ file: taskFile, status: taskRes.changed ? "would-apply" : "clean", required: false, label: taskLabelText, summary: taskRes.summary || "would revert" });
          if (taskRes.changed) reverted++;
        } else if (taskRes.changed) {
          result.files.push({ file: taskFile, status: "reverted", required: false, label: taskLabelText, summary: taskRes.summary || "reverted" });
          reverted++;
          if (patchState.task) patchState.task.revertedAt = nowIso();
        } else {
          result.files.push({ file: taskFile, status: "clean", required: false, label: taskLabelText, summary: taskRes.summary || "nothing to revert" });
        }
      } catch (err) {
        conflicts.push(makeConflict({ patch: entry, kind: "task", error: err }));
        result.files.push({ file: taskFile, status: "failed", required: false, label: taskLabelText, summary: errorInfo(err).message });
      }
    }

    result.status = reverted > 0 ? "reverted" : result.files.some((f) => f.status === "failed") ? "failed" : "clean";
    result.message = `${reverted} file(s) reverted`;
    patchState.status = result.status;
    patchState.lastRunAt = nowIso();
    if (reverted > 0) {
      patchState.revertedAt = nowIso();
      patchState.counters.reverted = (patchState.counters.reverted || 0) + 1;
      state.stats.reverted = (state.stats.reverted || 0) + 1;
    }
    pushHistory(
      state,
      entry.id,
      {
        action: "revert",
        status: result.status,
        message: result.message,
        files: result.files.map((f) => ({ file: f.file, status: f.status })),
      },
      limits,
    );
  }

  const durationMs = Date.now() - t0;
  const run = {
    id: `rev_${Date.now().toString(36)}`,
    startedAt,
    finishedAt: nowIso(),
    durationMs,
    trigger: opts.trigger || "cli",
    dryRun,
    action: "revert",
    ok: conflicts.length === 0,
    patches: results.map((r) => ({ id: r.id, status: r.status })),
    changed: results.reduce((s, r) => s + r.files.filter((f) => f.status === "reverted").length, 0),
    conflicts: conflicts.length,
  };
  if (!dryRun) {
    recordRun(state, run, limits);
    recordConflicts(state, conflicts, limits);
  }
  let report = null;
  if (conflicts.length && !opts.noReport && !dryRun) {
    report = handleConflicts({ registry, state, conflicts, logger, opts });
  }
  return { ...run, results, conflictList: conflicts, report };
}

/** Is the patch still applied? transform() saying "unchanged" means yes. */
export async function verifyPatches({ registry, state, logger, opts = {} }) {
  const only = opts.only && opts.only.length ? new Set(opts.only) : null;
  const rows = [];
  for (const entry of [...registry.patches].sort(sortByPriority)) {
    if (only && !only.has(entry.id)) continue;
    const patchState = getPatchState(state, entry.id);
    const row = { id: entry.id, name: patchLabel(entry), status: "unknown", files: [], message: "" };
    rows.push(row);
    if (entry.enabled === false || patchState.enabled === false) {
      row.status = "disabled";
      row.message = "patch is disabled";
      continue;
    }
    let mod;
    try {
      mod = await loadPatchModule(entry);
    } catch (err) {
      row.status = "failed";
      row.message = errorInfo(err).message;
      continue;
    }
    const { params, sources } = resolveParams(entry, mod);
    const ctx = buildContext({ entry, mod, registry, state, logger, params, sources, dryRun: true });
    let targets;
    try {
      targets = asArray(await mod.targets(ctx)).filter(Boolean);
    } catch (err) {
      row.status = "failed";
      row.message = errorInfo(err).message;
      continue;
    }
    let applied = 0;
    let drift = 0;
    let missing = 0;
    for (const target of targets) {
      const { file, content } = targetContent(target);
      const required = typeof target === "object" ? target.required !== false : true;
      if (content === undefined) {
        missing++;
        row.files.push({ file, status: "missing", required });
        continue;
      }
      try {
        const res = await mod.transform(ctx, file, content);
        if (!res || res.unchanged || res.content === content) {
          applied++;
          row.files.push({ file, status: "applied", required });
        } else {
          drift++;
          row.files.push({ file, status: "drift", required, summary: res.summary || "patch not applied" });
        }
      } catch (err) {
        row.files.push({ file, status: "failed", required, summary: errorInfo(err).message });
        drift++;
      }
    }
    if (typeof mod.task === "function") {
      const taskFile = `task:${entry.id}`;
      try {
        const taskRes = (await mod.task({ ...ctx, mode: "verify" })) || {};
        if (taskRes.changed) {
          drift++;
          row.files.push({ file: taskFile, status: "drift", required: false, summary: taskRes.summary || "task is out of date" });
        } else {
          applied++;
          row.files.push({ file: taskFile, status: "applied", required: false, summary: taskRes.summary || "task up to date" });
        }
      } catch (err) {
        drift++;
        row.files.push({ file: taskFile, status: "failed", required: false, summary: errorInfo(err).message });
      }
    }

    row.counts = { applied, drift, missing };
    if (drift > 0) {
      row.status = "drift";
      row.message = `${drift} file(s) need patching`;
    } else if (applied > 0) {
      row.status = "applied";
      row.message = `${applied} file(s) patched and verified`;
    } else if (missing > 0) {
      row.status = "missing";
      row.message = "targets missing";
    } else {
      row.status = "no-targets";
      row.message = "no targets";
    }
  }
  return { rows, ok: rows.every((r) => r.status === "applied" || r.status === "disabled") };
}

/** Every directory a patch module wants watched (optional module hook). */
export async function collectModuleWatchPaths({ registry, state, logger }) {
  const paths = [];
  for (const entry of registry.patches) {
    const patchState = state.patches[entry.id];
    if (entry.enabled === false || patchState?.enabled === false) continue;
    try {
      const mod = await loadPatchModule(entry);
      if (typeof mod.watch !== "function") continue;
      const { params, sources } = resolveParams(entry, mod);
      const ctx = buildContext({ entry, mod, registry, state, logger, params, sources, dryRun: true });
      for (const p of asArray(await mod.watch(ctx))) {
        if (p && existsSync(p)) paths.push(p);
      }
    } catch (err) {
      logger?.debug(`watch hook failed for ${entry.id}: ${errorInfo(err).message}`);
    }
  }
  return paths;
}

export function fileSignature(file) {
  try {
    const st = statSync(file);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

export { HINTS, saveBackup, pruneBackups };
