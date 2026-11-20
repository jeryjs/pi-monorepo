// Shared helpers for the pi patch runner: paths, hashing, atomic IO, colors, logging, locking.
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

export const SCHEMA_VERSION = 1;

export const PATHS = {
  root: ROOT,
  main: join(ROOT, "mainrunner.js"),
  state: join(ROOT, "state.json"),
  registry: join(ROOT, "patches.json"),
  backups: join(ROOT, "backups"),
  report: join(ROOT, "conflicts.html"),
  template: join(HERE, "report-template.html"),
  log: join(ROOT, "runner.log"),
  pid: join(ROOT, "runner.pid"),
  lock: join(ROOT, ".lock"),
};

export const HOST = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  hostname: hostname(),
  pid: process.pid,
  agentDir: AGENT_DIR,
  patchesDir: ROOT,
};

// ---------------------------------------------------------------- time

export function nowIso() {
  return new Date().toISOString();
}

/** 20261103-071019-123 — filename safe. */
export function fileStamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${p(date.getMilliseconds(), 3)}`
  );
}

export function relTime(iso) {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return String(iso);
  const diff = Date.now() - then;
  if (diff < 0) return "just now";
  const s = Math.round(diff / 1000);
  if (s < 45) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

export function humanMs(ms) {
  if (ms === undefined || ms === null) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

// ---------------------------------------------------------------- hashing / text

export function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function shortHash(hash) {
  return (hash || "").slice(0, 12) || "-";
}

export function countLines(text) {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

export function truncate(text, max = 120) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Cheap "what changed" preview: trims the common prefix/suffix and shows the
 * replaced middle as -/+ lines. Not a real LCS diff, but tiny and always safe.
 */
export function previewDiff(before, after, maxLines = 40) {
  if (before === after) return { added: 0, removed: 0, preview: "" };
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const removedLines = a.slice(start, endA + 1);
  const addedLines = b.slice(start, endB + 1);
  const out = [`@@ line ${start + 1} @@`];
  for (const line of removedLines.slice(0, maxLines)) out.push(`- ${truncate(line, 300)}`);
  if (removedLines.length > maxLines) out.push(`- … ${removedLines.length - maxLines} more removed line(s)`);
  for (const line of addedLines.slice(0, maxLines)) out.push(`+ ${truncate(line, 300)}`);
  if (addedLines.length > maxLines) out.push(`+ … ${addedLines.length - maxLines} more added line(s)`);
  return { added: addedLines.length, removed: removedLines.length, preview: out.join("\n") };
}

// ---------------------------------------------------------------- fs

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function exists(file) {
  try {
    return existsSync(file);
  } catch {
    return false;
  }
}

export function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function writeAtomic(file, content) {
  ensureDir(dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  // Keep the target's permission bits: on POSIX a bare write would drop +x from launchers and
  // scripts (Windows has no such bits, so this only matters where it matters).
  let mode;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    mode = undefined;
  }
  writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
  if (mode !== undefined && process.platform !== "win32") {
    // writeFileSync's mode is masked by the umask; pin the exact bits.
    try {
      chmodSync(tmp, mode);
    } catch {
      /* best effort: the rename below still preserves the content */
    }
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function writeJson(file, value) {
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function expandPath(p) {
  if (!p) return p;
  let out = String(p).trim();
  if (out === "~") out = homedir();
  else if (out.startsWith("~/") || out.startsWith("~\\")) out = join(homedir(), out.slice(2));
  out = out.replace(/\{agentDir\}/gi, AGENT_DIR).replace(/\{patchesDir\}/gi, ROOT);
  out = out.replace(/\{home\}/gi, homedir());
  return isAbsolute(out) ? out : resolve(ROOT, out);
}

export function relToRoot(file) {
  try {
    const rel = relative(ROOT, file);
    return rel && !rel.startsWith("..") ? rel : file;
  } catch {
    return file;
  }
}

export function toPosix(p) {
  return String(p).split("\\").join("/");
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------------------------------------------------------------- colors

let colorEnabled = (() => {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(process.stdout && process.stdout.isTTY);
})();

export function setColor(enabled) {
  colorEnabled = Boolean(enabled);
}

export function colorOn() {
  return colorEnabled;
}

function paint(code, text) {
  return colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : String(text);
}

export const c = {
  bold: (s) => paint("1", s),
  dim: (s) => paint("2", s),
  italic: (s) => paint("3", s),
  underline: (s) => paint("4", s),
  red: (s) => paint("31", s),
  green: (s) => paint("32", s),
  yellow: (s) => paint("33", s),
  blue: (s) => paint("34", s),
  magenta: (s) => paint("35", s),
  cyan: (s) => paint("36", s),
  white: (s) => paint("37", s),
  gray: (s) => paint("90", s),
  bgRed: (s) => paint("41;97", s),
  bgGreen: (s) => paint("42;30", s),
  bgYellow: (s) => paint("43;30", s),
  bgBlue: (s) => paint("44;97", s),
};

export const STATUS_STYLE = {
  applied: c.green,
  clean: c.cyan,
  ok: c.green,
  verified: c.green,
  "would-apply": c.yellow,
  pending: c.yellow,
  drift: c.yellow,
  skipped: c.gray,
  disabled: c.gray,
  reverted: c.magenta,
  failed: c.red,
  conflict: c.red,
  error: c.red,
  missing: c.yellow,
  "no-targets": c.yellow,
  unknown: c.gray,
};

export function statusColor(status) {
  const fn = STATUS_STYLE[status] || c.white;
  return fn(String(status ?? "unknown"));
}

// ---------------------------------------------------------------- logging

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({
  file = PATHS.log,
  level = "info",
  quiet = false,
  maxBytes = 1024 * 1024,
  echo = true,
} = {}) {
  ensureDir(dirname(file));
  const threshold = LEVELS[level] ?? LEVELS.info;

  function rotate() {
    try {
      if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
    } catch {
      /* no file yet */
    }
  }

  function write(lvl, msg, extra) {
    if ((LEVELS[lvl] ?? 20) < threshold) return;
    const extraText = extra ? ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}` : "";
    const line = `${nowIso()} [${lvl}] ${msg}${extraText}`;
    try {
      rotate();
      appendFileSync(file, `${line}\n`);
    } catch {
      /* logging must never throw */
    }
    if (!quiet && echo) {
      const text = lvl === "error" ? c.red(line) : lvl === "warn" ? c.yellow(line) : c.gray(line);
      (lvl === "error" || lvl === "warn" ? console.error : console.log)(text);
    }
  }

  return {
    file,
    debug: (m, e) => write("debug", m, e),
    info: (m, e) => write("info", m, e),
    warn: (m, e) => write("warn", m, e),
    error: (m, e) => write("error", m, e),
  };
}

