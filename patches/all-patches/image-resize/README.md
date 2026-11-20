# image-resize

Caps the dimensions pi downscales images to, instead of trusting the per-model catalog
limit (usually 2000px). Migrated from `~/.pi/agent/extensions/patch-image-resize.js`.

## What it patches

pi builds its resize options as:

```js
{ ...DEFAULT_OPTIONS, ...options }        // DEFAULT_OPTIONS = { maxWidth: 2000, maxHeight: 2000, … }
```

Because `options` (the per-model catalog limit) is spread last, it wins. The patch injects
an explicit override after the spread so the cap always wins:

```js
{ ...DEFAULT_OPTIONS, ...options, maxWidth: 480, maxHeight: 640 }
```

Applied to every `pi-coding-agent` install it can find, in:

* `dist/utils/image-resize-core.js` (unbundled, required)
* `dist/utils/image-resize-worker.js` (when it contains the anchor)
* any `dist/bundle/chunks/*.js` that contains the anchor (bundled builds)

Both minified (`{...DEFAULT_OPTIONS,...options}`) and spaced source styles are handled.

## Params

| param | env | default | meaning |
| --- | --- | --- | --- |
| `maxWidth` | `PI_IMAGE_RESIZE_WIDTH` | `480` | max image width in px |
| `maxHeight` | `PI_IMAGE_RESIZE_HEIGHT` | `640` | max image height in px |
| `packages` | `PI_IMAGE_RESIZE_PACKAGES` | `[]` | extra package dirs, `;` separated |

Precedence: env var → `patches.json` `params` → module default. Values must be positive
integers (`min: 16`, `max: 20000`); anything invalid falls back to the default with a
warning in `status` / `doctor`.

```bash
PI_IMAGE_RESIZE_WIDTH=320 PI_IMAGE_RESIZE_HEIGHT=320 node ../mainrunner.js run
```

## Discovery

Shared with the other pi patches — see `../_shared/pi-packages.js`. Install *roots* (directories
whose `node_modules` could hold a `pi-coding-agent` copy) are collected first:

1. `PI_IMAGE_RESIZE_PACKAGES` / `PI_PACKAGE_DIR` / `PI_MANAGED_INSTALL_ROOT`
2. `{agentDir}/install/releases/*` (every release, not just `current-version`)
3. `{agentDir}/npm`
4. `{agentDir}/tmp/extensions/*/*` (extensions pi extracted per source)
5. the node prefix: `dirname(process.execPath)` and its `lib/`
6. upward from `process.argv[1]` (only meaningful when pi launched the runner)

Each root then contributes `<root>/node_modules/@earendil-works/pi-coding-agent` **and** any
package nested one level deeper that carries its own copy, e.g.
`Y:/Dev/NodeJS/node_modules/pi-web-ui/node_modules/@earendil-works/pi-coding-agent`.
That nested case matters: a globally installed pi-web-ui runs its *own* pi-coding-agent, so
patching only the top-level copy leaves the web UI slow. Only directories containing a `dist/`
are kept.

## Revert

`revert()` strips only the injected override, restoring the upstream spacing style:

```
{ ...DEFAULT_OPTIONS, ...options, maxWidth: 480, maxHeight: 640 }  ->  { ...DEFAULT_OPTIONS, ...options }
{...DEFAULT_OPTIONS,...options, maxWidth: 480, maxHeight: 640 }    ->  {...DEFAULT_OPTIONS,...options}
```

No backup needed, so `node mainrunner.js revert image-resize --targets` also cleans up
files patched before this runner existed.

## Verify

Re-runs the transform on the file on disk; `unchanged` means the cap is in place. After a
write it also checks that every merge site carries exactly the configured pair.

## Notes

* A missing anchor in `image-resize-core.js` is a **warning-level conflict** (upstream
  changed the code) — update `MERGE` in `index.js`, do not disable the patch blindly.
* Restart pi after applying: the bundled worker keeps the old code in memory.
* `verify` reads every `dist/bundle/chunks/*.js` in every install (~300 files) to check whether
  the anchor moved into another chunk. Chunk names are content hashes, so name-based filtering
  is not possible; the cost is ~135ms, shared with `refresh-coalesce` via a per-process read
  cache.
