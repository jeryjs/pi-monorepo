// Patch: precompile pi-hermes-memory into one CommonJS bundle (migrated from scripts/build-hermes.mjs).
//
// What it does: hermes ships ~56 TypeScript files that pi runs through jiti + Babel on every start.
// This task bundles them with esbuild into `dist/index.js`, copies the child-process watchdog next
// to it, and points the package's `pi.extensions` manifest at the bundle. Nothing is patched in
// pi's own dist here — the artifact lives inside the extension package, which is why this patch is
// a `task` (build step) rather than a file transform.
//
// Why the bundle is safe:
//   * it is still loaded through pi's jiti loader, so pi's module aliases resolve as before;
//   * better-sqlite3 / bun:sqlite / node:*, typebox and @earendil-works/pi-* stay external;
//   * import.meta.url is shimmed to the bundle's own URL so createRequire() and the watchdog
//     path resolve relative to dist/;
//   * `@earendil-works/pi-coding-agent` is replaced by a small shim over pi-tui, because pi's alias
//     map does not cover the pi-ai subpaths that package pulls in.
// If dist/index.js is ever missing (package reinstall), pi falls back to auto-discovering
// src/index.ts and the extension keeps working — just slower.
//
// Params: PI_HERMES_PACKAGE (package dir), PI_ESBUILD_FROM (dirs that already have esbuild,
//         ";" separated or JSON array).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentDirOf } from "../_shared/pi-packages.js";

const HERMES_PKG = "pi-hermes-memory";
const BUNDLE_REL = ["dist", "index.js"];
const BUNDLE_ENTRY = "dist/index.js";
const SOURCE_ENTRY = "src/index.ts";
const WATCHDOG_REL = ["src", "handlers", "child-process-watchdog.mjs"];

const EXTERNAL = [
  "better-sqlite3",
  "bun:sqlite",
  "strip-ansi",
  "typebox",
  "typebox/compile",
  "typebox/value",
  "@sinclair/typebox",
  "@sinclair/typebox/compile",
  "@sinclair/typebox/value",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/compat",
  "@earendil-works/pi-ai/models",
  "@earendil-works/pi-ai/oauth",
  "@earendil-works/pi-ai/providers/all",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-agent-core",
];

const PI_CODING_AGENT_SHIM = `
import { getKeybindings, theme } from "@earendil-works/pi-tui";

function formatKeyPart(part, options) {
	const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

export function formatKeyText(key, options = {}) {
	return key.split("/").map((k) => k.split("+").map((part) => formatKeyPart(part, options)).join("+")).join("/");
}

function formatKeys(keys, options = {}) {
	return keys.length === 0 ? "" : formatKeyText(keys.join("/"), options);
}

export function keyText(keybinding) {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyHint(keybinding, description) {
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", " " + description);
}
`;

function packageCandidates(ctx) {
  const agentDir = agentDirOf(ctx);
  const list = [];
  if (ctx?.params?.package) list.push(ctx.params.package);
  list.push(join(agentDir, "npm", "node_modules", HERMES_PKG));
  try {
    for (const entry of readdirSync(join(agentDir, "install", "releases"), { withFileTypes: true })) {
      if (entry.isDirectory()) list.push(join(agentDir, "install", "releases", entry.name, "node_modules", HERMES_PKG));
    }
  } catch {
    /* no managed releases */
  }
  const seen = new Set();
  return list.filter((dir) => {
    if (!dir) return false;
    const abs = resolve(dir);
    const key = abs.toLowerCase();
    if (seen.has(key) || !existsSync(join(abs, SOURCE_ENTRY))) return false;
    seen.add(key);
    return true;
  });
}

function newestMtime(dir) {
  let newest = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          newest = Math.max(newest, statSync(full).mtimeMs);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return newest;
}

