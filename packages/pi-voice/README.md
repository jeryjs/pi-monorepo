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
- The Gemini socket lives **inside the Pi process**: the API key never leaves it,
  tool calls execute natively, and audio never leaves the machine.
- Audio I/O *is* `ffmpeg`/`ffplay`. No browser, no HTTP server, no tab, nothing to
  open — one transport, no switching.

## Wake word: three engines, because one of them will not fit every voice

| engine | what it is | cost |
|---|---|---|
| `asr` | streaming recognizer + fuzzy phrase match on the transcript | ~122 MB model, 20M params |
| `sherpa` | sherpa-onnx keyword spotter (3.3M params, acoustic match) | ~17 MB model, very cheap |
| `energy` | loud-speech VAD, no phrase model at all | free, fires on any speech |

`wakeEngine: "auto"` (default) uses `asr` when its model is installed, otherwise
`sherpa` when the keyword model is installed, otherwise `energy`.

**If the wake phrase never fires, this is the order to check:**

1. `/voice mic 3` — does the microphone deliver signal at all? `DIGITAL SILENCE`
   means Windows privacy/mute, not the detector.
2. The lab in `C:/tmp/pv-kws-demo` (`node lab.mjs`) — record six takes, press
   *Analyze*: it reports, per take, the peak/RMS, whether the level is clipping, the
   **lowest threshold at which that take fires** (or `never`), and what a general ASR
   hears in it.
3. `never` at every threshold is not a tuning problem. Switch engines:
   `/voice asr` installs the recognizer and sets `wakeEngine: "asr"`; the phrase is
   matched as words, so it tolerates accents and delivery in a way acoustic keyword
   spotting cannot.
