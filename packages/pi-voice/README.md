# pi-voice

Hands-free voice for Pi, built on the **Gemini Live API**.

A small, always-available voice colleague sits between you and your Pi session:
you talk out loud, it answers briefly, and it drives Pi through tools when real
work is needed. It is not a second coding agent — it is the go-between.

```
 you  ──speech──▶  pi-voice  ──tools──▶  Pi agent (files, shell, models)
        ◀─voice──     │
                      └──Gemini Live (WebSocket, 16 kHz in / 24 kHz out)
```

## Why this shape

- **Gemini Live is the only genuinely free realtime voice API with function
  calling** (AI Studio free tier: audio in *and* out at no charge).
- The Gemini socket lives **inside the Pi process**. The API key never reaches the
  browser, tool calls execute natively, and the extra loopback hop costs ~0.2 ms
  against a 20–100 ms network RTT.
- Audio I/O is pluggable and **native by default** (ffmpeg, headless, no tab).
  The **browser companion page** (WebRTC echo cancellation) is opt-in via
  `audio: "browser"` (or `"both"`).

## Quick start

```bash
# from the monorepo root
/voice          # open the settings screen
/voice on       # start the voice session
```

By default audio is **native**: the extension drives `ffmpeg`/`ffplay` directly,
so there is no browser, no HTTP server and no tab. Install ffmpeg (it ships
`ffplay`); on Windows the capture device is auto-detected.

### Opting into the browser transport

Set **Transport** to `browser` (or `both`) in `/voice`. The extension then starts
the local companion page and prints its URL. Open it from that URL
(`http://127.0.0.1:...`, a secure context), allow the microphone, and press
**Start listening** or enable **Always-on wake word** — one click is required
before any browser starts audio. This path gives WebRTC AEC and the offline
phrase engines (sherpa / Web Speech).

Either way the TUI status bar shows a live mic waveform, so you can see whether
Pi is hearing you.

### Start with voice

```bash
pi --voice
```

Registers `--voice`: starts enabled and turns on always-on wake listening. With
the default native transport there is no page; with `audio: "browser"` it opens
the page and one click is required before audio starts.

### Key

Resolved in the same order Pi's own Google provider uses:

1. `apiKey` in `pi-voice.json` (explicit override)
2. **`~/.pi/agent/auth.json` → `google`** API key (the one you already configured in Pi)
3. `GEMINI_API_KEY`, then `GOOGLE_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`
4. Pi's provider registry (`getApiKeyForProvider`)

OAuth credentials (`google-gemini-cli`, `google-antigravity`) are skipped — they are not API keys.
`/voice key` with no argument shows **which source is in use**, never the key itself.
Set one explicitly with `/voice key AIza...`, or `/voice key clear` to go back to auth.json/env.

## Audio transports

| | `audio: "native"` (default) | `audio: "browser"` (opt-in) |
|---|---|---|
| Echo cancellation | **NLMS AEC** (full duplex) | **WebRTC AEC3** |
| Extra RAM | ~30–60 MB | ~15–40 MB (shared tab) |
| Needs | `ffmpeg` + `ffplay` on PATH | a browser tab open |
| Wake word | sherpa KWS / energy VAD | sherpa WASM / Web Speech / VAD |
| NPU | sherpa provider (`directml`) | **WebNN → Intel AI Boost** |

`audio: "both"` starts both and lets either side drive the session. Leaving
`nativeInput` empty auto-detects the first Windows dshow capture device; macOS
and Linux default to `:0` / `default`.

### Native device strings

```jsonc
// Windows (list with: ffmpeg -list_devices true -f dshow -i dummy)
"nativeInput": "audio=Microphone (Realtek(R) Audio)"
// macOS
"nativeInput": ":0"
// Linux (PulseAudio)
"nativeInput": "default"
```

## Wake word

`alwaysOn` is **off by default**. Enable it with `/voice always-on on` or the
toggle in the page. Native wake can use an offline sherpa-onnx-node keyword
spotter (`kwsModelDir` + `kwsKeywords`; provider `directml` can reach the GPU/NPU)
and otherwise falls back to energy VAD. The browser transport uses the sherpa
WASM module or Web Speech. The status bar carries a live waveform:

```
voice live ▁▂▄▆▄▂ ·wake     # hearing you, always-on
voice live ▁▁▁▁              # live, wake word off
voice sleeping ▁▂▁          # gated, still hearing for the wake phrase
voice error: quota…         # stopped; /voice diagnose
```