const RUNNER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function npmGlobalRoot() {
  try {
    const { spawnSync } = process.getBuiltinModule("node:child_process");
    const res = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], {
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
    });
    const lines = (res.stdout || "").split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
    const out = lines.pop();
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * esbuild is not a dependency of hermes, so it has to be borrowed. Prefer the runner's own copy
 * (patches/node_modules), then anything the caller names, then esbuild found elsewhere on this
 * machine. Borrowing is normal here: bundling only happens when hermes's sources are newer than
 * the bundle, which is a few times a year.
 */
function resolveEsbuild(pkgDir, ctx) {
  const agentDir = agentDirOf(ctx);
  const hosts = [
    ...(ctx?.params?.esbuildFrom || []),
    process.env.ESBUILD_PATH && dirname(process.env.ESBUILD_PATH),
    RUNNER_ROOT,
    pkgDir,
    agentDir,
    join(agentDir, "npm"),
    dirname(process.execPath),
    process.cwd(),
  ].filter(Boolean);
  for (const host of hosts) {
    try {
      return createRequire(join(host, "package.json")).resolve("esbuild");
    } catch {
      /* try the next host */
    }
  }
  const globalRoot = npmGlobalRoot();
  if (globalRoot) {
    try {
      return createRequire(join(globalRoot, "noop.js")).resolve("esbuild");
    } catch {
      /* nothing */
    }
  }
  return null;
}

