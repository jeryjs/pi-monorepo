// Hook: make pi's launcher fire one background patch run at startup.
// Nothing resident, no polling: the hook spawns trigger.cjs, which runs `mainrunner.js run --quiet`
// and exits. All patch logic stays in the patches module registry.
//
// Targets are per platform: the managed Windows launcher (pi-launcher.js, behind pi/pi.cmd/pi.ps1/pi.exe)
// on win32, the POSIX shim (~/.pi/agent/bin/pi) everywhere else, plus any npm-global shim that owns a
// pi package.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { AGENT_DIR, ROOT, readText, sha256, writeAtomic } from "./util.js";

const TRIGGER = join(ROOT, "trigger.cjs");
const BACKUP_DIR = join(ROOT, "backups", "hook");

const MARKERS = {
  js: { start: "// >>> pi-patches hook", end: "// <<< pi-patches hook" },
  sh: { start: "# >>> pi-patches hook", end: "# <<< pi-patches hook" },
  ps1: { start: "# >>> pi-patches hook", end: "# <<< pi-patches hook" },
  cmd: { start: "rem >>> pi-patches hook", end: "rem <<< pi-patches hook" },
};

/** Node and cmd both accept forward slashes; that keeps every snippet escape-free. */
function posixPath(path) {
  return path.split("\\").join("/");
}

function q(path) {
  return JSON.stringify(posixPath(path));
}

/** Single-quoted POSIX word: no expansion, embedded quotes escaped. */
function shq(path) {
  return `'${posixPath(path).split("'").join("'\\''")}'`;
}

function snippet(kind) {
  const m = MARKERS[kind];
  const header = `${m.start} (managed by ${join(ROOT, "mainrunner.js")} — remove with: node mainrunner.js hook uninstall)`;
  const footer = m.end;
  switch (kind) {
    case "js":
      return [
        header,
        "try {",
        '\tif (process.env.PI_PATCHES_DISABLE !== "1") {',
        "\t\t// Synchronous on purpose: the launcher blocks in spawnSync right below, so a",
        "\t\t// dynamic import() would never resolve while pi is running.",
        '\t\tconst cp = (process.getBuiltinModule && process.getBuiltinModule("node:child_process")) || require("node:child_process");',
        `\t\tcp.spawn(process.execPath, [${q(TRIGGER)}], { detached: true, stdio: "ignore", windowsHide: true }).unref();`,
        "\t}",
        "} catch {}",
        footer,
      ].join("\n");
    case "sh":
      // The shim prepends pi's own node to PATH only *after* this block, so resolve node at
      // install time and fall back to a PATH lookup. PI_PATCHES_NODE overrides both.
      return [
        header,
        'if [ "$PI_PATCHES_DISABLE" != "1" ]; then',
        `  pi_patches_node=\${PI_PATCHES_NODE:-${shq(process.execPath)}}`,
        '  if [ -x "$pi_patches_node" ]; then',
        `    ("$pi_patches_node" ${shq(TRIGGER)} >/dev/null 2>&1 </dev/null &)`,
        "  elif command -v node >/dev/null 2>&1; then",
        `    (node ${shq(TRIGGER)} >/dev/null 2>&1 </dev/null &)`,
        "  fi",
        "fi",
        footer,
      ].join("\n");
    case "cmd":
      return [
        header,
        'if not "%PI_PATCHES_DISABLE%"=="1" start "" /b node "' + posixPath(TRIGGER) + '" >nul 2>&1',
        footer,
      ].join("\n");
    case "ps1":
      return [
        header,
        'if ($env:PI_PATCHES_DISABLE -ne "1") { try { Start-Process -FilePath "node" -ArgumentList \'' + TRIGGER + "' -WindowStyle Hidden | Out-Null } catch {} }",
        footer,
      ].join("\n");
    default:
      throw new Error(`unknown hook kind: ${kind}`);
  }
}

/** The file every pi start goes through, per platform. */
function launcherCandidates() {
  if (process.platform === "win32") {
    return [
      {
        kind: "js",
        file: join(AGENT_DIR, "bin", "pi-launcher.js"),
        label: "managed launcher (covers pi, pi.cmd, pi.ps1)",
      },
    ];
  }
  return [
    {
      kind: "sh",
      file: join(AGENT_DIR, "bin", "pi"),
      label: "managed launcher (the pi shim)",
    },
  ];
}

