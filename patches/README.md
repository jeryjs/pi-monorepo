# pi patches

A local patch runner for `pi` (and anything else on disk that needs a surgical edit).
It applies your patches automatically, verifies them, keeps a full history, can revert
every change, and — when a patch stops matching upstream code — builds a rich
`conflicts.html` report you can hand straight to your coding agent.

Runs on Windows and on Linux/macOS on the same node (>= 20). The only platform-specific pieces
are launcher handling (`hook`), browser opening and `daemon autostart`; everything else
(patch discovery, transforms, backups, revert) is identical everywhere, so one folder can be
copied between machines as-is.

```
~/.pi/agent/patches/
├── mainrunner.js            entry point + CLI
├── patches.json             registry: where each patch lives, params, settings
├── state.json               what was applied, when, by whom, with what params, and how to undo
├── conflicts.html           generated report (rewritten every run, see settings.report)
├── README.md                this file
├── trigger.cjs              launcher entry: one background run, no output, no daemon
├── lib/                     engine, state, registry, report, hook, daemon, CLI
│   ├── cli.js
│   ├── daemon.js
│   ├── engine.js
│   ├── hook.js              installs/removes the pi-start hook in pi's launcher
│   ├── registry.js
│   ├── report.js
│   ├── report-template.html
│   ├── state.js
│   └── util.js
├── package.json             type: module + the runner's own deps (esbuild, for hermes-bundle)
├── all-patches/             one folder per patch
│   ├── _shared/
│   │   └── pi-packages.js   discovery: every pi install on this machine + cached chunk reads
│   ├── image-resize/        cap image dimensions
│   ├── refresh-coalesce/    coalesce ModelRuntime.refresh() at startup
│   ├── hermes-config/       lazy hermes memory startup
│   ├── hermes-bundle/       precompile pi-hermes-memory (task patch)
│   └── hook-stream/         expose pi's provider request hooks to extensions
├── docs/                    background + benchmarks (pi-startup-optimizations.md)
├── backups/                 pre-patch copies, per patch (created at runtime)
├── runner.log               daemon + run log (rotated at 1 MB)
└── runner.pid               daemon pid (created at runtime)
```

---

## Quick start

```bash
cd ~/.pi/agent/patches

node mainrunner.js run              # apply everything once
node mainrunner.js status           # what is applied, what failed
node mainrunner.js doctor           # environment / registry / module checks
node mainrunner.js hook install     # autorun: patch on every pi launch (one-time setup)
```

`run` is idempotent: applying an already-applied patch writes nothing and reports `clean`.

---

## Autorun — the pi-start hook

Autorun is a hook inside pi's own launcher, not a resident process. `hook install` writes a small
guarded block into the launcher that every `pi` start goes through, then spawns `trigger.cjs`
detached on each launch; that runs `run --quiet --trigger pi-start` and exits. Nothing stays
running while `pi` is closed.

| platform | launcher that gets the block |
| --- | --- |
| Windows | `~/.pi/agent/bin/pi-launcher.js` — the file behind `pi.cmd`, `pi.ps1` and `pi.exe` |
| Linux / macOS | `~/.pi/agent/bin/pi` — the POSIX shim that execs the managed release |

Either platform also hooks any `pi` / `pi.cmd` / `pi.ps1` shim found on `PATH` or in the npm
prefixes that own a pi package. A launcher that is not there is reported as `missing`, never
faked into "installed".

```bash
node mainrunner.js hook install    # wire it into the launcher
node mainrunner.js hook status     # which launchers carry the hook
node mainrunner.js hook uninstall  # restore the launcher byte for byte
PI_PATCHES_DISABLE=1 pi            # skip the trigger for a single launch
```

| property | behaviour |
| --- | --- |
| coverage | every entry point that goes through the platform launcher (`pi`/`pi.cmd`/`pi.ps1`/`pi.exe`); npm-global shims are hooked too when such an install exists |
| history | the run is recorded with `trigger: "pi-start"`, so `history` separates launcher runs from manual ones |
| self-healing | `run` re-installs the hook if a `pi` update ever overwrites the launcher |
| reversible | the pristine launcher is copied to `backups/hook/<name>.<path-hash>.orig` on install; `uninstall` restores it byte for byte |
| cost | one short-lived node process per launch (~0.1–0.7 s of background CPU, before the TUI is up) |
| timing | launch only — a running `pi` keeps the code it already loaded, hence the `restart pi` hint |

The hook is synchronous on purpose: the launcher blocks in `spawnSync` for the whole session, so
a dynamic `import()` there would never resolve while `pi` runs. On POSIX the block uses the node
binary that installed the hook (`PI_PATCHES_NODE` overrides it), because the shim puts pi's own
node on `PATH` only *after* the block runs.