export function tailFile(file, lines = 40) {
  const text = readText(file);
  if (!text) return [];
  return text.trimEnd().split(/\r?\n/).slice(-lines);
}

// ---------------------------------------------------------------- process / lock

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

export function readPidFile() {
  const raw = readText(PATHS.pid);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { pid: Number(raw.trim()) || null };
  }
}

export function writePidFile(info) {
  writeJson(PATHS.pid, { ...info, pid: process.pid, startedAt: info?.startedAt || nowIso() });
}

export function clearPidFile() {
  try {
    unlinkSync(PATHS.pid);
  } catch {
    /* already gone */
  }
}

export function readLock() {
  return readJson(PATHS.lock, null);
}

/** Cross-process guard so the daemon and a manual CLI run never fight over files. */
export function acquireLock({ steal = false, owner = "run" } = {}) {
  const current = readLock();
  if (current && current.pid && current.pid !== process.pid && isPidAlive(current.pid) && !steal) {
    return { ok: false, holder: current };
  }
  writeJson(PATHS.lock, { pid: process.pid, owner, at: nowIso() });
  return { ok: true };
}

export function releaseLock() {
  const current = readLock();
  if (current && current.pid === process.pid) {
    try {
      unlinkSync(PATHS.lock);
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- misc

export function sortByPriority(a, b) {
  const pa = Number.isFinite(a.priority) ? a.priority : 100;
  const pb = Number.isFinite(b.priority) ? b.priority : 100;
  if (pa !== pb) return pa - pb;
  return String(a.id).localeCompare(String(b.id));
}

export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function firstLine(text) {
  return String(text ?? "").split(/\r?\n/)[0];
}

export function errorInfo(err) {
  if (!err) return { name: "Error", message: "unknown error", stack: "" };
  if (typeof err === "string") return { name: "Error", message: err, stack: err };
  return {
    name: err.name || "Error",
    message: err.message || String(err),
    stack: err.stack || String(err),
  };
}

export function patchFolderLabel(file) {
  return basename(dirname(file));
}