function hermesPackageJson(pkgDir) {
  const file = join(pkgDir, "package.json");
  if (!existsSync(file)) return { file, json: null };
  try {
    return { file, json: JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return { file, json: null };
  }
}

function manifestPointsAtBundle(pkgDir) {
  const { json } = hermesPackageJson(pkgDir);
  const have = json?.pi?.extensions;
  return Array.isArray(have) && have.length === 1 && have[0] === `./${BUNDLE_ENTRY}`;
}

function state(pkgDir) {
  const bundle = join(pkgDir, ...BUNDLE_REL);
  const hasBundle = existsSync(bundle);
  const stale = !hasBundle || newestMtime(join(pkgDir, "src")) > statSync(bundle).mtimeMs;
  const watchdog = existsSync(join(pkgDir, ...BUNDLE_REL.slice(0, 1), "child-process-watchdog.mjs"));
  return { bundle, hasBundle, stale, watchdog, manifestOk: manifestPointsAtBundle(pkgDir) };
}

async function buildBundle(pkgDir, ctx, logger) {
  const esbuildPath = resolveEsbuild(pkgDir, ctx);
  if (!esbuildPath) throw new Error("esbuild not found — install it somewhere on this machine or set PI_ESBUILD_FROM");
  const { build } = await import(pathToFileURL(esbuildPath).href);

  const shimPlugin = {
    name: "shim-pi-coding-agent",
    setup(b) {
      b.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: "pi-coding-agent-shim", namespace: "shim" }));
      b.onLoad({ filter: /.*/, namespace: "shim" }, () => ({ contents: PI_CODING_AGENT_SHIM, loader: "js", resolveDir: pkgDir }));
    },
  };

  // dist/ is one level below src/, so the two runtime lookups hop from src/ to the bundle.
  const rewritePlugin = {
    name: "rewrite-hermes-paths",
    setup(b) {
      b.onLoad({ filter: /pi-child-process\.ts$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        const contents = source.replace(
          'resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts")',
          'resolve(dirname(fileURLToPath(import.meta.url)), "./index.js")',
        );
        return { contents, loader: "ts" };
      });
    },
  };

  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  const outfile = join(pkgDir, ...BUNDLE_REL);
  const result = await build({
    entryPoints: [join(pkgDir, SOURCE_ENTRY)],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile,
    write: false,
    external: EXTERNAL,
    plugins: [rewritePlugin, shimPlugin],
    sourcemap: false,
    minify: false,
    treeShaking: true,
    logLevel: "silent",
    banner: { js: 'const __import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
    define: { "import.meta.url": "__import_meta_url" },
  });
  if (result.errors?.length) {
    throw new Error(`esbuild failed: ${result.errors.map((e) => e.text).join("; ")}`);
  }
  // Publish atomically: pi may be importing dist/index.js right now (this task runs at launch),
  // and a half-written bundle would fail to load. rename() replaces the target on Windows too.
  const text = result.outputFiles?.[0]?.text;
  if (typeof text !== "string" || !text.length) throw new Error("esbuild produced no output");
  const tmp = `${outfile}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, outfile);
  logger?.info?.(`esbuild bundled ${HERMES_PKG} -> ${BUNDLE_ENTRY}`);

  // The watchdog is a plain .mjs that `node` executes in the child process.
  const watchdogSrc = join(pkgDir, ...WATCHDOG_REL);
  if (existsSync(watchdogSrc)) {
    copyFileSync(watchdogSrc, join(pkgDir, "dist", "child-process-watchdog.mjs"));
  }
  return outfile;
}

function writeManifest(pkgDir, entries) {
  const { file, json } = hermesPackageJson(pkgDir);
  if (!json) return false;
  const have = json.pi?.extensions;
  if (Array.isArray(have) && have.length === entries.length && have.every((v, i) => v === entries[i])) return false;
  json.pi = { ...(json.pi ?? {}), extensions: entries };
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  return true;
}

export default {
  id: "hermes-bundle",
  name: "Precompile pi-hermes-memory",
  description:
    "Bundles pi-hermes-memory's TypeScript sources into dist/index.js with esbuild (watchdog + manifest wired) so pi loads plain JS instead of transpiling 56 files through jiti on every startup.",
  version: "2.0.0",
  tags: ["hermes", "startup", "performance"],
  taskLabel: "bundle",

  params: [
    { key: "package", env: "PI_HERMES_PACKAGE", default: "", type: "string" },
    { key: "esbuildFrom", env: "PI_ESBUILD_FROM", default: [], type: "list" },
  ],

  // Pure build step: no file of pi's own is transformed here.
  targets() {
    return [];
  },

  async task(ctx) {
    const packages = packageCandidates(ctx);
    if (!packages.length) {
      return { changed: false, summary: `${HERMES_PKG} is not installed` };
    }

    const notes = [];
    let changed = false;
    for (const pkgDir of packages) {
      const before = state(pkgDir);

      if (ctx.mode === "revert") {
        if (!before.hasBundle) {
          notes.push(`${pkgDir}: no bundle to remove`);
          continue;
        }
        rmSync(before.bundle, { force: true });
        rmSync(join(pkgDir, "dist", "child-process-watchdog.mjs"), { force: true });
        writeManifest(pkgDir, [`./${SOURCE_ENTRY}`]);
        notes.push(`removed ${BUNDLE_ENTRY}, manifest back to ${SOURCE_ENTRY}`);
        changed = true;
        continue;
      }

      const needsBuild = before.stale;
      const needsManifest = !before.manifestOk;
      if (ctx.mode === "verify") {
        if (needsBuild || needsManifest) {
          changed = true;
          notes.push(`${pkgDir}: ${needsBuild ? "bundle stale/missing" : "manifest not wired"}`);
        }
        continue;
      }

      if (needsBuild) {
        await buildBundle(pkgDir, ctx, ctx.logger);
        notes.push(`built ${BUNDLE_ENTRY} (${(statSync(before.bundle).size / 1024).toFixed(0)} KB)`);
        changed = true;
      }
      if (needsManifest) {
        writeManifest(pkgDir, [`./${BUNDLE_ENTRY}`]);
        notes.push(`wired pi.extensions -> ./${BUNDLE_ENTRY}`);
        changed = true;
      }
      if (!needsBuild && !needsManifest) {
        if (!before.watchdog) {
          const watchdogSrc = join(pkgDir, ...WATCHDOG_REL);
          if (existsSync(watchdogSrc)) {
            copyFileSync(watchdogSrc, join(pkgDir, "dist", "child-process-watchdog.mjs"));
            notes.push("restored child-process-watchdog.mjs");
            changed = true;
          }
        }
        if (!changed) notes.push(`${BUNDLE_ENTRY} up to date`);
      }
    }

    return { changed, summary: notes.join("; ") || "nothing to do" };
  },
};