Engines (`wakeEngine`):

| Value | What it does |
|---|---|
| `auto` | sherpa if `wakeModelUrl` is set, else Web Speech, else energy VAD |
| `sherpa` | offline keyword spotting via a lazily imported module |
| `webspeech` | Chrome/Edge SpeechRecognition phrase spotter (online) |
| `energy` | local VAD — speech onset, not phrase-aware |

### Offline KWS (sherpa)

Point `wakeModelUrl` at a module that exports:

```js
export async function createKeywordSpotter({ sampleRate, phrases, sensitivity, compute }) {
  return {
    acceptWaveform(float32) { /* true when the phrase fires */ },
    reset() {},
  };
}
```

It is imported **only when always-on is enabled**. Until you supply one, `auto`
falls back to Web Speech (in Chrome/Edge) or energy VAD, so the feature works
out of the box.

### NPU

`compute` selects the local wake-word backend and defaults to **`cpu`** (WASM).
The value `auto` prefers WebNN (Intel AI Boost NPU) then WebGPU. It does not
select the audio transport — that is `audio`. The page shows the chosen backend.

## Troubleshooting

**`socket closed 1011 … exceeded your current quota`** — the key is fine; the
*Live endpoint* refused the session. The extension now treats quota/billing as
**fatal**: it stops instead of reconnecting (a retry storm only makes it worse by
opening overlapping sessions against the concurrent-session quota). Wait for the
per-minute window, check billing for the project, or switch model. Verify with:

```
/voice diagnose
key: auth.json (google) (39 chars)
ok   gemini-3.8-live                  setupComplete (867ms)
ok   gemini-3.8-live-extended-thinking setupComplete (526ms)
FAIL gemini-3.1-flash-live-preview    close 1011: quota…
```

**Native mode: the waveform moves but Pi never speaks** — the player was dying on
startup. `ffplay` does **not** accept ffmpeg-only options such as `-ac`; it
printed `Failed to set value '1' for option 'ac': Option not found` and exited,
so every reply was written into a dead process. That is fixed (and the player now
retries once with a minimal argument set and tells you if an option is still
rejected). Quick manual check:

```
node -e "process.stdout.write(Buffer.alloc(96000))" | ffplay -nodisp -loglevel error -f s16le -ar 24000 -
```

No output means you have a working player registry entry; an `Option not found`
message means your ffplay build rejects something and the minimal retry is what
keeps you audible.

**Wake word never fires in native mode** — with `alwaysOn` on and no sherpa model,
the energy fallback needs the room noise floor to be measured first. It logs
`native wake: energy floor ... threshold ... level ...` every five seconds in
debug mode; if `level` stays below `threshold` while you speak, raise the mic
gain (Windows: Sound settings → Input → device properties) or install
`sherpa-onnx-node` with `kwsModelDir` for real keyword spotting.

**`1011 exceeded your current quota` even though `diagnose` passed** — that was a
real bug: `diagnose` used to probe a *minimal* setup, so it tested the key but
not the tools. The culprit is **Google Search grounding**: function declarations
connect fine, but `{googleSearch:{}}` alone makes a free-tier project refuse the
entire session with that 1011. It is now off by default; enable it with
`/voice set {"searchGrounding":true}` only on a billed project. If it is still
refused, the extension drops it and reconnects once automatically. `diagnose`
now probes the exact setup the session sends.

**Session connects, then every mic frame closes it with `1007`** — two Live API
traps, both handled now:

- `enableAffectiveDialog` is **accepted at setup** on 3.8 but makes the first
audio frame invalid. It is gated off per model (`capabilities.affectiveDialog`),
so it is never sent unless a model actually supports it.
- `audioStreamEnd` and `activityStart`/`activityEnd` are only valid with
**manual** VAD. With automatic VAD the session now stops sending frames instead
of emitting those markers.

**`1007 Thinking level must be specified`** — extended-thinking models reject a
setup without a level. The setup builder now supplies `low` automatically; set
`thinkingLevel` to change it.

**`No Gemini API key`** — `/voice key` shows the resolved source; the chain is
config → `auth.json` → env → Pi registry. OAuth-only credentials
(`google-gemini-cli`, `google-antigravity`) are not API keys and are skipped.

**Model/capability mismatch** — `/voice model` lists models; everything sent to
the socket is filtered through `capabilities.ts`, so sync-only models never get
`NON_BLOCKING` tools and budget models never get `thinkingLevel`.

## Autocomplete