4. Clipping (peak 1.00) destroys intelligibility for *both* engines: lower the
   microphone level (Windows: Sound → Input → level, and turn off "Microphone
   Boost"), then re-record. Five of six takes in the case that motivated this were
   clipping at full scale.

## Quick start

```bash
# from the monorepo root
/voice          # open the settings screen
/voice on       # start the voice session
```

Audio is `ffmpeg`/`ffplay` driven directly: install ffmpeg (it ships `ffplay`);
on Windows the capture device is auto-detected. The TUI status bar shows a live
mic waveform, so you can see whether Pi is hearing you.

### Start with voice

```bash
pi --voice
```

Registers `--voice`: starts enabled, turns on always-on wake listening, and
**starts asleep** — the wake spotter runs locally and no Gemini session exists
until you say the phrase (see `connectOnWake` below). Nothing to open and no
click to give: the first phrase is all it takes.

### Key

Resolved in the same order Pi's own Google provider uses:

1. `apiKey` in `pi-voice.json` (explicit override)
2. **`~/.pi/agent/auth.json` → `google`** API key (the one you already configured in Pi)
3. `GEMINI_API_KEY`, then `GOOGLE_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`
4. Pi's provider registry (`getApiKeyForProvider`)

OAuth credentials (`google-gemini-cli`, `google-antigravity`) are skipped — they are not API keys.
`/voice key` with no argument shows **which source is in use**, never the key itself.
Set one explicitly with `/voice key AIza...`, or `/voice key clear` to go back to auth.json/env.

## Audio devices

Two processes per session: `ffmpeg` reading the input, `ffplay` writing the
output. Leaving `nativeInput` empty auto-detects the first Windows dshow capture
device; macOS and Linux default to `:0` / `default`.

Echo: `nativeAec` is `nlms` by default — a real adaptive canceller in front of the
mic, so the model does not hear itself and barge-in works on speakers.
`half-duplex` mutes the mic while the model speaks; `off` disables it (use
headphones).

### Device strings

```jsonc
// Windows (list with: ffmpeg -list_devices true -f dshow -i dummy)
"nativeInput": "audio=Microphone (Realtek(R) Audio)"
// macOS
"nativeInput": ":0"
// Linux (PulseAudio)
"nativeInput": "default"
```

## Wake word

`alwaysOn` is **off by default**. Enable it with `/voice always-on on`. Wake
happens locally, on this machine, in one of three engines; without an installed
phrase model the energy VAD is used, which wakes on any loud-enough speech rather
than a phrase. The status bar carries a live waveform:

```
voice live ▁▂▄▆▄▂ ·wake         # hearing you, always-on
voice live ▁▁▁▁                  # live, wake word off
voice asleep ·wake               # no Gemini session yet; only the local spotter runs
voice asleep ·wake ·no mic signal # the device is delivering silence — /voice mic
voice sleeping ▁▂▁              # gated after idle, still hearing for the wake phrase
voice error: quota...             # stopped; /voice diagnose
```

### Starting asleep (`connectOnWake`)

`connectOnWake` is **on by default**. With an always-on wake word, `/voice on`
and `pi --voice` start in `asleep`: the mic and the wake spotter run, but no
Gemini socket is opened, no context is created and no quota is spent until the
wake phrase fires. The first thing you say after the phrase is buffered across
the handshake (~4 s), so "hey pi, check my messages" arrives whole instead of
being cut to the last syllable. Set `connectOnWake: false` to keep an eagerly
connected session instead — that warms the connection at the cost of a session
nobody is talking to.

Engines (`wakeEngine`):

| Value | What it does |
|---|---|
| `auto` | `asr` when its model is installed, else `sherpa` when installed, else `energy` |
| `asr` | streaming recognizer + fuzzy phrase match on the transcript (`/voice asr`) |
| `sherpa` | offline keyword spotting; prompts to install what is missing |
| `energy` | local VAD — speech onset, not phrase-aware |

### Installing the offline phrase wake word (native)

`/voice` → **Wake engine** → `sherpa` (or `/voice sherpa`) checks what is missing
and asks before installing anything:

1. `sherpa-onnx-node` — prebuilt inference runtime, about 23 MB,
   into `~/.pi/agent/pi-voice-deps`
2. the KWS model (`sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01`, English,
   BPE), about 17 MB, into `~/.pi/agent/pi-voice-models/<model>`

The settings screen streams npm/download progress and offers to restart voice when
the install succeeds. Installing into the agent directory means your project and
its `package.json` are untouched, and `kwsModelDir` can stay empty — the managed
model directory is used automatically. Set `kwsModelDir` yourself to use a
different model.

The wake phrase goes in `kwsKeywords` (`HEY PI :2.0`; the trailing number is the
boost, and `;` separates several keywords). It is **tokenised** against the
model's `tokens.txt` — sherpa wants BPE pieces (`▁HE Y ▁PI`), not raw text — so an
unspellable phrase fails with a clear message and the `text2token` fallback.
`wakeSensitivity` maps to the spotter's threshold (0.25 at the 0.5 default).

### The ASR engine (when the phrase spotter cannot hear you)

`/voice asr` installs a streaming recognizer (about 122 MB, into
`~/.pi/agent/pi-voice-models`) and sets `wakeEngine: "asr"`. Instead of comparing
acoustics to one tokenised phrase, it decodes continuously and matches the
*words*: one edit allowed per word of three or more letters, none for short ones,
plus a length-guarded joined form, so `HAYPE`, `HEY P` and `HEYPI` fire while
"hey bud", "the pie is ready" and "okay pi" do not.

That matters because keyword spotting is unforgiving: on one real user's six
recordings of "hey pi" the 3.3M spotter fired at no threshold, while a general ASR
heard "HAYPE" in one of them. If `/voice mic` shows signal and the wake phrase
still never fires, this is the engine to switch to.

## Troubleshooting

**The wake word never fires** — do not start with the phrase or the model. Run:

```
/voice mic
```

It records 3 seconds from the configured input and prints one of four verdicts:

| Verdict | Meaning | Fix |
|---|---|---|
| `DIGITAL SILENCE` | the device returns zeros (peak 0) | Windows → Sound → Input: mute/volume, and Privacy → Microphone → allow desktop apps. Check `nativeInput` is the mic, not Stereo Mix |
| `signal present but very quiet` | speech never reaches the threshold | raise mic gain, or `wakeSensitivity` |
| `signal present (…%)` | the mic is fine, so the detector is the problem | check `/voice status` for `wake engine running` and `wake hits` |
| `could not capture: …` | ffmpeg could not open the device | fix `nativeInput`; a second reader can fail while voice is running |

`/voice status` also reports `wake engine running: sherpa (cpu)` (the engine that
actually got constructed, not what the config asks for), `wake hits` with the last
source, and `mic: NO SIGNAL` when nothing but silence arrived in the last 8
seconds. A silent mic also shows up in the status bar as `·no mic signal`, so
"asleep forever" is never left unexplained.

**The status bar says `voice asleep` and nothing is connected** — that is
`connectOnWake` working: the wake spotter is running, no Gemini session exists
yet. Say the phrase. If you want a warm connection anyway, set
`connectOnWake: false`.

**`DirectML is for Windows only. Fallback to cpu!` (three times) in the log** —
harmless, and now not requested by default. The published `sherpa-onnx-node`
package ships `onnxruntime.dll` and `onnxruntime_providers_shared.dll` but no
`DirectML.dll`, so any accelerator name makes sherpa print that line once per
onnx session (encoder, decoder, joiner) and use the CPU anyway. `sherpaProvider`
defaults to `cpu`; set an accelerator only with a self-built sherpa runtime.

**Every native log line appears twice** — fixed: the transport logged through its
own `log()` *and* the controller's `onLog`, which both wrote the same prefixed
line.

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

**Wake word never fires in native mode** — run `/voice sherpa` (or pick
`wakeEngine = sherpa` in `/voice`) to install the offline spotter; that is what
makes the wake word phrase-specific. Without it, the energy fallback needs the
room noise floor to be measured first: it logs
`native wake: energy floor ... threshold ... level ...` every five seconds in
`native wake (...): level ... floor ... threshold ...` every five seconds in
debug mode, and if `level` stays below `threshold` while you speak, raise the mic
gain (Windows: Sound settings → Input → device properties). Turn `debug` on to
see those numbers while you tune `wakeSensitivity` — with it off, nothing is
written to the console at all (`/voice status` keeps the last warnings and shows
them on demand).

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
/voice wake-engine a<TAB>→ wake-engine asr / auto
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
- `set` offers typed JSON snippets (`{"connectOnWake":true}`, `{"bargeIn":false}`, …).
- Unknown input returns nothing, so Pi falls back cleanly.

## Settings

`/voice` with no arguments opens a searchable settings screen built from the same
components as Pi's own `/settings`: every option in this file, text and number
fields opened as submenus, changes saved as you go.

```
↑↓ move · Enter change · type to search
Ctrl-R restart · Ctrl-T stop · Ctrl-D diagnose · Esc close
```

## Commands

```
/voice                     open the settings screen (TUI)
/voice status              print status without the TUI
/voice diagnose            open a real Live socket per model and report the server's answer
/voice on | off | restart
/voice listen | sleep
/voice always-on [on|off]
/voice model <id>          gemini-3.8-live (default) · 3.8-live-extended-thinking
                           · 3.1-flash-live-preview · 2.5-flash-native-audio-preview-12-2025
/voice voice-name <name>   prebuilt Gemini voice (default Zephyr)
/voice autonomy <concierge|steer|approvals>
/voice wake-engine <auto|asr|sherpa|energy>
/voice asr                 install the ASR wake model and switch to it
/voice mic [seconds]       record the input and report peak/rms; says plainly when the mic is silent
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

### Everything is Pi's job (no refusals)

The voice model has no tools of its own — no files, no shell, no network, no
accounts. That is easy for a voice model to misread as "I can't do that", and an
early version did exactly that: *“hey pi, check my whatsapp, I should have a PDF
from amma”* got "I'm not able to check your messages" instead of being handed to
Pi, which can (via `wacli` and a shell). The instruction now says, in as many
words, that Pi is a general agent (files, shell, web, and the user's own CLI
tools: mail, WhatsApp, GitHub, calendars), that Pi is the only one who knows what
it can do, and that refusing on Pi's behalf is forbidden — the worst case of a
wrong hand-off is Pi answering "can't", while a refusal costs the whole task.

The promised follow-up is wired too: a delivered `pi_ask` marks the turn as
*owed a reply*, and Pi's `agent_settled` answer is spoken back **even with
`announce` off**. Without that, the model would say "I'll tell you when Pi's
back" and then never speak again.

### Delivery modes

`pi_ask` has two modes, `steer` by default (speech is about the run happening now),
and both always state one — a busy Pi rejects a message that does not carry it:

| Mode | Wire options | Behaviour |
|---|---|---|
| `steer` (default) | `deliverAs` + `streamingBehavior` = `steer` | injected into the running turn |
| `queue` | `deliverAs` + `streamingBehavior` = `followUp` | delivered when Pi's current turn ends |

The name is set twice on purpose: the extension API documents `deliverAs`, the
session validates `streamingBehavior`, and the extension API reports a rejection
only as a background extension error — which is how `pi_ask` used to answer
"sent" for messages that never reached Pi while it was busy.

### Talking over the model

Two rules, because two voices came from breaking them:

1. **Never inject a notice into an open turn.** Pi's answer is held until the server
   reports the model's turn complete (2.5 s cap), then delivered — otherwise the old
   sentence and the new answer are both generated and both play.
2. **Cut what is audible, not what is recent.** Local playback is flushed whenever
   the model could still be heard: queued frames included, which is why the player
   exposes `playingUntil` (frames handed over plus the acoustic tail). Only the part
   of a *still-generating* turn is muted afterwards, so the flush cannot swallow the
   incoming answer.

The held notice is framed as an interruption, so the model says a short "oh" and
then the answer instead of finishing the sentence it was told to abandon.

A notice delivered while the session was idle-gated re-opens the mic first, so the
reply to it is heard. Model audio also counts as conversation activity now, so the
idle window starts when it stops talking rather than when the user last spoke.

### Logging

Nothing is written to stderr unless `debug` is on (`/voice debug on`, or
`PI_VOICE_DEBUG=1`; `PI_VOICE_DEBUG=false`, `0`, `off` and `no` are all off — plain
truthiness used to enable verbose logging for the string `"false"`). Failures are
never lost: `warn()` records them and `/voice status` prints the last three, and the
ones that mean "voice is not running" also surface through `ui.notify`.

### Context: what the voice knows about your Pi session

The digest is part of the **system instruction**, rebuilt on every connect: Pi's
state, the user's current request, and the last `digestTurns` (6) turns with
`digestChars` (900) per message. When the bridge is created — including after
`/resume`, `/switch` or `/tree` — it seeds itself from Pi's own transcript
(`buildSessionContext()`), skipping tool results, which never reach a `message_end`
event.

So "what has the agent done in this session?" is answerable immediately after a
resume, and a genuinely empty session is described as empty rather than invented.

### When the socket dies

A close that cannot be retried usefully — the server's own `1008: Session closed`,
or a retry budget that ran out — parks the controller in the same state as
`connectOnWake`: **asleep, spotter armed, no socket**. Nothing reconnects on its
own, so an idle close cannot burn quota, and the next wake phrase opens a fresh
session. Policy refusals (bad key, quota, rejected setup) are still reported — they
just no longer leave voice dead until a restart.

The Pi side also gets a `voice` tool:

```ts
voice({ action: "speak", text: "build finished, two tests failed" })
voice({ action: "listen" | "sleep" | "status" | "always_on", enabled?: boolean })
```

Saying you are done (“that's all”, “we can stop”, “goodnight”, “stop listening”)
makes the model give one short goodbye and call `voice_sleep`, which stops the mic
until the wake phrase brings it back. Pi itself keeps working.

### Barge-in

`bargeIn` is **on**: speech interrupts the model. That needs echo control — an
NLMS acoustic echo canceller runs in front of the mic (full duplex, double-talk
aware). If the model still gets cut off on speakers, turn barge-in off in
`/voice`: the transport then goes half-duplex while it speaks and playback
prebuffers ~90 ms.

## Autonomy and approvals

| Level | Behaviour |
|---|---|
| `concierge` | talk, read status, queue messages for Pi |
| `steer` | + interrupt / steer a running turn |
| `approvals` (default) | + answer risky-action prompts by voice |

With `voiceApprovals`, `bash`/`powershell` calls matching dangerous patterns
(recursive delete, `git push`, `sudo`, `| sh`, ...) block while the voice model
asks you out loud. Denial returns `{ block: true }`. If nobody answers — voice not
running, mic asleep, prompt undeliverable — the call proceeds after a warning
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
- **Idle gate**: after `idleSleepMs` (45 s) without *voice* — not merely quiet
  frames — the mic upstream is gated, capture process included. No
  `audioStreamEnd`/`activityStart` is sent — those are only valid with manual VAD
  and are rejected under automatic VAD. The session (and its context) stays alive.
- **Start asleep**: with `connectOnWake` (default) there is no session at all
  until the wake phrase, so an idle day costs nothing and holds no context.
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

- No network listener at all: there is no HTTP server and no local endpoint to
  authenticate, because no other process needs one.
- The API key never leaves the Pi process.
- Everything the extension runs is `ffmpeg`/`ffplay` with fixed arguments.

## Limitations

- Wake needs a model to be phrase-specific: energy VAD (the fallback) wakes on any
  loud speech. `/voice asr` or `/voice sherpa` installs one; both are English.
- Echo cancellation is NLMS, not WebRTC AEC3: on loud speakers with `bargeIn` on
  the model can still cut itself off. `nativeAec: "half-duplex"` is the safe choice.
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

Current: **0.7.0** — pre-1.0 while the Gemini Live API is in preview. See
[CHANGELOG.md](CHANGELOG.md) for the history and the versioning policy.

## Layout

```
index.ts / extension.ts   registration, `voice` tool, approval gate
controller.ts             session <-> audio <-> bridge
live/                     protocol, setup shaping, socket supervisor
bridge/                   Pi digest, function declarations, dispatch, persona
audio/                    ffmpeg transport, NLMS AEC, wake engines (asr/kws/match)
sherpa.ts                 on-demand wake-model installer (runtime + models + keywords)
test/                     smoke + lifecycle + installer suites
```

## Tests

```bash
npm test   # smoke (77) + lifecycle (35) + sherpa (13)
```

`test/smoke.ts` covers capability filtering, setup shaping, wire protocol, config
normalization, argument completions, key resolution order (auth.json → env →
registry), lock ownership/release/staleness, resumption-handle sequencing and the
NLMS echo canceller.

`test/ws-server.ts` is the test-side RFC 6455 server (handshake, masked frames,
binary, oversized-frame `1009` close) that the lifecycle harness uses to stand in
for Gemini Live. It is test support, not shipped code: the npm package excludes
`test/`.

`test/lifecycle.ts` drives the real `VoiceController` against a fake Gemini Live
endpoint (that file's WebSocket server): five start/stop cycles, double start, stop
during start, concurrent start collapsing to one result and one socket, restart
resumption, `/reload` rebind, the idle gate (engages on silence, voice keeps it
awake), **start-asleep (`connectOnWake`: no socket until wake, then live, and no
connection from a config change either)**, honest `pi_ask`/`pi_stop` results,
wake-engine status reporting (asr / sherpa / energy VAD), cross-process locking and
stale-lock takeover; plus the microphone-probe verdicts (silent / quiet / signal /
capture failure) in the smoke suite.

`test/sherpa.ts` covers the wake-word installer offline: BPE keyword
spotting/tokenisation (including the uncoverable-phrase error and the digest-named
keywords cache), status reporting, a fake npm (success, streamed output, and a
failing install whose stderr is surfaced) and a model download served from a real
`tar -cjf` archive to exercise fetch → extract → verify → move, plus the full
guided setup. The real path was verified by hand against npm and the GitHub model
release; the resulting spotter detected a phrase in the model's own test wav.