/** True when an npm prefix owns an installed pi package (both npm layouts: <prefix>/node_modules and <prefix>/bin). */
function prefixHasPi(prefix) {
  return [
    join(prefix, "node_modules", "@earendil-works", "pi-coding-agent"),
    join(prefix, "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent"),
  ].some((dir) => existsSync(dir));
}

/** Node's dir, the Windows npm dir and every PATH entry — anywhere npm may have dropped a shim. */
function shimPrefixes() {
  const prefixes = new Set();
  if (process.execPath) prefixes.add(dirname(process.execPath));
  if (process.env.APPDATA) prefixes.add(join(process.env.APPDATA, "npm"));
  for (const dir of String(process.env.PATH || "").split(delimiter)) {
    if (dir) prefixes.add(dir);
  }
  return prefixes;
}

/** Where the hooks go: the platform launcher plus any npm shim that owns a pi package. */
export function hookTargets() {
  const targets = [];
  const seen = new Set();
  const push = (target) => {
    const key = process.platform === "win32" ? target.file.toLowerCase() : target.file;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };
  for (const target of launcherCandidates()) push({ ...target, required: true });
  for (const prefix of shimPrefixes()) {
    if (!prefixHasPi(prefix)) continue;
    for (const [name, kind] of [
      ["pi", "sh"],
      ["pi.cmd", "cmd"],
      ["pi.ps1", "ps1"],
    ]) {
      const file = join(prefix, name);
      if (existsSync(file)) push({ kind, file, label: `npm shim (${prefix})`, required: false });
    }
  }
  return targets;
}

function detectKind(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) return "cmd";
  if (lower.endsWith(".ps1")) return "ps1";
  if (lower.endsWith(".sh")) return "sh";
  return "js";
}

function markerPresent(content, kind) {
  return content.includes(MARKERS[kind].start);
}

function stripBlock(content, kind) {
  const { start, end } = MARKERS[kind];
  const pattern = new RegExp(`^[ \\t]*${escapeRe(start)}[^\\n]*\\n[\\s\\S]*?^[ \\t]*${escapeRe(end)}[^\\n]*(\\r?\\n)?`, "m");
  return content.replace(pattern, "");
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function insertBlock(content, block, kind) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const blockLines = block.split("\n");
  let index = 0;
  if (kind === "js") {
    // after the last top-level require/import line
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(?:const|let|var)\s+.*\brequire\(/.test(lines[i]) || /^\s*import\s+.*from\s+/.test(lines[i])) index = i + 1;
      if (i > 40) break;
    }
  } else if (kind === "cmd") {
    index = lines.findIndex((line) => /^@echo/i.test(line.trim()));
    index = index === -1 ? 0 : index + 1;
  } else {
    index = lines[0] && lines[0].startsWith("#!") ? 1 : 0;
  }
  const head = lines.slice(0, index);
  const tail = lines.slice(index);
  const needsGap = tail.length > 0 && tail[0].trim() !== "";
  const merged = [...head, ...blockLines, ...(needsGap ? [""] : []), ...tail].join(eol);
  return merged;
}

/** Keeps the untouched launcher so `uninstall` can restore it byte for byte.
 *
 * The name is path-derived: `pi` can exist several times on PATH (managed shim + npm-global
 * shim), and a basename-only name would hand one file's pristine copy to the other. The legacy
 * `<basename>.orig` name is still read (and still written for the platform launcher) so backups
 * made by earlier versions keep working.
 */
function pristineName(file) {
  return `${basename(file)}.${sha256(file).slice(0, 8)}.orig`;
}

function pristineFile(file, { legacy = true } = {}) {
  const hashed = join(BACKUP_DIR, pristineName(file));
  if (existsSync(hashed)) return hashed;
  const old = join(BACKUP_DIR, `${basename(file)}.orig`);
  if (legacy && existsSync(old)) return old;
  return hashed;
}

function saveOriginal(file) {
  try {
    const current = readText(file);
    // A launcher that already carries a hook is not a pristine copy.
    if (current === undefined || Object.keys(MARKERS).some((kind) => markerPresent(current, kind))) return null;
    mkdirSync(BACKUP_DIR, { recursive: true });
    const target = join(BACKUP_DIR, pristineName(file));
    if (!existsSync(target)) copyFileSync(file, target);
    return target;
  } catch {
    return null;
  }
}

