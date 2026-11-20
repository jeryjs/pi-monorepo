/**
 * oc-proxy — on-demand egress proxy for pi-free's `opencode-free` provider.
 *
 * HARD REQUIREMENT — the `hook-stream` patch:
 * This extension does not work on a stock pi. Everything below depends on the
 * provider-request hook pipeline that `patches/all-patches/hook-stream` adds
 * (`ExtensionRunner#createProviderHooks()`, `ExtensionContext#providerHooks()`).
 * Without it there is no pipeline to stream the retry through, the 429
 * fallthrough never engages, and the extension is inert. Check with
 * `node ~/.pi/agent/patches/mainrunner.js status` (hook-stream must read
 * `clean yes`). See README.md § Requirements.
 *
 * Problem: opencode-free rate-limits by egress IP. When a 429 lands, you want
 * the *next* opencode-free request to leave through a proxy (different IP)
 * without touching credentials, pools, or any other extension.
 *
 * What it does NOT touch (so pi-free's special handling stays intact):
 *  - the `public` anonymous bearer, the `x-opencode-session` / `x-opencode-request`
 *    ids, the `<env>Working directory: .</env>` envelope, message sanitisation,
 *    wire-API dispatch, and pi-free's own bun TLS relay.
 *  - the HTTP transport. No custom `fetch` is injected (pi-ai's
 *    google-generative-ai adapter rejects one outright), so the anonymous
 *    lane's Bun TLS fingerprint is preserved.
 *
 * It only rewrites `model.baseUrl` before handing the call back to pi-free's
 * own `streamSimple`. pi-free then runs `getOpenCodeModelBaseUrl()` on it and
 * `getOpenCodeRelayBaseUrl()` declines anything that is not
 * `https://opencode.ai/...`, so pi-free's relay steps aside and this
 * extension's relay carries the transport hop instead.
 *
 * 429 detection lives on the *error* path. pi-ai calls `options.onResponse`
 * only after a successful response (the SDK throws on non-2xx first), so
 * neither `onResponse` nor pi's `after_provider_response` event ever fires for
 * a 429. The real signal is the terminal `error` event of the response
 * stream, observed here without consuming it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Config ──────────────────────────────────────────────────────────────────

interface OcProxyConfig {
  /** Provider to watch. */
  provider: string;
  /** Proxy URL applied on activation, e.g. "http://user:pass@host:port". */
  proxy: string;
  /** Optional rotation list; when non-empty it wins over `proxy`. */
  proxies: string[];
  /** Auto-activate on the first 429 from `provider`. */
  autoEnableOn429: boolean;
  /** When already proxied and a 429 arrives, advance to the next proxy. */
  rotateOn429: boolean;
  /** How long a proxy that answered 429 is skipped before being retried. */
  proxyCooldownMs: number;
  /**
   * Route order. true (default) = try the client's own IP first and only
   * fall through to a proxy when that answers 429. false = proxy first.
   */
  preferDirect: boolean;
  /** Override pi-ai's internal retry count for this provider. undefined = inherit. */
  maxRetries?: number;
  /** Advanced: relay upstream root. */
  relayUpstream: string;
  /** Advanced: bun executable. */
  bunPath: string;
  /**
   * Opt-in debug trace. A path (relative to this config file, or absolute) or
   * undefined. When absent nothing is written — there is no log at all.
   */
  debugLog?: string;
}

/** Subset of pi-tui's AutocompleteItem used for `/oc-proxy` completion. */
interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

const DEFAULTS: OcProxyConfig = {
  provider: "opencode-free",
  // Empty, not a placeholder URL: a fresh config must not activate a route
  // that cannot work. Fill in `proxy` or `proxies` to switch proxying on.
  proxy: "",
  proxies: [],
  autoEnableOn429: true,
  rotateOn429: true,
  proxyCooldownMs: 600000,
  preferDirect: true,
  maxRetries: undefined,
  relayUpstream: "https://opencode.ai",
  bunPath: "bun",
};

function extensionDir(): string {
  // This extension's directory: ~/.pi/agent/extensions/opencode-429-proxy
  return join(homedir(), ".pi", "agent", "extensions", "opencode-429-proxy");
}

/**
 * Config lives beside the extension folder, not inside it:
 * ~/.pi/agent/extensions/opencode-429-proxy.json
 *
 * One file for everything: settings and the relay's runtime state (routes and
 * cooldown deadlines, under `relay`). The relay child re-reads it per request,
 * so writes are atomic (temp + rename) to never hand it a half-written file.
 */
const CONFIG_PATH = () => join(extensionDir(), "..", "opencode-429-proxy.json");