### Optional: the watcher daemon

If you also want patches re-applied *while* pi keeps running (you just edited a patch module, or a
`pi` upgrade landed mid-session), start the watcher:

| trigger | what it catches |
| --- | --- |
| `daemon-start` | anything missed while the daemon was down |
| `watch:<file>` | a `pi` upgrade rewriting `dist/`, a patch module you just edited, a file restored from a backup |
| `interval` | default every 5 min (`settings.watch.intervalMs`) — belt and braces for missed fs events |

Watch roots come from three places:

1. `settings.watch.paths` in `patches.json` (supports `~`, `{agentDir}`, `{patchesDir}`, `{home}`)
2. the patch sources themselves (`settings.watch.watchPatchSources`)
3. each patch module's optional `watch(ctx)` hook — the pi installs / package folders that patch cares about

Runs are serialised with `patches/.lock`, so a manual CLI run and the daemon never write the same
file at once. If a run is already in progress, the other side waits (daemon) or tells you (`cli`,
override with `--force`).

```bash
node mainrunner.js daemon start|stop|restart|status|logs [--lines 80]
node mainrunner.js daemon autostart on|off|status
```

Autostart writes `%APPDATA%\...\Startup\pi-patches.vbs` (hidden launcher). `off` deletes it.
Windows only: on Linux/macOS `autostart` reports `unsupported` — use a systemd user unit or a
`@reboot` cron entry that runs `node mainrunner.js daemon start`. Most setups do not need this —
the launcher hook covers normal use.

---

## CLI

```
node mainrunner.js <command> [options]
```

| command | what it does |
| --- | --- |
| `run` | apply every enabled patch (idempotent) |
| `apply [id...]` | apply one or more patches, implies `--force` |
| `revert [id...]` | revert via the module's `revert()` hook, else the pre-patch backup |
| `revert --targets` | revert every file the patch can find, even ones state never recorded |
| `verify [id...]` | is the patch still applied? (`applied` / `drift` / `missing`) |
| `status` | daemon, last run, per-patch table, open conflicts |
| `list` | registered patches and their resolved module paths |
| `enable <id>` / `disable <id>` | flip a patch without touching `patches.json` |
| `history [id]` | timeline of applies, reverts, dry runs, failures |
| `conflicts` | recorded conflicts — `--all` includes resolved, `--resolve <id|patch|all>`, `--reopen <...>`, `--clear` |
| `report [--open]` | rebuild `conflicts.html` from stored conflicts |
| `hook install\|status\|uninstall` | wire the pi-start trigger into pi's launcher, or take it back out |
| `doctor` | node, writability, registry/state parse, hook status, every module + target count, watch roots, env |
| `reset-state` | wipe `state.json` (keeps backups), needs `--yes` |
| `daemon <sub>` | `start stop restart status logs autostart` |
| `help` | full reference |

Options: `--dry-run`, `--force`, `--patch <id>` (repeatable), `--targets`, `--trigger <name>`, `--json`,
`--no-open`, `--no-report`, `--no-hook`, `--no-color`, `--quiet`, `--verbose`.

Exit codes: `0` ok, `1` conflicts/failures, `2` usage error. `--json` prints the whole
run result, which is handy from scripts.

Examples:

```bash
# try a different cap without editing any config
PI_IMAGE_RESIZE_WIDTH=320 PI_IMAGE_RESIZE_HEIGHT=320 node mainrunner.js run --dry-run
PI_IMAGE_RESIZE_WIDTH=320 PI_IMAGE_RESIZE_HEIGHT=320 node mainrunner.js run

node mainrunner.js disable image-resize      # stop auto-applying it
node mainrunner.js revert image-resize       # undo what is applied right now
node mainrunner.js verify --json | jq .ok
```

---

## Patch module API

A patch is an ES module exporting one default object. It can live anywhere; a folder per
patch inside `patches/` is the recommended layout.

Two shapes are supported by the same runner:

* **file patch** — `targets()` + `transform()` (+ optional `revert`/`verify`). Edits files.
* **task patch** — `task(ctx)`. Runs a build/generate/sync step that has no file of its own
  (e.g. bundling an extension's TypeScript). `targets()` may return `[]`.

```js
export default {
  id: "my-patch",              // required, must match the id in patches.json
  name: "Human readable name", // shown in status/report
  description: "why it exists",
  version: "1.0.0",
  tags: ["pi"],

  // Optional. Params are resolved per run: env var > patches.json params > default.
  params: [
    { key: "maxWidth", env: "PI_IMAGE_RESIZE_WIDTH", default: 480, type: "int", min: 16, max: 20000 },
  ],

  // Required. Where does this patch apply? Return paths or { file, content?, required?, label? }.
  // required: true means "a missing file/anchor is a conflict worth reporting".
  targets(ctx) {
    return [{ file: "/abs/path/to/file.js", required: true }];
  },

  // Required. Pure-ish transform: (content) -> { content, summary } | { unchanged, summary }.
  // Return `unchanged: true` when the patch is already applied. Add `missingAnchor: true`
  // when the code you patch is gone (that becomes a warning in the conflict report).
  transform(ctx, file, content) {
    const next = content.replace(/foo/g, "bar");
    if (next === content) return { unchanged: true, summary: "already patched" };
    return { content: next, summary: "foo -> bar" };
  },

  // Optional. Preferred way to undo: content-aware, works without backups.
  revert(ctx, file, content) {
    const next = content.replace(/bar/g, "foo");
    if (next === content) return { unchanged: true, summary: "nothing to revert" };
    return { content: next, summary: "bar -> foo" };
  },

  // Optional. Runs after the write; return { ok: false, message } to raise a conflict.
  verify(ctx, file, content) {
    return { ok: content.includes("bar"), message: "bar present" };
  },

  // Optional. Extra directories the daemon should watch.
  watch(ctx) {
    return [];
  },
};
```

### Task patches (build steps)

```js
export default {
  id: "my-build-step",
  name: "Precompile something",
  taskLabel: "bundle",        // optional, shown instead of "task"
  params: [],

  targets() { return []; },   // a task patch has no file of its own
  async task(ctx) {           // ctx.mode is "apply" | "verify" | "revert"
    const stale = isStale();
    if (ctx.mode === "verify") return { changed: stale, summary: stale ? "bundle stale" : "up to date" };
    if (ctx.mode === "revert") return { changed: undo(), summary: "removed" };
    if (!stale) return { changed: false, summary: "up to date" };
    await build();
    return { changed: true, summary: "built dist/index.js (503 KB)" };
  },
};
```

`task()` runs inside the same pass, state and history as file patches: `changed: true` counts as
an applied change (and triggers the usual "restart pi" hint), a throw becomes a conflict with the
full stacktrace in `conflicts.html`, `mode: "verify"` must be cheap and must not write, and
`mode: "revert"` must put the world back. Keep long work behind a staleness check — the task runs
on every `pi` start.

`ctx` contains: `params`, `sources` (where each param came from), `patch` (the registry
entry), `mod`, `state`, `registry`, `settings`, `agentDir`, `patchesDir`, `paths`,
`dryRun`, `mode` (revert only), `logger`.

Rules the engine relies on:

* **Idempotent** — running twice must not change anything the second time.
* **Anchor-based** — match on structure (`{ ...DEFAULT_OPTIONS, ...options }`), never on
  line numbers or the whole file.
* **Reversible** — implement `revert()`; the backup is a fallback, not a plan.
* **No side effects in `targets()`** — it is called by `verify`, `doctor` and the daemon.
* **Discovery, not hardcoding** — scan for installs (see `all-patches/_shared/pi-packages.js`),
  never pin a version folder or a hash-named chunk.

---

## `patches.json`

```jsonc
{
  "schemaVersion": 1,
  "settings": {
    "autoRun": true,
    "watch":   { "enabled": true, "intervalMs": 300000, "debounceMs": 1500, "paths": [], "watchPatchSources": true },
    "report":  { "path": "conflicts.html", "openOnConflict": true, "minOpenIntervalMs": 60000 },
    "backups": { "dir": "backups", "keepPerPatch": 200 },
    "history": { "keepPerPatch": 200, "keepRuns": 100, "keepConflicts": 50 },
    "logging": { "level": "info", "file": "runner.log", "maxBytes": 1048576 },
    "daemon":  { "autostart": false }
  },
  "patches": [
    {
      "id": "image-resize",
      "name": "Cap image resize dimensions",
      "module": "./image-resize/index.js",   // absolute, ~-prefixed, or relative to this folder
      "enabled": true,
      "priority": 100,                        // lower runs first
      "params": {},                           // per-patch overrides (env still wins)
      "tags": ["pi", "images"]
    }
  ]
}
```

* `module` may also be a directory — the resolver tries `index.js`, `patch.js`, `main.js`.
* `enabled: false` in the registry and `disable` via CLI both stop auto-apply; the CLI
  flag lives in `state.json` and wins, so a registry edit cannot silently re-enable a
  patch you disabled by hand.
* `report.alwaysWrite` (default `true`) rewrites the pair on every run, not just on conflicts, so
  an open page can simply refresh. `report.refreshSeconds` is the **Live** poll interval, `0` = off.
* `report.minOpenIntervalMs` prevents the daemon from re-opening a browser tab on every
  poll when the same conflict keeps recurring.

---

## `state.json`

The revert book. Written after every run.

```jsonc
{
  "schemaVersion": 1,
  "runner": { "pid": 1234, "startedAt": "…", "lastRunAt": "…", "lastTrigger": "watch:…", "lastDurationMs": 812, "runs": 12 },
  "stats":  { "runs": 12, "applied": 3, "reverted": 1, "failed": 0, "conflicts": 0, "filesChanged": 27 },
  "patches": {
    "image-resize": {
      "enabled": true,
      "status": "applied",              // applied | clean | failed | reverted | disabled | no-targets | drift
      "params": { "maxWidth": 480, "maxHeight": 640 },
      "paramSources": { "maxWidth": "env PI_IMAGE_RESIZE_WIDTH" },
      "counters": { "applied": 3, "reverted": 1, "failures": 0, "runs": 12, "conflicts": 0 },
      "files": [
        {
          "file": "C:/…/dist/utils/image-resize-core.js",
          "status": "applied",
          "hashBefore": "…", "hashAfter": "…",
          "backup": "backups/image-resize/20261103-103202-894_image-resize-core.js.bak",
          "bytesBefore": 5437, "bytesAfter": 5490,
          "diffStat": { "added": 1, "removed": 1 },
          "diffPreview": "@@ line 38 @@\n- …\n+ …",
          "appliedAt": "…", "params": { "…": "…" }
        }
      ],
      "history": [ { "ts": "…", "action": "apply", "status": "applied", "message": "8 file(s) patched" } ]
    }
  },
  "runs":   [ { "id": "run_…", "startedAt": "…", "durationMs": 812, "trigger": "cli", "ok": true, "changed": 8, "conflicts": 0 } ],
  "history":[ /* global timeline, newest first */ ],
  "conflicts": [ /* everything the report was built from */ ]
}
```

Safe to delete — a fresh one is created on the next run (backups survive). Use
`node mainrunner.js reset-state --yes` if you want the old file kept as `state.json.<ts>.bak`.

---

## Conflicts and `conflicts.html`

A conflict is recorded when a patch cannot be applied or verified. Kinds:

| kind | meaning | typical fix |
| --- | --- | --- |
| `module-load` | the module could not be imported | fix the path or the syntax error |
| `discovery` | `targets()` threw / a required file is missing | update `targets()` — upstream moved |
| `transform` | the rewrite threw | update `transform()` / the anchor |
| `anchor-missing` | the code you patch is gone (warning) | re-anchor or disable the patch |
| `verify` | written, but the post-write check failed | check permissions, make the transform idempotent |
| `write` | the file could not be written | file locked by a running pi, or read-only install |
| `revert` | no `revert()` hook and no usable backup | add a `revert()` hook |

On the first conflict of a run the engine writes `conflicts.html` and opens it with
`start "" "./conflicts.html"` on Windows, `xdg-open ./conflicts.html` (or `open …` on macOS)
elsewhere, from this folder (rate-limited by `report.minOpenIntervalMs`).

The page is written as a pair: `conflicts.html` (self-contained: template + a copy of the data,
opens from disk, mails fine) and `conflicts.data.js` (the same JSON, re-readable). A run rewrites
both — even when it produced no conflicts — so the file on disk is never a stale snapshot.

### Refreshing an open page

`conflicts.html` can re-read `conflicts.data.js` without a server:

* **↻ Refresh** (or `r`) re-loads the data file through a `<script>` tag (the only local read
  `file://` allows), repaints every tab, and keeps your filters, expanded cards and scroll position.
  It falls back to a full page reload if the data file is missing.
* **◉ Live** (or `l`) polls every `settings.report.refreshSeconds` (default 5 s) while the tab is
  visible — handy when a run is happening or you are iterating on a patch module.
* The button reads **↻ Up to date** when nothing changed, **↻ Refreshed** otherwise.

The report is a single offline HTML file — no network, no dependencies:

* stat cards, tabs for **Conflicts / Patches / Runs / History / Commands / Raw JSON**
* search, severity filter, patch filter, sorting, expand/collapse
* per-conflict: kind, severity, file, module, params, suggested fix, full stacktrace
* per-conflict: **Copy stacktrace**, **Copy full conflict**, **Copy file path**, **Copy module path**,
  **Copy JSON**, **Copy fix command**, **Copy resolve command**
* **Open / All / Resolved** filter (resolved cards are dimmed with a `resolved` badge)
* **Copy all for agent** — a complete brief (host, paths, every conflict with stacktraces,
  current patch state, CLI reference, and instructions to fix the patch module rather than
  pi's `dist`)
* light/dark theme, keyboard shortcuts (`/`, `e`, `C`, `c`, `t`, `1-6`), toasts,
  download as JSON, print stylesheet

Paste that brief into your agent and it has everything needed to update the patch.

### Marking a conflict resolved

A conflict is closed when the patch that caused it runs clean again — no bookkeeping needed. The
run reports `closed N previously reported conflict(s)`, and the record stays in `state.json` with
`resolved: true`, `resolvedAt` and `resolvedBy: "auto"`.

You can also close (or re-open) one by hand, which is what you want when the fix was outside the
runner, or when you simply accept the failure:

```bash
node mainrunner.js conflicts                          # open ones, with their ids
node mainrunner.js conflicts --all                     # open + resolved
node mainrunner.js conflicts --resolve <id|patch-id|all>
node mainrunner.js conflicts --reopen  <id|patch-id|all>
node mainrunner.js conflicts --clear                   # forget everything (irreversible)
```

Resolution is bookkeeping only: it never re-runs or rewrites a patch, so a resolved conflict leaves
`verify` untouched. `status`, `report` and `state.json`'s `openConflicts` all count open ones only.

In `conflicts.html` every card carries **Copy resolve command** / **Copy reopen command** (the page
is a static offline file and cannot write to `state.json`), and the toolbar's
**Open / All / Resolved** filter shows the closed ones dimmed with a `resolved` badge. The
**Resolved** stat card counts them.

---

## Backups and revert semantics

* Before the first write to a file, the original content is saved to
  `backups/<patch-id>/<timestamp>_<basename>.bak` (pruned to `backups.keepPerPatch`).
* Revert prefers the module's `revert()` hook. If there is none, the backup is restored
  **only when the file still matches `hashAfter`** — so a `pi` upgrade is never clobbered
  by a stale backup. That case is reported as a conflict instead.
* `revert --targets` also un-patches files that `state.json` has no record of (state loss,
  or files patched by an older version of the runner).

---

## Adding a patch

```bash
cd ~/.pi/agent/patches
mkdir all-patches/my-patch
$EDITOR all-patches/my-patch/index.js   # export default { id, name, targets, transform, revert }
$EDITOR patches.json                    # add { "id": "my-patch", "module": "./all-patches/my-patch/index.js" }
node mainrunner.js doctor         # module imports? targets found?
node mainrunner.js run --dry-run  # what would change
node mainrunner.js run            # do it
```

After a `pi` upgrade the next launch re-applies everything (the hook also re-installs itself if
the upgrade overwrote the launcher). If an
anchor moved, you get a conflict report with the exact stacktrace and the file that
changed — update the patch module, then `node mainrunner.js run --force`.

---

## Environment

| variable | effect |
| --- | --- |
| `PI_CODING_AGENT_DIR` | overrides `~/.pi/agent` |
| `PI_PACKAGE_DIR` | extra pi package dir for `image-resize` discovery |
| `PI_MANAGED_INSTALL_ROOT` | pi managed install root to scan |
| `PI_IMAGE_RESIZE_WIDTH` / `PI_IMAGE_RESIZE_HEIGHT` | image cap (default `480` / `640`) |
| `PI_IMAGE_RESIZE_PACKAGES` | extra package dirs, `;` separated |
| `NO_COLOR` / `FORCE_COLOR` | CLI colouring |

Any param declared with an `env` name is overridable this way — no config edit needed.

---

## Troubleshooting

| symptom | fix |
| --- | --- |
| `another run is in progress` | a run or the daemon holds `.lock`; wait, or `--force` |
| daemon says stale pid | `node mainrunner.js daemon stop` clears it |
| patches keep re-applying every poll | `transform()` is not idempotent — make it return `unchanged` |
| conflicts every 5 minutes | expected until the patch is updated; `minOpenIntervalMs` stops the tab spam |
| `module not found` in doctor | `module` path in `patches.json` is wrong (relative to this folder) |
| patched file reverted after `pi` upgrade | the next `pi` launch re-applies it; `node mainrunner.js run` does it now |
| want to stop everything | `node mainrunner.js hook uninstall && node mainrunner.js daemon stop && node mainrunner.js daemon autostart off` |

Logs: `runner.log` (rotated to `runner.log.1`), or `node mainrunner.js daemon logs`.