const CRLF = String.fromCharCode(13, 10);
const LF = String.fromCharCode(10);

function normalizeEol(text) {
  return text.split(CRLF).join(LF);
}

export function hookStatus() {
  const targets = hookTargets().map((target) => {
    const kind = target.kind || detectKind(target.file);
    const content = readText(target.file);
    return {
      ...target,
      kind,
      exists: content !== undefined,
      installed: content ? markerPresent(content, kind) : false,
    };
  });
  const present = targets.filter((t) => t.exists);
  return {
    trigger: TRIGGER,
    triggerExists: existsSync(TRIGGER),
    hasTargets: present.length > 0,
    installed: present.some((t) => t.installed),
    allInstalled: present.length > 0 && present.every((t) => t.installed),
    targets,
    disabledEnv: process.env.PI_PATCHES_DISABLE === "1",
  };
}

export function installHook({ dryRun = false } = {}) {
  const status = hookStatus();
  if (!status.triggerExists) {
    return { ok: false, message: `trigger script missing: ${TRIGGER}`, changes: [] };
  }
  const changes = [];
  let hooked = 0;
  for (const target of status.targets) {
    if (!target.exists) {
      if (target.required) changes.push({ file: target.file, action: "missing", label: target.label });
      continue;
    }
    const content = readText(target.file);
    const kind = target.kind;
    const block = snippet(kind);
    let next = content;
    if (markerPresent(content, kind)) {
      // refresh in place so path/version changes propagate
      const stripped = stripBlock(content, kind);
      next = insertBlock(stripped, block, kind);
    } else {
      next = insertBlock(content, block, kind);
    }
    if (next === content) {
      changes.push({ file: target.file, action: "unchanged", label: target.label });
      hooked++;
      continue;
    }
    saveOriginal(target.file);
    if (!dryRun) writeAtomic(target.file, next);
    changes.push({ file: target.file, action: dryRun ? "would-install" : "installed", label: target.label });
    hooked++;
  }
  if (!hooked) {
    return {
      ok: false,
      message: `no pi launcher found — looked for ${status.targets.map((t) => posixPath(t.file)).join(", ")}`,
      changes,
    };
  }
  return { ok: true, changes };
}

export function uninstallHook({ dryRun = false } = {}) {
  const status = hookStatus();
  const changes = [];
  for (const target of status.targets) {
    if (!target.exists) continue;
    if (!target.installed) {
      changes.push({ file: target.file, action: "not-installed", label: target.label });
      continue;
    }
    const content = readText(target.file);
    const next = stripBlock(content, target.kind);
    // If the launcher is exactly "pristine + our current block", restore the pristine copy byte
    // for byte. Reconstructing beats comparing stripBlock() output: insertBlock() adds a blank
    // separator line, so a naive diff would leave that one line behind.
    const pristinePath = pristineFile(target.file);
    const pristine = readText(pristinePath);
    if (pristine !== undefined) {
      const reconstructed = insertBlock(stripBlock(pristine, target.kind), snippet(target.kind), target.kind);
      if (normalizeEol(reconstructed) === normalizeEol(content)) {
        if (!dryRun) copyFileSync(pristinePath, target.file);
        changes.push({ file: target.file, action: dryRun ? "would-remove" : "removed", label: `${target.label} (restored pristine copy)` });
        continue;
      }
    }
    if (next === content) {
      changes.push({ file: target.file, action: "unchanged", label: target.label });
      continue;
    }
    saveOriginal(target.file);
    if (!dryRun) writeAtomic(target.file, next);
    changes.push({ file: target.file, action: dryRun ? "would-remove" : "removed", label: target.label });
  }
  return { ok: true, changes };
}

/** Called by `run` so a pi update that restores the launcher cannot silently kill the trigger. */
export function ensureHookInstalled({ logger } = {}) {
  const status = hookStatus();
  if (!status.hasTargets) return { ok: false, healed: false, status, message: "no pi launcher found" };
  if (status.allInstalled) return { ok: true, healed: false, status };
  const result = installHook();
  const touched = result.changes.filter((c) => c.action === "installed" || c.action === "would-install");
  if (touched.length) {
    logger?.info(`hook re-installed in ${touched.length} launcher file(s): ${touched.map((c) => c.file).join(", ")}`);
  }
  return { ok: result.ok, healed: touched.length > 0, status: hookStatus() };
}
