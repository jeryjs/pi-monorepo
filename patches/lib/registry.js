// patches.json: the registry. Where each patch lives, how it is configured, when it runs.
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AGENT_DIR, PATHS, ROOT, expandPath, readJson, writeJson, ensureDir, asArray } from "./util.js";

export function defaultRegistry() {
  return {
    $comment: "Registry of local patches applied to pi (and anything else). See README.md.",
    schemaVersion: 1,
    settings: {
      autoRun: true,
      watch: {
        enabled: true,
        intervalMs: 300_000,
        debounceMs: 1500,
        paths: [],
        watchPatchSources: true,
      },
      report: {
        path: "conflicts.html",
        openOnConflict: true,
        minOpenIntervalMs: 60_000,
      },
      backups: { dir: "backups", keepPerPatch: 200 },
      history: { keepPerPatch: 200, keepRuns: 100, keepConflicts: 50 },
      logging: { level: "info", file: "runner.log", maxBytes: 1_048_576 },
      daemon: { autostart: false },
    },
    patches: [],
  };
}

export function loadRegistry() {
  const raw = readJson(PATHS.registry, null);
  const base = defaultRegistry();
  if (!raw || typeof raw !== "object") return base;
  const out = {
    ...base,
    ...raw,
    settings: {
      ...base.settings,
      ...(raw.settings || {}),
      watch: { ...base.settings.watch, ...(raw.settings?.watch || {}) },
      report: { ...base.settings.report, ...(raw.settings?.report || {}) },
      backups: { ...base.settings.backups, ...(raw.settings?.backups || {}) },
      history: { ...base.settings.history, ...(raw.settings?.history || {}) },
      logging: { ...base.settings.logging, ...(raw.settings?.logging || {}) },
      daemon: { ...base.settings.daemon, ...(raw.settings?.daemon || {}) },
    },
    patches: asArray(raw.patches).filter((p) => p && p.id),
  };
  return out;
}

export function saveRegistry(registry) {
  ensureDir(PATHS.root);
  writeJson(PATHS.registry, registry);
  return registry;
}

export function findPatchEntry(registry, id) {
  return registry.patches.find((p) => p.id === id) || null;
}

/** Module path may be absolute, ~-prefixed, or relative to the patches folder. A folder is fine too. */
export function resolvePatchModule(entry) {
  const candidate = entry.module || entry.dir || join(entry.id, "index.js");
  const base = expandPath(candidate);
  const tries = isDirectory(base)
    ? [join(base, "index.js"), join(base, "patch.js"), join(base, "main.js"), join(base, "index.mjs")]
    : [base];
  for (const file of tries) {
    if (existsSync(file) && statSync(file).isFile()) return resolve(file);
  }
  return null;
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const moduleCache = new Map();

/**
 * Import a patch module, re-importing only when the file changed on disk, so the
 * daemon picks up edits without leaking one module instance per poll.
 */
export async function loadPatchModule(entry) {
  const file = resolvePatchModule(entry);
  if (!file) {
    throw new Error(
      `patch module not found for "${entry.id}" — looked for "${entry.module || join(entry.id, "index.js")}" (relative to ${ROOT})`,
    );
  }
  const mtimeMs = statSync(file).mtimeMs;
  const cached = moduleCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return { ...cached.mod, __file: file };
  const imported = await import(`${pathToFileURL(file).href}?v=${Math.round(mtimeMs)}`);
  const def = imported.default ?? imported.patch ?? imported;
  // A patch either transforms files (targets + transform) or performs a build step (task).
  // Task-only modules may legitimately report no file targets.
  const hasTransform = def && typeof def.targets === "function" && typeof def.transform === "function";
  const hasTask = def && typeof def.task === "function";
  if (!hasTransform && !hasTask) {
    throw new Error(
      `patch module "${file}" must export default { id, name, targets() and transform(), or task() } (see README.md)`,
    );
  }
  if (def.task && typeof def.targets !== "function" && typeof def.transform === "function") {
    throw new Error(`patch module "${file}" declares transform() but no targets()`);
  }
  const mod = { ...def, id: def.id || entry.id, __file: file };
  moduleCache.set(file, { mtimeMs, mod });
  return mod;
}

export function patchLabel(entry) {
  return entry.name || entry.id;
}

/** Directories the daemon watches: patch sources plus whatever the registry/patch modules point at. */
export function registryWatchRoots(registry) {
  const roots = new Set();
  for (const p of asArray(registry.settings?.watch?.paths)) {
    const abs = expandPath(p);
    if (abs && existsSync(abs)) roots.add(abs);
  }
  if (registry.settings?.watch?.watchPatchSources !== false) {
    roots.add(ROOT);
    for (const entry of registry.patches) {
      const file = resolvePatchModule(entry);
      if (file) roots.add(dirname(file));
    }
  }
  return [...roots];
}

/** Roots that a pi upgrade would rewrite; used for the default watch list. */
export function defaultPiRoots() {
  const roots = [];
  const push = (p) => {
    if (p && existsSync(p)) roots.push(p);
  };
  push(join(AGENT_DIR, "install", "releases"));
  push(join(AGENT_DIR, "npm", "node_modules"));
  push(join(AGENT_DIR, "extensions"));
  if (process.execPath) {
    const prefix = dirname(process.execPath);
    push(join(prefix, "node_modules", "@earendil-works"));
  }
  if (process.env.PI_PACKAGE_DIR) push(process.env.PI_PACKAGE_DIR);
  return roots;
}
