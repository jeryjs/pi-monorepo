# Pi Startup Optimizations (background + benchmarks)

**Location:** `~/.pi/agent/patches/docs/`

Background, measurements and history for the three startup fixes discovered while investigating Pi's slow startup (the "mounting agent & tools… 92%" delay in pi-web-ui and the pi CLI).

**The fixes are no longer standalone scripts.** They are patches in the runner at `~/.pi/agent/patches` and apply automatically when `pi` starts:

| Fix | Patch | Module |
|-----|-------|--------|
| 1. Core refresh coalescing | `refresh-coalesce` | `all-patches/refresh-coalesce/index.js` |
| 2. Hermes config (lazy init) | `hermes-config` | `all-patches/hermes-config/index.js` |
| 3. Hermes precompiled bundle | `hermes-bundle` (task hook) | `all-patches/hermes-bundle/index.js` |

See `../README.md` for the runner itself. Everything below is kept because it explains *why* the patches look the way they do.

---

## TL;DR — What You Need to Do

```bash
# Nothing. The launcher hook re-applies all three fixes on every `pi` start.

# After: pi update, pi install <pkg>, pi remove <pkg>  (verify, don't fix)
node ~/.pi/agent/patches/mainrunner.js run
node ~/.pi/agent/patches/mainrunner.js verify
```

The runner is idempotent and cheap when clean (~250ms, no writes); a stale hermes bundle adds the one esbuild rebuild.

---

## The Three Fixes (What Actually Happens)

### 1. Core Refresh Coalescing — `pi-free` / `pi-hermes-memory` / any provider-heavy extension

**File patched:** `ModelRuntime.refresh()` in **every** installed copy of `@earendil-works/pi-coding-agent`:

| Target | Where it's used |
|--------|-----------------|
| `dist/core/model-runtime.js` | pi-web-ui (unbundled) |
| `dist/bundle/chunks/*.js` | pi CLI (bundled) |

**Root cause:** Every `registerProvider()` / `registerNativeProvider()` / `registerVirtualModel()` fires `void this.refresh({allowNetwork:false})`. Each refresh:

1. Reloads `models.json` from disk (`ModelConfig.load()`)
2. Recomposes **every** provider (all 72 of them)
3. Rebuilds the entire model snapshot

`pi-free` registers 25 providers → 25+ full catalog rebuilds. On the unbundled pi-web-ui path this was ~1.5s; on the bundled CLI path ~1.1s.

**The fix:** Concurrent whole-catalog refreshes with identical semantics share one in-flight promise. Scoped refreshes (`options.providers`), signal-bound refreshes, and refreshes whose effective `allowNetwork` differs are never coalesced. The shared promise is keyed on `allowNetwork = options.allowNetwork ?? this.modelNetworkEnabled`.

**Patched method (unbundled):**

```javascript
async refresh(options = {}) {
    // PATCH(pi-refresh-coalesce-v2): coalesce concurrent whole-catalog refreshes.
    // Registering N providers fires N `void this.refresh(...)` calls; without coalescing
    // each one rebuilds every provider and the whole model snapshot.
    // Only refreshes with identical semantics share a promise, so network /
    // availability / scoped-refresh behaviour is unchanged.
    if (options.providers || options.signal)
        return this.refreshCatalog(options);
    const allowNetwork = options.allowNetwork ?? this.modelNetworkEnabled;
    if (this.refreshInFlight && this.refreshInFlight.allowNetwork === allowNetwork)
        return this.refreshInFlight.promise;
    const promise = this.refreshCatalog(options).finally(() => {
        if (this.refreshInFlight?.promise === promise)
            this.refreshInFlight = null;
    });
    this.refreshInFlight = { allowNetwork, promise };
    return promise;
}
async refreshCatalog(options = {}) {
    this.config = await ModelConfig.load(this.modelsPath);
    // ...
}
```

**Patched field:**

```javascript
    /** PATCH(pi-refresh-coalesce-v2): in-flight whole-catalog refresh + its effective allowNetwork. */
    refreshInFlight = null;
```

**Verified behavior identity:** With the patch ON vs OFF, ModelRuntime returns **exactly the same** data:
- 72 providers, 30 registered, 1804 total models, 639 available — byte-for-byte identical.

---

### 2. Hermes Config — Lazy Initialization + No Quick-Check