/** Raw file contents, whatever keys it has (unknown keys survive a rewrite). */
function readRawConfig(): Record<string, any> {
  const path = CONFIG_PATH();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Atomic replace: the relay may be reading the file on any request. */
function writeRawConfig(raw: Record<string, any>): void {
  const path = CONFIG_PATH();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/** Absolute path of the debug log, or undefined when logging is off. */
let logTarget: string | undefined;

function resolveLogTarget(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const target = value.trim();
  return isAbsolute(target) ? target : join(dirname(CONFIG_PATH()), target);
}

function loadConfig(): OcProxyConfig {
  const path = CONFIG_PATH();
  let raw: Partial<OcProxyConfig> = {};
  if (existsSync(path)) {
    raw = readRawConfig() as Partial<OcProxyConfig>;
  } else {
    try {
      writeRawConfig({ ...DEFAULTS, relay: { routes: ["direct"], blockedUntil: {} } });
    } catch {
      /* read-only fs: defaults still work */
    }
  }
  logTarget = resolveLogTarget(raw.debugLog);
  return {
    provider: typeof raw.provider === "string" && raw.provider ? raw.provider : DEFAULTS.provider,
    proxy: typeof raw.proxy === "string" ? raw.proxy : DEFAULTS.proxy,
    proxies: Array.isArray(raw.proxies) ? raw.proxies.filter((v) => typeof v === "string" && v) : [],
    autoEnableOn429: raw.autoEnableOn429 !== false,
    rotateOn429: raw.rotateOn429 !== false,
    maxRetries: typeof raw.maxRetries === "number" ? raw.maxRetries : undefined,
    proxyCooldownMs:
      typeof raw.proxyCooldownMs === "number" && raw.proxyCooldownMs >= 0
        ? raw.proxyCooldownMs
        : DEFAULTS.proxyCooldownMs,
    preferDirect: raw.preferDirect !== false,
    relayUpstream:
      typeof raw.relayUpstream === "string" && raw.relayUpstream ? raw.relayUpstream : DEFAULTS.relayUpstream,
    bunPath: typeof raw.bunPath === "string" && raw.bunPath ? raw.bunPath : DEFAULTS.bunPath,
    debugLog: logTarget,
  };
}

/** Settings only — the `relay` block belongs to the relay and is preserved. */
function saveConfig(cfg: OcProxyConfig): void {
  try {
    const raw = readRawConfig();
    const settings: Record<string, unknown> = { ...cfg };
    delete settings.debugLog;
    if (cfg.debugLog) settings.debugLog = cfg.debugLog;
    if (settings.maxRetries === undefined) delete settings.maxRetries;
    writeRawConfig({ ...raw, ...settings });
  } catch {
    /* ignore */
  }
}

/** Proxy list actually used, in rotation order. */
function proxyList(cfg: OcProxyConfig): string[] {
  return cfg.proxies.length > 0 ? cfg.proxies : cfg.proxy ? [cfg.proxy] : [];
}

/** The literal route that means "no proxy": the client's own egress IP. */
const DIRECT_ROUTE = "direct";

/**
 * Proxies in the order the relay should try them: starting at `proxyIndex`
 * and wrapping around. This order is what decides "next proxy on 429".
 */
function relayChain(): string[] {
  const list = proxyList(state.config);
  if (list.length === 0) return [];
  const start = Math.min(state.proxyIndex, list.length - 1);
  return [...list.slice(start), ...list.slice(0, start)];
}

/**
 * Ordered egress routes for the relay. `preferDirect` puts the client's own
 * IP first so a proxy is only touched once it answers 429 — that is what
 * makes the switch happen *inside* the failing request instead of costing
 * the user a "Continue" on the next turn.
 */
function relayRoutes(): string[] {
  const chain = relayChain();
  const ordered = state.proxyFirst ? [...chain, DIRECT_ROUTE] : [DIRECT_ROUTE, ...chain];
  return [...new Set(ordered)];
}

/** The routes actually written to the relay; honours `rotateOn429: false`. */
function emittedRoutes(): string[] {
  if (!state.enabled) return [DIRECT_ROUTE];
  const routes = relayRoutes();
  if (state.config.rotateOn429) return routes;
  const firstProxy = routes.find((route) => route !== DIRECT_ROUTE);
  return firstProxy === undefined
    ? [DIRECT_ROUTE]
    : state.proxyFirst
      ? [firstProxy, DIRECT_ROUTE]
      : [DIRECT_ROUTE, firstProxy];
}

/**
 * The relay's runtime state, kept in the `relay` block of the same JSON file.
 * `routes` is what the relay walks per request; `blockedUntil` is the cooldown
 * deadlines it parks a route on after a 429.
 */
interface RelayFileState {
  routes: string[];
  blockedUntil: Record<string, number>;
}

/** `relay` block, falling back to a legacy top-level one. */
function relayBlock(raw: Record<string, any>): Record<string, any> {
  const relay = raw.relay;
  if (relay && typeof relay === "object" && !Array.isArray(relay)) return relay as Record<string, any>;
  return raw;
}

function readRelayFile(): RelayFileState {
  const relay = relayBlock(readRawConfig());
  const routes = Array.isArray(relay.routes) ? relay.routes.filter((r: unknown) => typeof r === "string" && r) : [];
  const blockedUntil: Record<string, number> = {};
  const now = Date.now();
  if (relay.blockedUntil && typeof relay.blockedUntil === "object") {
    for (const [route, until] of Object.entries(relay.blockedUntil)) {
      if (typeof until === "number" && until > now) blockedUntil[route] = until;
    }
  }
  return { routes: routes.length > 0 ? routes : ["direct"], blockedUntil };
}

function writeRelayState(): void {
  try {
    const raw = readRawConfig();
    // Merge, do not replace: cooldowns survive a session restart, and a
    // write from a fresh session must not resurrect a parked proxy.
    const blockedUntil = { ...readBlockedUntil(), ...state.blockedUntil };
    const now = Date.now();
    for (const proxy of Object.keys(blockedUntil)) {
      if (!(blockedUntil[proxy] > now)) delete blockedUntil[proxy];
    }
    raw.relay = { routes: emittedRoutes(), blockedUntil };
    writeRawConfig(raw);
  } catch {
    /* ignore */
  }
}

/** Cooldown deadlines still in the future, as persisted by the last session. */
function readBlockedUntil(): Record<string, number> {
  return readRelayFile().blockedUntil;
}

// ── Debug log ───────────────────────────────────────────────────────────────

/**
 * Append-only trace. Off unless `debugLog` names a path in the config file;
 * a relative path resolves next to that file. Nothing is written when unset —
 * no log file is created at all. Never touches stdout.
 */
function debug(...parts: unknown[]): void {
  if (!logTarget) return;
  try {
    const line = parts
      .map((p) => (typeof p === "string" ? p : p instanceof Error ? p.message : JSON.stringify(p)))
      .join(" ");
    appendFileSync(logTarget, line + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

// ── 429 detection ───────────────────────────────────────────────────────────

/**
 * pi-ai reports an upstream 429 very differently per transport. These are the
 * exact strings, captured by replaying a 429 response through every adapter
 * opencode-free uses:
 *
 *   openai-completions    429: {"type":"FreeUsageLimitError","message":"..."}
 *   openai-responses      opencode-free API error (429): {"type":"FreeUsageLimitError",...}
 *   anthropic-messages    429 Free usage limit reached. ...
 *   google-generative-ai  {"type":"FreeUsageLimitError","message":"..."}   <- no status!
 *
 * So neither a status-only nor a body-only test is sufficient: the google
 * lane has no status and the anthropic lane has no body marker. Match all
 * four shapes.
 */
function isRateLimited(message: unknown): boolean {
  const text = typeof message === "string" ? message : message ? String(message) : "";
  if (!text) return false;
  // Upstream's own marker (openai-completions, openai-responses, google).
  if (text.includes("FreeUsageLimitError")) return true;
  // "<status>: {json}" and "<status> <message>" (anthropic lane).
  if (/^\s*429\b/.test(text)) return true;
  // "<provider> API error (429): {json}".
  if (/\(\s*429\s*\)/.test(text)) return true;
  // Generic wording, last resort.
  if (/\b(usage limit reached|rate limit)\b/i.test(text)) return true;
  return false;
}

// ── Relay child (bun) ───────────────────────────────────────────────────────

/**
 * Loopback byte pipe. Mirrors pi-free's own relay contract: forward only
 * allowlisted paths, copy headers, keep encoded bytes, stream the body.
 * Difference: an optional `proxy` is handed to Bun's fetch, which is what
 * changes the egress IP while keeping Bun's TLS fingerprint. The upstream
 * status is echoed on stdout so the extension gets the exact HTTP code.
 */
const RELAY_SCRIPT = [
  'const CONFIG = process.env.OC_PROXY_CONFIG || "";',
  'const UP = (process.env.OC_PROXY_RELAY_UPSTREAM || "https://opencode.ai").replace(/\\/+$/, "");',
  'const ALLOW = /^\\/(zen|inference)\\/v1(\\/|$)/;',
  'const COOLDOWN = Number(process.env.OC_PROXY_RELAY_COOLDOWN_MS || 600000);',
  'const parked = {};',
  'function relayOf(parsed) {',
  '  const block = parsed && typeof parsed === "object" ? parsed.relay : null;',
  '  return block && typeof block === "object" && !Array.isArray(block) ? block : parsed || {};',
  '}',
  'function park(route, parsed) {',
  '  parked[route] = Date.now() + COOLDOWN;',
  '  const base = parsed && typeof parsed === "object" ? parsed : {};',
  '  const block = relayOf(base);',
  '  const next = Object.assign({}, base, {',
  '    relay: Object.assign({}, block, {',
  '      blockedUntil: Object.assign({}, block.blockedUntil || {}, parked),',
  '    }),',
  '  });',
  '  console.log("PARKED=" + route);',
  '  Bun.write(CONFIG, JSON.stringify(next, null, 2) + String.fromCharCode(10)).catch((e) => console.log("PARKERR=" + String((e && e.message) || e)));',
  '}',
  "async function readState() {",
  "  try {",
  "    const text = await Bun.file(CONFIG).text();",
  "    const parsed = JSON.parse(text);",
  '    const block = relayOf(parsed);',
  '    let routes = Array.isArray(block.routes) ? block.routes.filter((r) => typeof r === "string" && r) : [];',
  "    // Back-compat: a state file written before routes were recorded.",
  '    if (routes.length === 0) {',
  '      const listed = Array.isArray(block.proxies) ? block.proxies.filter((p) => typeof p === "string" && p) : typeof block.proxy === "string" && block.proxy ? [block.proxy] : [];',
  '      routes = block.direct === false ? listed : [...listed, "direct"];',
  "    }",
  '    if (routes.length === 0) routes = ["direct"];',
  '    const blocked = Object.assign({}, block.blockedUntil || {}, parked);',
  "    return { routes, blocked, parsed };",
  "  } catch {",
  '    return { routes: ["direct"], blocked: Object.assign({}, parked), parsed: null };',
  "  }",
  "}",
  "async function attempt(target, base, proxy) {",
  "  try {",
  "    return await fetch(target, proxy ? Object.assign({}, base, { proxy }) : base);",
  "  } catch (error) {",
  "    const message = String((error && error.message) || error);",
  '    console.log("RELAYERR=" + (proxy ? proxy + " " : "direct ") + message);',
  '    return null;',
  "  }",
  "}",
  "const server = Bun.serve({",
  '  hostname: "127.0.0.1",',
  "  port: 0,",
  "  idleTimeout: 0,",
  "  async fetch(req) {",
  "    const url = new URL(req.url);",
  "    if (!ALLOW.test(url.pathname)) return new Response(undefined, { status: 404 });",
  "    const headers = new Headers();",
  '    req.headers.forEach((value, key) => { if (key !== "host" && key !== "connection") headers.set(key, value); });',
  "    const state = await readState();",
  "    const now = Date.now();",
  "    const base = {",
  "      method: req.method,",
  "      headers,",
  '      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),',
  '      redirect: "manual",',
  "      decompress: false,",
  "    };",
  "    const target = UP + url.pathname + url.search;",
  '    const parked = (r) => typeof state.blocked[r] === "number" && state.blocked[r] > now;',
  "    let chain = state.routes.filter((route) => !parked(route));",
  "    // Everything parked: still try direct once, so a session is never",
  "    // bricked until the cooldowns expire (and never loop: one attempt).",
  '    if (chain.length === 0) chain = state.routes.includes("direct") ? ["direct"] : [state.routes[0]];',
  "    // Walk the routes: a route whose egress 429s is reported so the",
  "    // extension can park it, then the next route is tried in this very",
  "    // request. Bounded by routes.length, so it can never loop.",
  "    let response = null;",
  "    for (const route of chain) {",
  '      const proxy = route === "direct" ? null : route;',
  "      const hop = await attempt(target, base, proxy);",
  "      // An unreachable hop is a skip too: the chain must reach an",
  "      // attemptable route instead of failing the turn on a dead hop.",
  "      if (!hop) {",
  '        console.log("ROUTEFAIL=" + route);',
  "        continue;",
  "      }",
  "      response = hop;",
  "      if (hop.status !== 429) break;",
  '      console.log("ROUTE429=" + route);',
  "      park(route, state.parsed);",
  "    }",
  '    if (!response) response = new Response(JSON.stringify({ type: "error", error: { type: "relay", message: "no egress route" } }), { status: 502, headers: { "content-type": "application/json" } });',
  '    console.log("STATUS=" + response.status);',
  "    return response;",
  "  },",
  "});",
  'process.stdin.on("end", () => { server.stop(true); process.exit(0); });',
  "process.stdin.resume();",
  'console.log("PORT=" + server.port);',
].join("\n");

interface RelayHandle {
  child: ChildProcess;
  baseUrl: string;
}

const state = {
  config: DEFAULTS as OcProxyConfig,
  enabled: false,
  proxyIndex: 0,
  /** Runtime route order override: true = proxy first (set by `/oc-proxy on`). */
  proxyFirst: false,
  /** Per-proxy cooldown deadlines (epoch ms) after their egress answered 429. */
  blockedUntil: {} as Record<string, number>,
  relay: undefined as RelayHandle | undefined,
  /** In-flight relay startup, so concurrent callers share one child. */
  relayStarting: undefined as Promise<boolean> | undefined,
  relayUnavailable: false,
  /** True once the session ended: refuse to leave a relay behind. */
  shuttingDown: false,
  /** Captured once, never replaced: pi-free's composed streamSimple. */
  originalStreamSimple: undefined as any,
  /** The single wrapper instance we register. Reused, never recreated. */
  wrappedStreamSimple: undefined as any,
  installed: false,
  /** Identity of the composed provider's streamSimple right after our install. */
  composedAfterInstall: undefined as any,
  lastCallAt: 0,
  lastAgentStartAt: 0,
  last429At: 0,
  /** Freshest context, so detectors without a ctx can still reach the UI. */
  ctx: undefined as any,
};

function stopRelay(): void {
  const relay = state.relay;
  state.relay = undefined;
  state.shuttingDown = true;
  if (!relay) return;
  try {
    // Closing stdin is the relay's own lifetime fence (it exits on EOF).
    relay.child.stdin?.end();
  } catch {
    /* ignore */
  }
  try {
    relay.child.kill();
  } catch {
    /* ignore */
  }
}

/**
 * Reads the relay's stdout for the whole life of the child: `PORT=` once at
 * startup, `STATUS=<code>` once per client request (the status of the hop that
 * was finally answered from), and `ROUTE429=<route>` for every route the
 * relay had to skip. The pipe is drained continuously so the relay can never
 * block on a full stdout buffer.
 */
function readRelayOutput(
  child: ChildProcess,
  onStatus: (code: number) => void,
  onRouteBlocked: (route: string) => void,
): Promise<number | undefined> {
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = (port: number | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(port);
    };
    const timer = setTimeout(() => finish(undefined), 3000);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      buffer += chunk.toString();
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.startsWith("PORT=")) {
          const port = Number(line.slice(5));
          if (Number.isFinite(port)) finish(port);
        } else if (line.startsWith("STATUS=")) {
          const code = Number(line.slice(7));
          if (Number.isFinite(code)) onStatus(code);
        } else if (line.startsWith("ROUTE429=") || line.startsWith("PROXY429=")) {
          const route = line.slice(line.indexOf("=") + 1).trim();
          if (route) onRouteBlocked(route);
        } else if (line.startsWith("PARKED=") || line.startsWith("PARKERR=")) {
          debug("relay:", line);
        }
        index = buffer.indexOf("\n");
      }
    });
    child.on("error", () => finish(undefined));
    child.on("exit", () => finish(undefined));
  });
}

