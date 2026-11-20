// state.json: the durable record of every patch, its files, its history and its conflicts.
import { PATHS, SCHEMA_VERSION, nowIso, readJson, writeJson, ensureDir, asArray } from "./util.js";

export const DEFAULT_LIMITS = {
  keepHistoryPerPatch: 200,
  keepRuns: 100,
  keepConflicts: 50,
  keepBackupsPerPatch: 200,
};

export function emptyState() {
  const ts = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: ts,
    updatedAt: ts,
    runner: {
      pid: null,
      startedAt: null,
      lastRunAt: null,
      lastTrigger: null,
      lastDurationMs: null,
      runs: 0,
      version: null,
    },
    stats: { runs: 0, applied: 0, reverted: 0, failed: 0, conflicts: 0, filesChanged: 0 },
    patches: {},
    runs: [],
    history: [],
    conflicts: [],
  };
}

export function emptyPatchState(id, seed = {}) {
  const ts = nowIso();
  return {
    id,
    enabled: true,
    status: "unknown",
    params: {},
    paramSources: {},
    files: [],
    counters: { applied: 0, reverted: 0, failures: 0, runs: 0, conflicts: 0 },
    history: [],
    createdAt: ts,
    updatedAt: ts,
    lastRunAt: null,
    lastError: null,
    ...seed,
  };
}

function normalize(state) {
  const base = emptyState();
  const out = { ...base, ...state };
  out.runner = { ...base.runner, ...(state.runner || {}) };
  out.stats = { ...base.stats, ...(state.stats || {}) };
  out.patches = state.patches && typeof state.patches === "object" ? state.patches : {};
  for (const [id, rec] of Object.entries(out.patches)) {
    out.patches[id] = { ...emptyPatchState(id), ...rec };
    out.patches[id].counters = { ...emptyPatchState(id).counters, ...(rec.counters || {}) };
    out.patches[id].files = asArray(rec.files);
    out.patches[id].history = asArray(rec.history);
  }
  out.runs = asArray(state.runs);
  out.history = asArray(state.history);
  out.conflicts = asArray(state.conflicts);
  return out;
}

export function loadState() {
  const raw = readJson(PATHS.state, null);
  if (!raw || typeof raw !== "object") return emptyState();
  return normalize(raw);
}

export function saveState(state) {
  ensureDir(PATHS.root);
  state.updatedAt = nowIso();
  writeJson(PATHS.state, state);
  return state;
}

export function getPatchState(state, id, seed = {}) {
  if (!state.patches[id]) state.patches[id] = emptyPatchState(id, seed);
  return state.patches[id];
}

export function setPatchEnabled(state, id, enabled) {
  const rec = getPatchState(state, id);
  rec.enabled = Boolean(enabled);
  rec.updatedAt = nowIso();
  return rec;
}

/** One history entry, mirrored into the patch record and the global timeline. */
export function pushHistory(state, patchId, entry, limits = DEFAULT_LIMITS) {
  const ts = entry.ts || nowIso();
  const record = { ts, patchId: patchId || null, ...entry };
  state.history.unshift(record);
  if (state.history.length > limits.keepHistoryPerPatch * 2) {
    state.history.length = limits.keepHistoryPerPatch * 2;
  }
  if (patchId) {
    const rec = getPatchState(state, patchId);
    rec.history.unshift(record);
    if (rec.history.length > limits.keepHistoryPerPatch) rec.history.length = limits.keepHistoryPerPatch;
    rec.updatedAt = ts;
  }
  return record;
}

export function recordRun(state, run, limits = DEFAULT_LIMITS) {
  state.runs.unshift(run);
  if (state.runs.length > limits.keepRuns) state.runs.length = limits.keepRuns;
  state.runner.runs = (state.runner.runs || 0) + 1;
  state.runner.lastRunAt = run.startedAt;
  state.runner.lastTrigger = run.trigger || null;
  state.runner.lastDurationMs = run.durationMs ?? null;
  state.stats.runs = (state.stats.runs || 0) + 1;
  return run;
}

export function recordConflicts(state, conflicts, limits = DEFAULT_LIMITS) {
  if (!conflicts.length) return;
  state.conflicts = [...conflicts, ...state.conflicts];
  if (state.conflicts.length > limits.keepConflicts * 20) state.conflicts.length = limits.keepConflicts * 20;
  state.stats.conflicts = (state.stats.conflicts || 0) + conflicts.length;
}

/**
 * Close (or re-open) recorded conflicts. Selector: { ids } | { patchId } | { all }.
 * Resolution is bookkeeping only — the patch itself is fixed by fixing its module.
 */
export function resolveConflicts(state, { ids, patchId, all = false, reopen = false, by = "cli" } = {}) {
  const wanted = new Set(asArray(ids).filter(Boolean).map(String));
  const matches = (conflict) => {
    if (all) return true;
    if (patchId) return conflict.patchId === patchId;
    return wanted.has(conflict.id) || wanted.has(conflict.patchId);
  };
  const at = nowIso();
  let changed = 0;
  for (const conflict of state.conflicts || []) {
    if (Boolean(conflict.resolved) === !reopen) continue;
    if (!matches(conflict)) continue;
    changed += 1;
    if (reopen) {
      conflict.resolved = false;
      delete conflict.resolvedAt;
      delete conflict.resolvedBy;
    } else {
      conflict.resolved = true;
      conflict.resolvedAt = at;
      conflict.resolvedBy = by;
    }
  }
  return { changed, at };
}

export function upsertFileRecord(patchState, rec) {
  const files = patchState.files;
  const idx = files.findIndex((f) => f.file === rec.file);
  if (idx === -1) {
    files.push(rec);
    return rec;
  }
  const previous = files[idx];
  const backups = [...asArray(previous.backups)];
  if (previous.backup && previous.backup !== rec.backup) backups.unshift(previous.backup);
  files[idx] = { ...previous, ...rec, backups: backups.slice(0, 10) };
  return files[idx];
}

export function markFilesReverted(patchState, fileList) {
  for (const file of asArray(fileList)) {
    const rec = patchState.files.find((f) => f.file === file);
    if (rec) {
      rec.status = "reverted";
      rec.revertedAt = nowIso();
    }
  }
}

export function stateSummary(state) {
  const patches = Object.values(state.patches);
  const count = (status) => patches.filter((p) => p.status === status).length;
  return {
    patches: patches.length,
    // "clean" means "targets patched, nothing to change this run" — same end state.
    applied: count("applied") + count("clean"),
    clean: count("clean"),
    failed: count("failed"),
    disabled: patches.filter((p) => p.enabled === false).length,
    reverted: count("reverted"),
    openConflicts: state.conflicts.filter((x) => !x.resolved).length,
    runs: state.stats.runs || 0,
    filesChanged: state.stats.filesChanged || 0,
    lastRunAt: state.runner.lastRunAt,
  };
}