`/voice ` completes **every subcommand**, and each subcommand completes **its own values**:

```
/voice m<TAB>          → model
/voice model g<TAB>    → model gemini-3.8-live   (current one annotated)
/voice always-on o<TAB>→ always-on on
/voice autonomy st<TAB>→ autonomy steer
/voice compute web<TAB>→ compute webgpu / webnn (NPU)
/voice voice-name ko<TAB> → voice-name Kore
/voice set {"al<TAB>   → set {"alwaysOn":true}
```

Details that make it behave like a real completer:

- Pi replaces the **whole argument text**, so values are returned as complete
  arguments (`model gemini-3.8-live`), not bare tokens.
- Matching is prefix → word-prefix → **subsequence** (`won` → `always-on`), with
  descriptions shown for each item.
- `model` and `voice-name` mark the active value; commands are ordered by how
  likely you are to need them.
- `set` offers typed JSON snippets (`{"audio":"native"}`, `{"bargeIn":false}`, …).
- Unknown input returns nothing, so Pi falls back cleanly.

## Settings

`/voice` with no arguments opens a searchable settings screen built from the same
components as Pi's own `/settings`: every option in this file, text and number
fields opened as submenus, changes saved as you go.

```
↑↓ move · Enter change · type to search
Ctrl-R restart · Ctrl-T stop · Ctrl-D diagnose · Ctrl-O open page · Esc close
```

## Commands

```
/voice                     open the settings screen (TUI)
/voice status              print status without the TUI
/voice diagnose            open a real Live socket per model and report the server's answer
/voice on | off | restart
/voice url
/voice listen | sleep
/voice always-on [on|off]
/voice model <id>          gemini-3.8-live (default) · 3.8-live-extended-thinking
                           · 3.1-flash-live-preview · 2.5-flash-native-audio-preview-12-2025
/voice voice-name <name>   prebuilt Gemini voice (default Zephyr)
/voice autonomy <concierge|steer|approvals>
/voice wake-engine <auto|sherpa|webspeech|energy>
/voice compute <auto|cpu|webgpu|webnn>
/voice key <key>
/voice announce [on|off]
/voice debug [on|off]
/voice set {"alwaysOn":true}
```

## What the voice model can do

Function declarations are filtered per model, so a sync-only model never gets
`NON_BLOCKING` tools.

| Tool | Purpose |
|---|---|
| `pi_status` | what Pi is doing right now (state, active tool, last result) |
| `pi_recent` | recent Pi messages |
| `pi_ask` | send a request to Pi; **async** on capable models, so the conversation continues while Pi works |
| `pi_stop` | interrupt Pi (autonomy ≥ steer) |
| `voice_sleep` / `voice_always_on` | control the listener |
| `voice_approve` | answer a pending approval |
| `voice_note` | save a note into the session |

The Pi side also gets a `voice` tool:

```ts
voice({ action: "speak", text: "build finished, two tests failed" })
voice({ action: "listen" | "sleep" | "status" | "always_on", enabled?: boolean })
```