async function startRelay(): Promise<boolean> {
  if (state.relay) return true;
  if (state.relayUnavailable) return false;
  // Two concurrent callers (e.g. a 429 activation racing a request) must not
  // spawn two children: the second handle would orphan the first.
  if (state.relayStarting) return state.relayStarting;
  state.relayStarting = startRelayInner();
  const ok = await state.relayStarting;
  state.relayStarting = undefined;
  return ok;
}

async function startRelayInner(): Promise<boolean> {
  const cfg = state.config;
  let child: ChildProcess;
  try {
    child = spawn(cfg.bunPath, ["-e", RELAY_SCRIPT], {
      env: {
        ...process.env,
        OC_PROXY_CONFIG: CONFIG_PATH(),
        OC_PROXY_RELAY_UPSTREAM: cfg.relayUpstream,
        OC_PROXY_RELAY_COOLDOWN_MS: String(cfg.proxyCooldownMs),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    // The relay must never hold the pi process open. stdin stays referenced as
    // the lifetime fence: when pi dies the pipe closes and the child exits.
    child.unref();
    child.stdout?.unref();
    child.stderr?.unref();
  } catch {
    state.relayUnavailable = true;
    return false;
  }
  child.stderr?.on("data", () => {
    /* relay stderr is diagnostic only; never surface it as an error */
  });
  const port = await readRelayOutput(
    child,
    (code) => {
      if (code === 429) onRateLimited("relay");
    },
    (route) => markRouteBlocked(route),
  );
  if (!port) {
    state.relayUnavailable = true;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    return false;
  }
  const handle: RelayHandle = { child, baseUrl: "http://127.0.0.1:" + port + "/inference" };
  state.relay = handle;
  child.on("exit", () => {
    if (state.relay === handle) state.relay = undefined;
  });
  if (state.shuttingDown) {
    // The session ended while this relay was starting: do not leave an orphan.
    stopRelay();
    return false;
  }
  return true;
}

// ── Provider wrapper ────────────────────────────────────────────────────────

function currentProxy(): string | null {
  const list = proxyList(state.config);
  if (list.length === 0) return null;
  return list[Math.min(state.proxyIndex, list.length - 1)] ?? null;
}

/**
 * Observe the stream's terminal result without consuming the stream.
 * `result()` returns the stream's final-result promise; calling it here does
 * not dequeue any event, and the agent's own consumer is unaffected.
 */
function observeOutcome(stream: any): void {
  if (!stream || typeof stream.result !== "function") return;
  let settled = false;
  try {
    const promise = stream.result();
    if (!promise || typeof promise.then !== "function") return;
    promise.then(
      (final: any) => {
        if (settled) return;
        settled = true;
        if (!final || final.stopReason !== "error") return;
        const message = final.errorMessage ?? final.error?.errorMessage;
        debug("stream error observed:", JSON.stringify(message)?.slice(0, 160), "rateLimited=", isRateLimited(message));
        if (!isRateLimited(message)) return;
        onRateLimited("stream");
      },
      () => {
        settled = true;
      },
    );
  } catch {
    /* never break the request */
  }
}

function makeWrapper(original: any, getConfig: () => OcProxyConfig): any {
  const wrapped = (model: any, context: any, options: any) => {
    state.lastCallAt = Date.now();
    const cfg = getConfig();
    debug("wrapper call model=", model?.id, "provider=", model?.provider, "enabled=", state.enabled);
    if (!model || model.provider !== cfg.provider) return original(model, context, options);

    let nextOptions = options;
    if (cfg.maxRetries !== undefined) {
      nextOptions = { ...(options ?? {}), maxRetries: cfg.maxRetries };
    }

    const viaRelay = state.enabled && state.relay;
    if (!viaRelay && state.enabled && !state.relay && !state.relayUnavailable) {
      // Self-heal: the relay can die (bun killed, crash). The wrapper is
      // synchronous, so restart in the background; this request goes direct.
      void startRelay().then((ok) => {
        if (ok) writeRelayState();
      });
    }

    // pi-free's getOpenCodeModelBaseUrl() turns this into "/inference/v1";
    // its relay URL rewrite declines non-opencode.ai hosts, so ours wins.
    const stream = original(
      viaRelay ? { ...model, baseUrl: state.relay!.baseUrl } : model,
      context,
      nextOptions,
    );
    observeOutcome(stream);
    return stream;
  };
  (wrapped as any).__ocproxy = true;
  return wrapped;
}

/**
 * Install (or re-install) the wrapper.
 *
 * The wrapper always wraps the SAME captured original, so repeated
 * installations never nest. pi-free re-registers its provider on catalog
 * refresh and on `/toggle-*`, which replaces the extension's `streamSimple`
 * and silently removes the wrapper; `ensureInstalled` detects that from the
 * fact that the last turn never went through the wrapper and puts it back.
 */
function ensureInstalled(pi: ExtensionAPI, ctx: any, force: boolean): void {
  const cfg = state.config;
  const provider = ctx?.modelRegistry?.getProvider?.(cfg.provider);
  if (!provider || typeof provider.streamSimple !== "function") return;

  if (!state.originalStreamSimple) {
    // First install: this is the composed streamSimple that routes into
    // pi-free's own implementation.
    state.originalStreamSimple = provider.streamSimple;
    state.wrappedStreamSimple = makeWrapper(state.originalStreamSimple, () => state.config);
  }

  // pi-free re-registers its provider (catalog refresh, /toggle-*) and that
  // registration replaces the extension's `streamSimple`, silently dropping
  // this wrapper. Every re-registration also produces a NEW composed provider,
  // so the composed streamSimple's identity is an exact "is my wrapper still
  // in place?" probe. Compare against the identity seen right after install.
  const current = provider.streamSimple;
  if (state.installed && current === state.composedAfterInstall && !force) return;

  const api = provider.getModels?.()?.[0]?.api ?? "opencode-dynamic";
  debug("provider model apis:", JSON.stringify((provider.getModels?.() ?? []).map((m: any) => m.api)));
  try {
    // Only `api` and `streamSimple` are supplied: model-runtime merges this
    // over pi-free's registration, so its models, baseUrl and apiKey survive.
    pi.registerProvider(cfg.provider, { api, streamSimple: state.wrappedStreamSimple });
    state.installed = true;
    state.composedAfterInstall = ctx?.modelRegistry?.getProvider?.(cfg.provider)?.streamSimple;
    debug("registered wrapper for", cfg.provider, "api=", api);
  } catch (error) {
    debug("registerProvider failed:", error instanceof Error ? error.message : String(error));
    state.installed = false;
  }
}

// ── Activation ──────────────────────────────────────────────────────────────

function shortProxy(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Status-bar text: the first route not currently parked. */
function statusLabel(): string | undefined {
  if (!state.enabled) return undefined;
  const now = Date.now();
  const live = emittedRoutes().filter((route) => !(state.blockedUntil[route] > now));
  const route = live[0] ?? emittedRoutes()[0] ?? DIRECT_ROUTE;
  return route === DIRECT_ROUTE ? undefined : "proxy " + shortProxy(route);
}

/** Human label for a route key. */
function routeLabel(route: string): string {
  return route === DIRECT_ROUTE ? "direct" : shortProxy(route);
}

/**
 * The relay reported that a route's egress answered 429. Park that route for
 * the cooldown so later requests skip straight to the next hop instead of
 * paying for a doomed attempt. `direct` can be parked too, which is what
 * makes the switch stick until the local IP's window resets.
 */
function markRouteBlocked(route: string): void {
  const until = Date.now() + state.config.proxyCooldownMs;
  if ((state.blockedUntil[route] ?? 0) >= until) return;
  state.blockedUntil[route] = until;
  const minutes = Math.max(1, Math.round(state.config.proxyCooldownMs / 60_000));
  debug("route blocked", route, "for", minutes, "min");
  try {
    state.ctx?.ui?.notify(
      "oc-proxy: " + routeLabel(route) + " answered 429 — switching to the next route (retry in " + minutes + "m)",
      "warning",
    );
  } catch {}
  if (!state.enabled) return;
  writeRelayState();
  try { state.ctx?.ui?.setStatus?.("oc-proxy", statusLabel()); } catch {}
}

async function activate(ctx: any, reason: string): Promise<boolean> {
  const proxies = proxyList(state.config);
  if (proxies.length === 0) {
    try { ctx?.ui?.notify("oc-proxy: no proxy configured. Run /oc-proxy set <url>", "error"); } catch {}
    return false;
  }
  const ok = await startRelay();
  if (!ok) {
    try { ctx?.ui?.notify("oc-proxy: could not start the bun relay (is bun on PATH?)", "error"); } catch {}
    return false;
  }
  state.enabled = true;
  writeRelayState();
  const routes = emittedRoutes();
  debug("activated routes", routes.join(" -> "), "reason", reason);
  try { ctx?.ui?.setStatus?.("oc-proxy", statusLabel()); } catch {}
  const now = Date.now();
  const cooling = routes.filter((route) => state.blockedUntil[route] > now);
  try {
    ctx?.ui?.notify(
      "oc-proxy: opencode-free egress " + routes.map(routeLabel).join(" -> ") + " (" + reason + ")" +
        (cooling.length > 0 ? " [cooling: " + cooling.map(routeLabel).join(", ") + "]" : ""),
      "info",
    );
  } catch {}
  return true;
}

function deactivate(ctx: any): void {
  state.enabled = false;
  writeRelayState();
  ctx?.ui?.setStatus?.("oc-proxy", undefined);
}

/**
 * A 429 surfaced to the client. When the relay is not carrying the request
 * yet, this is the signal to start it. Once it is, the relay has already
 * walked every route (direct included) inside that same request, so there is
 * nothing left to switch to and we must NOT retry — retrying here is exactly
 * what would turn a dead proxy list into a rotation loop.
 */
function onRateLimited(source: string): void {
  state.last429At = Date.now();
  debug("rate limited via", source, "enabled=", state.enabled);
  if (!state.enabled) {
    if (state.config.autoEnableOn429) void activate(state.ctx, source);
    return;
  }
  // The relay already parked whichever routes answered 429 (it writes the
  // state file itself, so this does not race the process exiting) and walked
  // the rest. Re-read so the status bar and the next request agree with it.
  state.blockedUntil = { ...state.blockedUntil, ...readBlockedUntil() };
  debug("all routes rate-limited", JSON.stringify(state.blockedUntil));
  try { state.ctx?.ui?.setStatus?.("oc-proxy", statusLabel()); } catch {}
}

let piRef: ExtensionAPI;

// ── Extension ───────────────────────────────────────────────────────────────

export default function ocproxy(pi: ExtensionAPI): void {
  piRef = pi;
  state.config = loadConfig();

  // Boot the relay at load time, not at the first turn. `streamSimple` is
  // synchronous, so if the relay is still starting when the first request is
  // built, that request has to go direct — and a 429 then kills the turn
  // before the proxy is ever reachable. Extension load happens well before
  // any prompt, which removes that race.
  if (proxyList(state.config).length > 0) {
    state.blockedUntil = readBlockedUntil();
    state.proxyFirst = state.config.preferDirect === false;
    state.enabled = true;
    writeRelayState();
    void startRelay().then((ok) => {
      debug("relay ready at load:", ok);
    });
  }

  pi.on("session_start", (_event, ctx: any) => {
    debug("session_start", _event?.reason);
    state.ctx = ctx;
    state.shuttingDown = false;
    state.config = loadConfig();
    state.relayUnavailable = false;
    state.installed = false;
    state.lastCallAt = 0;
    // Rehydrate persisted cooldowns so a new session does not immediately
    // retry a route that answered 429 minutes ago.
    state.blockedUntil = readBlockedUntil();
    state.lastAgentStartAt = 0;
    // Config decides the default route order; `/oc-proxy on` overrides it.
    state.proxyFirst = state.config.preferDirect === false;
    // Start the relay up front whenever a proxy is configured. The routes are
    // ordered direct-first by default, so this changes nothing while the local
    // IP has quota — but the moment it answers 429 the relay falls through to
    // a proxy *inside that same request*, so the turn never dies and the user
    // never has to type "Continue".
    if (proxyList(state.config).length > 0) {
      state.enabled = true;
      void startRelay().then((ok) => {
        if (!ok) return;
        writeRelayState();
        try { ctx?.ui?.setStatus?.("oc-proxy", statusLabel()); } catch {}
      });
      try { ctx?.ui?.setStatus?.("oc-proxy", statusLabel()); } catch {}
    }
    ensureInstalled(pi, ctx, true);
  });

  pi.on("agent_start", (_event, ctx: any) => {
    state.ctx = ctx;
    debug("agent_start provider=", ctx?.model?.provider, "model=", ctx?.model?.id, "api=", ctx?.model?.api, "installed=", state.installed);
    if (ctx?.model?.provider !== state.config.provider) return;
    ensureInstalled(pi, ctx, false);
    state.lastAgentStartAt = Date.now();
  });

  // pi-free can re-register its provider between turns (catalog refresh,
  // /toggle-*). Re-check before every turn so the wrapper is never missing
  // when a request goes out.
  pi.on("turn_start", (_event, ctx: any) => {
    state.ctx = ctx;
    if (ctx?.model?.provider !== state.config.provider) return;
    ensureInstalled(pi, ctx, false);
  });

  pi.on("session_shutdown", () => {
    stopRelay();
    state.installed = false;
  });

  const subcommands: Array<{ name: string; description: string }> = [
    { name: "status", description: "Show state, proxy chain, cooldowns and relay" },
    { name: "on", description: "Route opencode-free through the proxy chain now" },
    { name: "off", description: "Stop proxying and go direct" },
    { name: "set", description: "Set the proxy URL: /oc-proxy set http://user:pass@host:port" },
    { name: "next", description: "Rotate the chain to the next configured proxy" },
    { name: "reset", description: "Clear proxy cooldowns so every proxy is retried" },
    { name: "reload", description: "Re-read opencode-429-proxy.json" },
  ];

  pi.registerCommand("oc-proxy", {
    description: "Route opencode-free egress through a proxy chain (on 429 or manually)",
    getArgumentCompletions: (prefix: string): CompletionItem[] | null => {
      const text = String(prefix ?? "");
      const tokens = text.split(/\s+/u);
      // Still typing the subcommand: offer every one that matches.
      if (tokens.length <= 1) {
        const typed = tokens[0] ?? "";
        const items = subcommands
          .filter((entry) => entry.name.startsWith(typed))
          .map((entry) => ({ value: entry.name, label: entry.name, description: entry.description }));
        return items.length > 0 ? items : null;
      }
      const sub = tokens[0].toLowerCase();
      if (sub === "set") {
        // Offer the configured URL so re-selecting it is one keystroke.
        const typed = tokens.slice(1).join(" ");
        const items = proxyList(state.config)
          .filter((proxy) => proxy.startsWith(typed))
          .map((proxy) => ({ value: "set " + proxy, label: proxy, description: "configured proxy" }));
        return items.length > 0 ? items : null;
      }
      return null;
    },
    handler: async (args: string, ctx: any) => {
      const parts = String(args ?? "").trim().split(/\s+/u).filter(Boolean);
      const sub = (parts[0] ?? "status").toLowerCase();

      if (sub === "on") {
        // Explicit request: prefer the proxy, forget cooldowns, retry everything.
        state.proxyFirst = true;
        state.blockedUntil = {};
        await activate(ctx, "manual");
        return;
      }
      if (sub === "off") {
        deactivate(ctx);
        ctx.ui?.notify("oc-proxy: disabled, opencode-free goes direct again", "info");
        return;
      }
      if (sub === "set") {
        const url = parts[1];
        if (!url) {
          ctx.ui?.notify("usage: /oc-proxy set http://user:pass@host:port", "warning");
          return;
        }
        state.config.proxy = url;
        state.config.proxies = [];
        state.proxyIndex = 0;
        saveConfig(state.config);
        if (state.enabled) {
          writeRelayState();
          ctx.ui?.setStatus?.("oc-proxy", statusLabel());
        }
        ctx.ui?.notify("oc-proxy: proxy set to " + url, "info");
        return;
      }
      if (sub === "next") {
        const list = proxyList(state.config);
        if (list.length < 2) {
          ctx.ui?.notify("oc-proxy: only one proxy configured", "warning");
          return;
        }
        state.proxyIndex = (state.proxyIndex + 1) % list.length;
        if (state.enabled) {
          writeRelayState();
          ctx.ui?.setStatus?.("oc-proxy", statusLabel());
        }
        ctx.ui?.notify("oc-proxy: chain now starts at " + shortProxy(currentProxy() ?? ""), "info");
        ctx.ui?.notify("oc-proxy: routes " + emittedRoutes().map(routeLabel).join(" -> "), "info");
        return;
      }
      if (sub === "reset") {
        const count = Object.keys(state.blockedUntil).length;
        state.blockedUntil = {};
        if (state.enabled) {
          writeRelayState();
          ctx.ui?.setStatus?.("oc-proxy", statusLabel());
        }
        ctx.ui?.notify("oc-proxy: cleared " + count + " proxy cooldown(s)", "info");
        return;
      }
      if (sub === "reload") {
        state.config = loadConfig();
        if (state.enabled) {
          writeRelayState();
          ctx.ui?.setStatus?.("oc-proxy", statusLabel());
        }
        ctx.ui?.notify("oc-proxy: config reloaded", "info");
        return;
      }

      const list = proxyList(state.config);
      const now = Date.now();
      const routes = emittedRoutes();
      const cooling = Object.entries(state.blockedUntil)
        .filter(([, until]) => until > now)
        .map(([route, until]) => routeLabel(route) + " " + Math.ceil((until - now) / 60_000) + "m");
      const lines = [
        "provider:    " + state.config.provider,
        "state:       " + (state.enabled ? "ON" : "off"),
        "routes:      " + routes.map(routeLabel).join(" -> "),
        "order:       " + (state.proxyFirst ? "proxy first" : "direct first"),
        "using:       " + (state.enabled ? statusLabel() : "direct (off)"),
        "cooldown:    " + (cooling.length > 0 ? cooling.join(", ") : "none"),
        "configured:  " + (list.length > 1 ? list.length + " entries, index " + state.proxyIndex : "single"),
        "auto start:  " + (state.config.autoEnableOn429 ? "yes" : "no"),
        "walk 429:    " + (state.config.rotateOn429 ? "yes" : "no (first proxy, then direct)"),
        "relay:       " + (state.relay ? state.relay.baseUrl : state.relayUnavailable ? "unavailable" : "not started"),
        "last 429:    " + (state.last429At ? new Date(state.last429At).toLocaleTimeString() : "-"),
        "config:      " + CONFIG_PATH(),
        "debug log:   " + (logTarget ?? "off"),
      ];
      ctx.ui?.notify(lines.join("\n"), "info");
    },
  });
}