# oc-proxy (`/oc-proxy`)

Egress proxy for pi-free's **`opencode-free`** provider.

opencode-free rate-limits by egress IP. This extension makes those requests
leave through a proxy you configure, so the upstream sees a different IP.
Nothing else in pi is affected.

The switch is **transparent**: a request that the direct IP answers with `429`
falls through to the configured proxy *inside that same request*, so the turn
completes and you never have to type "Continue".

> [!IMPORTANT]
> **Patch required — this extension is not standalone.**
> It only works with the **`hook-stream`** patch applied
> ([`patches/all-patches/hook-stream`](../../patches/all-patches/hook-stream),
> run by [`patches/`](../../patches)). On a stock pi it does nothing at all.
> See [Requirements](#requirements) before installing.

```
/oc-proxy                     # status (routes, cooldowns, relay)
/oc-proxy set http://user:pass@host:port
/oc-proxy on                  # prefer the proxy from now on
/oc-proxy off                 # back to direct only
/oc-proxy next                # rotate the chain to the next proxy
/oc-proxy reset               # clear cooldowns so every route is retried
/oc-proxy reload              # re-read config
```

Subcommands autocomplete after `/oc-proxy `, and `set ` completes the
proxy URLs already in config.

## Routes, not a single proxy

Egress is an ordered list of **routes**: `direct` (your own IP) plus every
configured proxy. The order is `preferDirect` (default) — `direct` first, then
the proxies — or `/oc-proxy on` to put the proxies first.

The relay walks that list per request:

| Situation | What happens |
| --- | --- |
| direct answers 200 | done; the proxy is never contacted (its quota is kept) |
| direct answers 429 | that route is parked and the next route is tried **in the same request** |
| a route is parked | skipped until its cooldown expires (persisted in the config file) |
| every route 429s | the `429` is returned — one attempt per route, **no retry loop** |
| a route is unreachable | skipped, the walk continues |

Because the walk is bounded by the number of routes, an exhausted proxy list
fails fast instead of rotating forever, and the extension never re-runs a turn
on its own.

The relay is started at extension load, not at the first turn: `streamSimple`
is synchronous, so a relay that is still starting would force that request
direct and a `429` would kill the turn before any proxy could be reached.

`autoEnableOn429` still starts the relay if it was not running (e.g. after
`/oc-proxy off`, or a config change mid-session).

## Config — `~/.pi/agent/extensions/opencode-429-proxy.json`

One JSON file **beside** the extension folder (not inside it), created with
defaults on first load. The relay reads and writes the same file, so there is no
separate state file.

```json
{
  "provider": "opencode-free",
  "proxy": "",
  "proxies": [
    "http://user:pass@REPLACE_WITH_YOUR_PROXY_HOST:3128"
  ],
  "autoEnableOn429": true,
  "rotateOn429": true,
  "preferDirect": true,
  "proxyCooldownMs": 600000,
  "relayUpstream": "https://opencode.ai",
  "bunPath": "bun",
  "debugLog": "opencode-429-proxy.log",
  "relay": {
    "routes": ["direct", "http://user:pass@REPLACE_WITH_YOUR_PROXY_HOST:3128"],
    "blockedUntil": {}
  }
}
```

`relay` is runtime state owned by the relay — the extension rewrites it on every
activation and the relay rewrites it when it parks a route. Leave it alone; a
`/oc-proxy reload` does not disturb it.

| Field | Meaning |
| --- | --- |
| `proxy` | Single proxy URL used on activation. Include credentials as `http://user:pass@host:port`. |
| `proxies` | Optional rotation list; when non-empty it wins over `proxy`. |
| `autoEnableOn429` | Start the relay on the first `429` if it was not already running. |
| `rotateOn429` | Walk the remaining routes on a `429`. `false` = only the first proxy, then `direct`. |
| `preferDirect` | `true` (default) = try your own IP first, proxies only after a `429`. `false` = proxies first. |
| `proxyCooldownMs` | How long a route that answered `429` is skipped before it is retried. Default `600000` (10 min). |
| `maxRetries` | Override pi-ai's internal retry count for this provider. `undefined` = inherit pi's setting. |
| `provider` | Provider id to watch and rewrite. Default `opencode-free`. |
| `relayUpstream` / `bunPath` | Advanced. Upstream root for the relay, and the bun executable. |
| `debugLog` | Opt-in trace. A path (relative = next to the config file) or omitted. **Absent means no log file is ever created.** |
| `relay` | Runtime state: `routes` (what to try, in order) and `blockedUntil` (per-route cooldown deadlines). |

A single proxy is a two-route chain (`direct` + proxy). A dead or exhausted
route costs one round-trip, never a failed turn.

Only `http://` / `https://` proxies work — Bun does not support `socks5://`,
and undici has no SOCKS support either. Clash-style clients expose a mixed
port; point the URL at the HTTP port (e.g. `http://127.0.0.1:7890`).

## Requirements

Everything in this section is mandatory. Missing any of it means the extension
silently does nothing — there is no degraded mode.

### The `hook-stream` patch

**This extension does not work on a stock pi.** Its core function — retrying a
`429` through a proxy inside the same request — is built entirely on the
**`hook-stream`** patch, applied by the pi-patches runner in
[`patches/`](../../patches) (module:
[`patches/all-patches/hook-stream`](../../patches/all-patches/hook-stream)).

That patch adds `ExtensionRunner#createProviderHooks()` and
`ExtensionContext#providerHooks()`, exposing the same
`before_provider_headers` → `before_provider_request` → `after_provider_response`
→ `provider_stream_event` pipeline the agent loop installs. The relay streams the
proxied request through that pipeline instead of issuing a bare `fetch` (a custom
`fetch` is refused by pi-ai's adapter, and it would also skip pi-free's own
handlers).

Without the patch the relay has no pipeline to hand the request to, so the
`429` fallthrough never engages and the first rate-limited response ends the turn
— indistinguishable from not having oc-proxy installed.

Verify the patch is applied and clean before blaming the extension:

```bash
node ~/.pi/agent/patches/mainrunner.js status
# patch            STATUS  ON   FILES
# hook-stream      clean   yes  15
```

`ON` must be `yes` and `STATUS` must be `clean` (or `drifted` until the next
run — re-run `node mainrunner.js run`). If the entry is missing, the patch was
never registered: `patches/patches.json` is the registry.

### `bun` on `PATH`

pi-free already needs it for the opencode-free anonymous lane; the relay reuses
it for the TLS-fingerprint-preserving transport hop.

## How 429 detection works (and why it is not the obvious thing)

pi-ai calls `options.onResponse` **only after a successful response** — the
provider SDK throws on a non-2xx status *before* the promise resolves, so
`onResponse` never runs for a 429. Pi's `after_provider_response` extension
event is built on `onResponse`, so **it never fires for a 429 either**.

The real signal is the terminal `error` event of the response stream. This
extension observes it via `stream.result()`, which returns the stream's
final-result promise and does **not** consume any event, so the agent's own
consumer is unaffected.

The error text differs per transport. These are the exact strings, captured by
replaying a 429 response through every adapter opencode-free uses:

| transport | `errorMessage` |
| --- | --- |
| `openai-completions` | `429: {"type":"FreeUsageLimitError","message":"..."}` |
| `openai-responses` | `opencode-free API error (429): {"type":"FreeUsageLimitError",...}` |
| `anthropic-messages` | `429 Free usage limit reached. ...` |
| `google-generative-ai` | `{"type":"FreeUsageLimitError","message":"..."}` |

Neither a status-only nor a body-only test is sufficient: the google lane has
**no status** in the message and the anthropic lane has **no body marker**.
The matcher therefore accepts all four shapes.

When the proxy is already on, the relay also reports the exact upstream status
on stdout, so a 429 seen through the proxy rotates to the next proxy.

## How it avoids conflicting with pi-free

pi-free owns the whole opencode-free pipeline: the `public` anonymous bearer,
`x-opencode-session` / `x-opencode-request` ids, the
`<env>Working directory: .</env>` envelope, message sanitisation, wire-API
dispatch, and a bun TLS relay for the anonymous lane's transport fingerprint.
This extension touches **none** of that.

In particular it does **not** inject a custom `fetch`: pi-ai's
`google-generative-ai` adapter rejects one outright
(`Custom fetch is not supported by the Google Generative AI adapter`), and the
transport fingerprint would change besides. Instead it rewrites `model.baseUrl`
before delegating back to pi-free's own `streamSimple`:

```
https://opencode.ai/zen/v1            → pi-free normalizes → https://opencode.ai/inference/v1
                                                            → pi-free's relay rewrites to 127.0.0.1:<its port>

http://127.0.0.1:<our port>/inference → pi-free normalizes → http://127.0.0.1:<our port>/inference/v1
                                                            → pi-free's relay declines (not opencode.ai)
                                                            → our relay carries the hop
```

When the proxy is off, `model.baseUrl` is passed through untouched, so
pi-free's own relay behaves exactly as before.

The relay is a loopback-only bun child that forwards only
`/zen/v1/*` and `/inference/v1/*`, copies headers, keeps encoded bytes and
`content-encoding`, and streams the body verbatim. Bun's TLS/transport
fingerprint is preserved, so the anonymous lane keeps working. The active proxy
is read from a tiny state file **per request**, so toggling needs no relay
restart and no new port.

## Keeping the wrapper installed

pi-free re-registers its provider (catalog refresh, `/toggle-*`), and that
registration replaces the extension's `streamSimple`, which silently drops this
wrapper. Every re-registration also produces a *new* composed provider, so the
composed `streamSimple`'s identity is an exact "is my wrapper still in place?"
probe. The extension re-checks it on `agent_start` and `turn_start` — both fire
before the request goes out — and re-installs when needed. The wrapper always
wraps the *same* captured original, so repeated installations never nest.

## Verified behaviour

| Case | Result |
| --- | --- |
| `/oc-proxy off` | `model.baseUrl` untouched → pi-free relay → direct only |
| relay active | `model.baseUrl` rewritten to `http://127.0.0.1:<port>/inference/v1` |
| direct answers 200 | proxy never contacted (no proxy quota spent) |
| direct answers 429 | route parked, proxy tried **in the same request** → turn succeeds, no "Continue" |
| all routes 429 | `429` returned after one attempt per route — no retry loop, no auto-resume |
| unreachable route | skipped, the walk continues to the next route |
| parked route | skipped for `proxyCooldownMs`, persisted in the config file across sessions |
| `/oc-proxy reset` | clears every cooldown so all routes are retried |
| non-allowlisted relay path | `404` |
| `session_shutdown` | relay child terminated, no orphan `bun` process |
| 8 simultaneous activations | exactly one relay child is spawned |
| relay start racing `session_shutdown` | child is reaped, not left behind |

Live end-to-end check in pi (RPC mode, upstream redirected to a local 429
server so no quota was spent):

```
turn 1  →  429: {"type":"FreeUsageLimitError",...}          (pi-free's relay)
          extension detects it, starts the relay, enables the proxy
turn 2  →  502: {"type":"relay","message":"Unable to connect..."}
          (our relay, via the configured proxy; upstream was NOT reached)
```

## Limitations

- Only `opencode-free` (or whatever `provider` names) is affected; other
  providers are never touched.
- If your proxy's egress IP is itself blocked by Cloudflare, rotate proxies;
  this cannot solve Cloudflare challenges.
- The model catalog fetch (`fetchOpenCodeModelIds`) uses node's global `fetch`
  and is not proxied — it is not a chat request, and failures there are
  already tolerated by pi-free.

## Debugging

Logging is **off by default** — nothing is written until `debugLog` names a
path. A relative path is resolved next to the config file, so
`"debugLog": "opencode-429-proxy.log"` appends to
`~/.pi/agent/extensions/opencode-429-proxy.log`:

```
session_start startup
registered wrapper for opencode-free api= opencode-dynamic
wrapper call model= big-pickle provider= opencode-free enabled= false
stream error observed: "429: {"type":"FreeUsageLimitError",...} rateLimited= true
rate limited via stream enabled= false
activated proxy http://127.0.0.1:1 reason stream
```