Saying you are done (“that's all”, “we can stop”, “goodnight”, “stop listening”)
makes the model give one short goodbye and call `voice_sleep`, which stops the mic
until the wake phrase brings it back. Pi itself keeps working.

### Barge-in

`bargeIn` is **on**: speech interrupts the model. That needs echo control, which
both transports provide — native runs an NLMS acoustic echo canceller in front of
the mic (full duplex, double-talk aware), and the browser uses WebRTC AEC3. If the
model still gets cut off, turn barge-in off in `/voice`; the page then goes
half-duplex while it speaks and playback prebuffers ~90 ms.

## Autonomy and approvals

| Level | Behaviour |
|---|---|
| `concierge` | talk, read status, queue messages for Pi |
| `steer` | + interrupt / steer a running turn |
| `approvals` (default) | + answer risky-action prompts by voice |

With `voiceApprovals`, `bash`/`powershell` calls matching dangerous patterns
(recursive delete, `git push`, `sudo`, `| sh`, ...) block while the voice model
asks you out loud. Denial returns `{ block: true }`. If nobody answers — page
closed, mic asleep, no connected listener — the call proceeds after a warning
instead of hanging: voice approval is a convenience here, never a hard gate.
Setup details, like the resumption handle and the workspace lock, live in
`~/.pi/agent`: `pi-voice-state.json` and `pi-voice-<workspace>.lock`.

## Context and latency

- **Resumption**: the Gemini handle is persisted as a session entry
  (`voice.state`), so a restarted Pi can rejoin the same logical conversation
  (handles live 2 h).
- **Compression**: `contextWindowCompression.slidingWindow` removes the 15-minute
  audio-session cap.
- **Reconnect**: `GoAway` triggers a proactive resume ~1.5 s before the server
  rotates the connection; unexpected closes back off with jitter.
- **Idle gate**: after `idleSleepMs` of silence the mic upstream is gated. No
  `audioStreamEnd`/`activityStart` is sent — those are only valid with manual VAD
  and are rejected under automatic VAD. The session (and its context) stays alive.
- **No transcript seeding**: the model pulls context via `pi_status` /
  `pi_recent`, which is cheaper than streaming Pi's history.
- **Low latency**: raw PCM passthrough (no re-encode), 20 ms frames, VAD tuned
  for fast turn ends, `responseModalities: ["AUDIO"]`, thinking off by default.

## Gemini Live features used

`sessionResumption` · `contextWindowCompression` · automatic VAD (prefix/silence,
sensitivities) · `activityHandling` (barge-in) · `turnCoverage` ·
`inputAudioTranscription` + custom vocabulary · `outputAudioTranscription` ·
`proactivity` (proactive audio/video) · affective dialog · thinking level/budget ·
Google Search grounding (**billed projects only** — auto-dropped otherwise) ·
function calling incl. `behavior: NON_BLOCKING` and `INTERRUPT`/`WHEN_IDLE`/`SILENT`
scheduling · `voiceActivity` / `interactionStatus` signals · usage metadata · GoAway.

## Security

- HTTP + WebSocket bind to `127.0.0.1` only.
- A random per-run token is required for the page, assets, config and socket.
- The API key never leaves the Pi process.
- The page can drive your microphone; treat the printed URL as private.

## Limitations

- The browser transport needs that tab open while voice is active.
- Native transport echo cancellation is half-duplex, not AEC3.
- Native wake word is energy VAD unless an offline KWS is supplied.
- Live API is preview: model ids, limits and fields can change.
- Free-tier traffic may be used to improve Google's products — don't route
  private audio through it.

## Sessions and `/reload`

- **`/reload` keeps the running voice session.** The controller lives on the
  process rather than the extension module, so the reloaded module reclaims it and
  rebinds to the new session runner: no `1008 session not found`, no duplicate
  socket, no restart of the conversation.
- The resumption handle is also written to
  `~/.pi/agent/pi-voice-state.json`, keyed by workspace, so it survives
  `--no-session` and process restarts. Handles are valid for two hours after a
  session ends; if the server rejects one anyway, the extension clears it and
  starts fresh once.
- **One instance per workspace.** A lock file records the owning PID plus a
  random ownership token, and is created exclusively so two processes starting at
  the same instant cannot both win. A second Pi process in the same project
  refuses to start a duplicate and points at the running instance instead. Locks
  are advisory: a lock held by a dead PID (or older than 12 hours, in case the PID
  was reused) is taken over rather than blocking voice forever.

## Version

Current: **0.4.2** — pre-1.0 while the Gemini Live API is in preview. See
[CHANGELOG.md](CHANGELOG.md) for the history and the versioning policy.

## Layout

```
index.ts / extension.ts   registration, `voice` tool, approval gate
controller.ts             session <-> audio server <-> bridge
live/                     protocol, setup shaping, socket supervisor
bridge/                   Pi digest, function declarations, dispatch, persona
audio/                    local HTTP+WS server, minimal RFC6455, ffmpeg transport
web/                      companion page, audio worklets, wake engines
test/                     protocol/config smoke tests + endpoint + lifecycle
```

## Tests

```bash
npm test   # smoke (56) + endpoint (19) + lifecycle (15)
```

`test/smoke.ts` covers capability filtering, setup shaping, wire protocol, config
normalization, argument completions, key resolution order (auth.json → env →
registry), lock ownership/release/staleness, resumption-handle sequencing and the
NLMS echo canceller.

`test/server.ts` drives the local endpoint: static serving, the token gate, path
traversal, the hand-rolled WebSocket server (handshake, masked frames, binary),
crash probes (malformed escape, invalid `Host`, bad upgrade), an oversized-frame
`1009` close and repeated start/stop cycles.

`test/lifecycle.ts` drives the real `VoiceController` against a fake Gemini Live
endpoint: five start/stop cycles, double start, stop during start, restart
resumption, `/reload` rebind, honest `pi_ask`/`pi_stop` results, cross-process
locking and stale-lock takeover.