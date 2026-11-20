# refresh-coalesce

**Problem.** Registering N providers in pi fires N `void this.refresh(...)` calls. Each one
reloads every provider config and rebuilds the whole model snapshot, so startup cost scales with
the number of providers (pi-free / pi-hermes-memory make this visible at the "mounting agent &
tools" step).

**Fix.** Split `refresh()` from a private `refreshCatalog()`, keep one in-flight promise in
`refreshInFlight`, and let concurrent callers that ask for the same thing share it. Scoped
refreshes (`options.providers`, `options.signal`) bypass the coalescing entirely, and only
refreshes with the same `allowNetwork` share a promise, so behaviour is unchanged — just cheaper.

**Where.** Every `@earendil-works/pi-coding-agent` install found on the machine:

| File | Shape |
|------|-------|
| `dist/core/model-runtime.js` | readable class source (method + `refreshInFlight` field) |
| `dist/bundle/chunks/*.js` | minified bundle of the same class (hash-named, found by anchor) |

Marker: `PATCH(pi-refresh-coalesce-v2)`. `revert()` removes exactly the injected code, so an
unapply never clobbers unrelated upstream changes.

**Params.** `PI_REFRESH_COALESCE_PACKAGES` — extra package dirs (`;` separated).

**If it breaks.** `missingAnchor` means upstream changed the `refresh()` signature. Read the
stacktrace in `conflicts.html`, update `UNB_METHOD_OLD` / `BUNDLE_OLD` in `index.js`, then
`node mainrunner.js run`.