**File:** `~/.pi/agent/hermes-memory-config.json`

```json
{
  "lazyInitialization": true,
  "quickCheckOnOpen": false,
  ...
}
```

**Why it's safe:** Hermes only honours `lazyInitialization` when `memoryMode === "policy-only"` (the default). In that mode:
- The injected system prompt is **static policy text** (data is fetched by tools that already await initialization on first use).
- The SQLite open, the `PRAGMA quick_check` scan over `sessions.db` (~50 MB, ~200–400ms), and the Windows `powershell.exe` lock probe (~294ms on first run) all move off the startup critical path.

**Cost saved:** ~1.2–1.5s wall-clock on a warm start.

---

### 3. Hermes Precompiled Bundle — Kill jiti/Babel at Startup

**Source:** `pi-hermes-memory/src/index.ts` (56 TypeScript files, ~800 KB)  
**Output:** `pi-hermes-memory/dist/index.js` (one 498 KB CommonJS bundle)

**Build tool:** the `hermes-bundle` patch (`all-patches/hermes-bundle/index.js`), esbuild with `bundle: true, platform: node, format: cjs, target: node22`

**Externalized (NOT bundled — resolved via Pi's jiti aliases at runtime):**
- `better-sqlite3`, `bun:sqlite`, `strip-ansi`
- `typebox`, `typebox/compile`, `typebox/value`, `@sinclair/typebox/*`
- `@earendil-works/pi-ai`, `@earendil-works/pi-ai/compat`, `@earendil-works/pi-ai/models`, `@earendil-works/pi-ai/oauth`, `@earendil-works/pi-ai/providers/all`
- `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`

**Shimmed (local implementation to avoid broken alias chain):**

Pi aliases `@earendil-works/pi-coding-agent` to its `dist/index.js`. That file imports `@earendil-works/pi-ai/utils/*` subpaths which are **absent** from Pi's alias map, so jiti rewrites them to `<pi-ai>/dist/compat.js/utils/...` and the load fails. Hermes only needs `keyHint`, which is reimplemented locally against pi-tui's `getKeybindings` and `theme`:

```javascript
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
```

**import.meta.url shim:** The CJS bundle provides it via banner:

```javascript
const __import_meta_url = require("node:url").pathToFileURL(__filename).href;
// + esbuild define: { "import.meta.url": "__import_meta_url" }
```

**Path rewrite:** Hermes' `resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts")` → `"./index.js"` so the child-process watchdog resolves correctly next to the bundle.

**Copied:** `src/handlers/child-process-watchdog.mjs` → `dist/child-process-watchdog.mjs` (plain ESM, run by `node` in the child process).

**Pi manifest:** `pi-hermes-memory/package.json` gets:

```json
"pi": { "extensions": ["./dist/index.js"] }
```

This is Pi's supported npm-package extension manifest. If `dist/` is ever wiped, the entry resolves to nothing and Pi falls back to auto-discovering `src/index.ts` — the extension still works, just slower.

**Cost saved:** Hermes import + factory went from **~1062ms → ~29ms** (module) + **~3ms** (factory). Total extension-load time: ~1.5s → ~0.2s.

---

## What Each Patch Does

### 1. `refresh-coalesce` — core refresh coalescing

Scans every `@earendil-works/pi-coding-agent` copy that is actually installed (managed releases, `~/.pi/agent/npm`, bundled `pi-web-ui` copies, global npm prefixes) and patches both:

- `dist/core/model-runtime.js` — readable class source (method + new `refreshInFlight` field)
- `dist/bundle/chunks/*.js` — the minified bundle of the same class (hash-named, discovered by anchor)

Marker `PATCH(pi-refresh-coalesce-v2)` makes it idempotent; `revert` is a transform, so unapplying never clobbers an unrelated upstream change.

### 2. `hermes-config` — lazy hermes startup

Writes `lazyInitialization: true`, `quickCheckOnOpen: false` to `~/.pi/agent/hermes-memory-config.json`. Only the two keys change; untouched files stay byte-identical. Revert restores the runner's pre-patch backup.

### 3. `hermes-bundle` — precompiled hermes

Bundles hermes's 56 TypeScript files into `dist/index.js` **only when `src/` is newer than the bundle**, copies the child-process watchdog, and keeps `pi.extensions: ["./dist/index.js"]` in sync (fixed even when the bundle is current). Published atomically (build to a temp file, then rename) so a launch-time rebuild can never leave a half-written bundle for pi to import.

**Where esbuild comes from:** `patches/node_modules/esbuild` (a normal dependency of the runner), then `PI_ESBUILD_FROM`, then any host that happens to have it, then `npm root -g`. No hardcoded machine paths.

**Output example (nothing to do):**

```
  image-resize       clean   0/9    already up to date
  refresh-coalesce   clean   0/6    already up to date
  hermes-config      clean   0/1    already up to date
  hermes-bundle      clean   0/1    already up to date
```

**Output example (bundle rebuilt):**

```
  hermes-bundle      applied   1/1   1 file(s) patched

  hermes-bundle
     applied  task:hermes-bundle
      built dist/index.js (503 KB); wired pi.extensions -> ./dist/index.js
```

---

## Why a runner directory and NOT `tools/`

**CRITICAL:** Pi's `checkDeprecatedExtensionDirs()` treats `~/.pi/agent/tools/` as a **deprecated custom-tools directory**. For ANY file in it (except `fd`, `rg`, `fd.exe`, `rg.exe` which get migrated to `~/.pi/agent/bin/`), Pi prints:

```
Warning: Global tools/ directory contains custom tools. Custom tools have been merged into extensions.
Press any key to continue...
```

This is a **blocking** prompt on every Pi startup.

Pi only scans `extensions/`, `skills/`, `prompts/`, `themes/` under the agent dir. `patches/` is invisible to Pi — safe for helper code.

Same applies project-locally: a `<cwd>/.pi/tools/` or `<cwd>/.pi/hooks/` triggers the identical warning.

---

## Benchmarks (for reference)

### Pi CLI (full settings, 29 extensions)

| State | Wall-clock (median of 5–7) | `createAgentSessionRuntime` |
|-------|---------------------------|----------------------------|
| All OFF (original) | **4929ms** | 3433ms |
| + Core patch | **3747ms** | 2368ms |
| + Hermes config | **2834ms** | 2292ms |
| **+ All three (current)** | **1777ms** | **1277ms** |
| **Total improvement** | **−64% (3.2s)** | −63% |

### pi-web-ui "mounting agent & tools" (fresh process, 29 extensions)

| State | Mount step (median of 5) |
|-------|--------------------------|
| All OFF (original) | **3430ms** |
| + Core patch | **2352ms** |
| + Hermes config | **2167ms** |
| **+ All three (current)** | **2153ms** |
| **Total improvement** | **−37% (1.3s)** |

### Hermes isolation (proves the bundle)

| Build | `pi -ne -ns -e <hermes>` wall |
|-------|------------------------------|
| TS source (`src/index.ts`) | 1400ms |
| **Bundle (`dist/index.js`)** | **383ms** |
| **Improvement** | **−73%** |

### Per-extension load (PI_TIMING, current optimized state)

```
  pi-hermes-memory\dist\index.js   module import: 27ms   factory: 2ms
  pi-free\dist\index.js            module import: 134ms  factory: 32ms
  pi-goal-x\extensions\goal.ts     module import: 754ms  factory: 3ms   ← next biggest
  @criogaid\pi-hashline-edit       module import: 150ms  factory: 2ms
  patch-image-resize.js            module import: 2ms    factory: 80ms
  @moguw\pi-interactive-shell      module import: 65ms   factory: 1ms
  TOTAL extensions: ~2.4s
```

---

## What Gets Wiped (Why You Must Re-Run)

| Event | What's Overwritten | Which Fixes Break |
|-------|-------------------|-------------------|
| `pi update` | `~/.pi/agent/install/releases/<new>/.../pi-coding-agent/` | Core refresh patch (both unbundled + bundled) |
| `pi-web-ui` reinstall / upgrade | `Y:/Dev/NodeJS/node_modules/pi-web-ui/.../pi-coding-agent/` | Core refresh patch (unbundled) |
| `pi update npm:pi-hermes-memory` or `pi remove/install` | `~/.pi/agent/npm/node_modules/pi-hermes-memory/` | Hermes bundle + manifest |
| `npm rebuild better-sqlite3` / node upgrade | nothing (config survives) | none |

The hermes config (`~/.pi/agent/hermes-memory-config.json`) is **your file** — never touched by pi.

---

## Verification Checklist (After Re-Apply)

```bash
# 1. No startup warnings
node ~/.pi/pi-bench/check-warnings.mjs
# → "startup warnings: (none) ✅"
# → "mentions custom tools: NO ✅"

# 2. Provider/model identity preserved
node ~/.pi/pi-bench/verify-providers.mjs
# → "IDENTICAL: YES ✅"

# 3. Hermes bundle functionally identical to TS
node ~/.pi/pi-bench/functional-hermes.mjs
# → "FUNCTIONAL PARITY: YES ✅"

# 4. Re-apply is idempotent
node ~/.pi/agent/patches/mainrunner.js run
# → "everything already up to date" (0 files changed)
```

---

## History / Context (The Investigation)

**Goal:** Investigate `pi-durable` compatibility → diagnose slow startup / "92% mounting" delay.

**Key discoveries (in order):**

1. **`PI_TIMING=1` under-reports** — it misses side effects (provider registration, SQLite init). True attribution = isolated runs (`pi -ne -ns -e <ext>`) minus baseline wall-clock.

2. **Cache-invalidation profiling** — `NODE_DISABLE_COMPILE_CACHE=1 JITI_FS_CACHE=0 PI_OFFLINE=1` exposed cold-start bottlenecks.

3. **Primary offenders (original state):**
   - `pi-free`: +1486ms warm. 54 redundant re-reads of `models.json` via uncached `ModelConfig.load()` during 25 provider registrations.
   - `pi-hermes-memory`: +2122ms warm. TS transpile + 50MB SQLite `sessions.db` quick-check + Windows powershell lock probe.
   - `@jeryjs/pi-keyrouter`: +105ms warm (lightweight).

4. **pi-web-ui pathology:** Imports unbundled `dist/index.js` (255 modules) without `enableCompileCache()`, and `clearExtensionCache()` invalidates all extension caches on every project `cwd` switch (~2.5–3.4s per switch).

5. **Settings-panel disables do NOT save load time** — they run after extension imports.

6. **Node refuses TS type-stripping under `node_modules`** — `JITI_TRY_NATIVE=1` cannot speed up an npm-installed TS extension in place. Bundling to plain JS is the reliable route.

**Artifacts:** Full benchmark suite in `~/.pi/pi-bench/` (git-ignored). Key scripts:
- `final-report.mjs` — definitive before/after across all three optimizations
- `final.mjs` — clean headline benchmark
- `webui-final2.mjs` — pi-web-ui mount step, fresh process per sample
- `functional-hermes.mjs` — real tool execution parity check
- `verify-providers.mjs` — ModelRuntime output diff
- `prof.mjs` — CPU profile by file URL

---

## Skills Created (Durable Knowledge)

- `global:optimize-pi-startup` — the complete procedure (this README's source)
- `global:profile-pi-extension-startup` — how to profile pi extension load times with cache-defeating benchmarks

Both live in `~/.pi/agent/pi-hermes-memory/skills/` and are indexed by Pi's skill system.

---

## If Something Breaks

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| `pi` startup throws on hermes load | `dist/` corrupted or missing | `node ~/.pi/agent/patches/mainrunner.js revert hermes-bundle` then `run` |
| Provider count / models mismatch after core patch | Patch applied to only one pi-coding-agent copy (pi-web-ui vs CLI) | `node ~/.pi/agent/patches/mainrunner.js verify` — the patch covers all copies |
| `createAgentSessionRuntime` still ~3s+ | `pi-free` or `pi-hermes-memory` disabled in settings.json | Enable them — the patches make them affordable now |
| "Global tools/ directory..." warning again | You put a file in `~/.pi/agent/tools/` | Move it to `~/.pi/agent/bin/` or `~/.pi/agent/patches/` |
| Runner reports `missingAnchor` for refresh-coalesce | pi-coding-agent changed the `refresh()` signature | Read the stacktrace in `conflicts.html`, update the anchors in `all-patches/refresh-coalesce/index.js` |

---

## One-Liner for Future You

```bash
# Nothing to run — the launcher hook applies everything on `pi` start.
# After a pi update / install / remove, just confirm:
node ~/.pi/agent/patches/mainrunner.js verify

# Sanity check
node ~/.pi/pi-bench/check-warnings.mjs
```

---

*Last updated: 2026-11-03 — measurements from pi-coding-agent 1.4.0 era; commands updated for the patch runner.*