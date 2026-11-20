// Shared helpers for patch modules that edit pi's own dist files.
//
// Discovery must stay dynamic: pi lives in managed release folders, npm prefixes, bundled
// extensions and (on this machine) a global npm install, and every one of those paths changes on
// upgrade. Nothing here is allowed to hardcode a version, a hash-named chunk or an install root.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const PI_PKG = "@earendil-works/pi-coding-agent";
export const CHUNKS_REL = ["dist", "bundle", "chunks"];

export function agentDirOf(ctx) {
  return ctx?.agentDir || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** node_modules-relative path of the pi package itself. */
const PI_PKG_DIR = join("@earendil-works", "pi-coding-agent");

/**
 * A "root" is any directory whose node_modules could contain a pi-coding-agent copy. Node's own
 * resolution walks `<root>/node_modules` and then every package's nested `<pkg>/node_modules`, so
 * the roots are what matter — package layout is not.
 */
export function piInstallRoots(ctx) {
  const agentDir = agentDirOf(ctx);
  const roots = [];
  const add = (dir) => {
    if (dir) roots.push(dir);
  };

  // pi's own extension/package directories and managed releases.
  add(join(agentDir, "npm"));
  add(process.env.PI_MANAGED_INSTALL_ROOT);
  for (const root of [process.env.PI_MANAGED_INSTALL_ROOT, join(agentDir, "install")]) {
    if (!root) continue;
    const releases = join(root, "releases");
    if (!existsSync(releases)) continue;
    try {
      for (const entry of readdirSync(releases, { withFileTypes: true })) {
        if (entry.isDirectory()) add(join(releases, entry.name));
      }
    } catch {
      /* ignore */
    }
  }

  // Extensions extracted per source by pi (npm:<pkg>, git:<url>, ...).
  const tmpExt = join(agentDir, "tmp", "extensions");
  if (existsSync(tmpExt)) {
    try {
      for (const source of readdirSync(tmpExt, { withFileTypes: true })) {
        if (!source.isDirectory()) continue;
        const perSource = join(tmpExt, source.name);
        try {
          for (const pkg of readdirSync(perSource, { withFileTypes: true })) {
            if (pkg.isDirectory()) add(join(perSource, pkg.name));
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // The node installation prefix (npm -g puts pi and its web UI here).
  if (process.execPath) {
    const prefix = dirname(process.execPath);
    add(prefix);
    add(join(prefix, "lib"));
  }

  // npm's global prefix is not always node's prefix (`/usr/bin/node` + `~/.npm-global` here), so the
  // node dir alone misses globally installed packages — pi-web-ui ships its own nested
  // pi-coding-agent copy under `<npm prefix>/lib/node_modules`. PATH tells us where npm put its
  // shims, which is one hop from its node_modules; the scan itself is what finds the copy.
  for (const dir of String(process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const nm of [join(dir, "node_modules"), join(dir, "..", "lib", "node_modules")]) {
      if (existsSync(nm)) add(dirname(nm));
    }
  }

  for (const extra of ctx?.params?.packages || []) add(extra);
  if (process.env.PI_PACKAGE_DIR) {
    const envDir = resolve(process.env.PI_PACKAGE_DIR);
    add(dirname(dirname(envDir)));
    add(envDir);
  }

  // When pi launched us, its own package dir is a root for nested copies.
  let dir = process.argv[1] ? dirname(resolve(process.argv[1])) : undefined;
  while (dir) {
    if (existsSync(join(dir, "package.json"))) {
      add(dir);
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  add(process.cwd());

  const seen = new Set();
  return roots.filter((root) => {
    const key = resolve(root).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Packages nested inside `<root>/node_modules` that carry their own pi-coding-agent copy
 * (e.g. a globally installed pi-web-ui with its own tree). Existence checks only — a full
 * recursive scan of a network-mounted node_modules costs ~100x more and finds nothing else.
 */
function nestedPiInstalls(root) {
  const out = [];
  const nm = join(root, "node_modules");
  let entries;
  try {
    entries = readdirSync(nm, { withFileTypes: true });
  } catch {
    return out;
  }
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      try {
        for (const scoped of readdirSync(join(nm, entry.name), { withFileTypes: true })) {
          if (scoped.isDirectory()) packages.push(join(nm, entry.name, scoped.name));
        }
      } catch {
        /* ignore */
      }
      continue;
    }
    packages.push(join(nm, entry.name));
  }
  for (const pkgDir of packages) {
    const nested = join(pkgDir, "node_modules", PI_PKG_DIR);
    try {
      if (existsSync(nested)) out.push(nested);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Every pi-coding-agent install directory that actually has a dist/ folder. */
export function candidatePiDirs(ctx) {
  const dirs = [];
  const seen = new Set();
  const add = (dir) => {
    if (!dir) return;
    let abs;
    try {
      abs = resolve(dir);
    } catch {
      return;
    }
    const key = abs.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    try {
      if (existsSync(join(abs, "dist"))) dirs.push(abs);
    } catch {
      /* unreadable mount */
    }
  };

  for (const root of piInstallRoots(ctx)) {
    // The root may itself be a package dir (e.g. PI_PACKAGE_DIR) or hold node_modules.
    add(root);
    add(join(root, "node_modules", PI_PKG_DIR));
    for (const nested of nestedPiInstalls(root)) add(nested);
  }
  return dirs;
}

// Per-process read cache. Two modules scanning the same 9 MB of bundle chunks in one run should
// cost one read, but a module that *writes* a chunk in between must not see a stale copy — hence
// the stat check on every hit.
const cache = new Map();

export function readTextCached(file) {
  try {
    const stat = statSync(file);
    const key = `${stat.mtimeMs}:${stat.size}`;
    const hit = cache.get(file);
    if (hit && hit.key === key) return hit.content;
    const content = readFileSync(file, "utf8");
    cache.set(file, { key, content });
    return content;
  } catch {
    return undefined;
  }
}

/**
 * Bundle chunks that mention a marker/anchor. Reading every chunk is only worth it for files that
 * could carry the anchor, so callers pass a cheap substring test.
 */
export function matchingChunks(dir, matches) {
  const chunksDir = join(dir, ...CHUNKS_REL);
  const out = [];
  if (!existsSync(chunksDir)) return out;
  let entries;
  try {
    entries = readdirSync(chunksDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const file = join(chunksDir, entry.name);
    const content = readTextCached(file);
    if (content === undefined) continue;
    if (matches(content)) out.push({ file, content, label: entry.name });
  }
  return out;
}
