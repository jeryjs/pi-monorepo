# Changelog

All notable changes to `@jeryjs/pi-voice` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] - 2026-11-26

Native mode could be silent: Pi heard you but never spoke.

### Fixed

- **`ffplay` was spawned with `-ac`,** which is an ffmpeg-only option. It exited
  immediately with `Failed to set value '1' for option 'ac': Option not found`, so
  every model reply was written into a dead process and nothing was audible. The
  channels option is gone (raw `s16le` is mono), and if `ffplay` ever rejects an
  option again the player is respawned once with a minimal argument set and the
  reason is reported instead of failing silently.
- **The echo canceller could diverge** by adapting while the reference signal was
  effectively silent, which distorted the microphone the model hears on later
  turns. Adaptation is now skipped below a reference-energy floor, the filter is
  shorter (768 taps ≈ 48 ms) and runs only while the model is actually speaking,
  so the mic path stays exact and cheap when you are the only one talking.
- **Partial capture chunks are no longer dropped.** A frame split across two
  `ffmpeg` reads used to lose its trailing bytes; the remainder is carried into
  the next chunk.
- **Native wake is quieter-friendly**: the energy fallback now tracks the room
  noise floor and requires 120 ms of speech instead of a fixed 0.05 threshold
  that soft microphones never crossed. It logs the floor/threshold/level every
  five seconds in debug mode.

## [0.4.0] - 2026-11-26

Reload-safe sessions, one instance per workspace, native full duplex with real
AEC, and offline native wake via sherpa.

### Added

- **`/reload` keeps the running voice session.** The controller is kept on the
  process (not the extension module) and rebound to the reloaded runner, so a
  reload no longer resumes an already-closed Live session (`1008`) or opens a
  duplicate. `session_shutdown` with `reason: "reload"` deliberately does not
  stop it.
- **File-backed resumption state** at `~/.pi/agent/pi-voice-state.json`, keyed by
  workspace, so continuation works with `--no-session` and across process
  restarts (handles are valid for two hours after a session ends). A rejected
  handle is cleared, and the next start is fresh.
- **One instance per workspace** via a lock file recording the owning PID (and
  page URL). A second Pi process in the same project refuses to start a duplicate
  Live session and microphone, and reports the running instance.
- **Native full duplex**: a time-domain NLMS acoustic echo canceller with
  double-talk detection subtracts the known playback signal from the mic, so
  barge-in works on speakers without the model hearing itself.
- **Native wake via `sherpa-onnx-node`**: offline keyword spotting with a
  provider option (`directml` can reach the GPU/NPU); falls back to energy VAD
  when the module or model files are missing.

### Changed

- `bargeIn` is on by default again, now that echo control is in place in both
  transports. Turn it off if a noisy room still cuts the model.
- `nativeAec` defaults to `nlms` (full duplex) instead of `half-duplex`.

### Fixed

- Native wake pre-roll is generated from the AEC-cleaned signal.

## [0.3.0] - 2026-11-26

Native transport by default, a full settings TUI, and the "model stops
mid-sentence" fix.

### Added

- `/voice` with no arguments opens a full settings screen: searchable, every
  option, text/number fields as submenus, and actions on control keys
  (`Ctrl-R` restart, `Ctrl-T` stop, `Ctrl-D` diagnose, `Ctrl-O` page). Loaded
  lazily so the extension entry stays light.
- The native transport auto-detects the first Windows dshow capture device, so it
  works without configuring `nativeInput`.
- Ending a conversation: when the user says they are done, leaving, or says
  goodnight, the model gives one short goodbye and calls `voice_sleep`, which
  stops the mic until the wake phrase.

### Changed

- **Native (ffmpeg) is the default transport.** No HTTP server, page or browser
  tab is started unless `audio` is `browser` or `both`.
- **`bargeIn` is off by default.** With server VAD interruptions enabled, speaker
  echo and room noise counted as speech and cut the model off mid-sentence; it
  then resumed the unfinished sentence on the next turn. While the model speaks
  the page is now half-duplex, and playback prebuffers ~90 ms so network gaps do
  not sound like a stop.
- The page no longer flushes playback when going to sleep, so a goodbye is not
  cut off.

## [0.2.0] - 2026-11-26

Fixes the "session connects, then dies on the first mic frame" failure and makes
the transport resilient enough to leave running.

### Added

- `--voice` CLI flag: start Pi with voice enabled, open the companion page, and
  turn on always-on wake listening (waiting for the wake phrase).
- TUI status-bar state and microphone waveform (`voice live ▁▂▃ ·wake`) so it is
  visible whether Pi can hear anything.

### Fixed

- **Mic audio rejected with `1007 Request contains an invalid argument`.**
  `enableAffectiveDialog` is accepted at setup on `gemini-3.8-live` but makes the
  first audio frame invalid. It is now gated per model and never sent.
- `audioStreamEnd` and `activityStart`/`activityEnd` are only valid with manual
  VAD. Under automatic VAD the session now stops sending frames instead of
  emitting those markers.
- A rejected resumption handle (`1008 BidiGenerateContent session not found`) now
  drops the handle and starts a fresh session — but only when the handle came
  from persisted state. Real setup errors stay fatal instead of being retried as
  if they were expired sessions.
- Fatal quota/auth closes no longer cause a reconnect storm: classified as fatal,
  at most 5 attempts, 30 s backoff cap, and a 400 ms gap between sessions.
- The companion page reuses one token per Pi process, so `/voice restart` keeps
  an open page working. On failure it backs off, stops after six attempts, and
  reports the close code instead of spamming "reconnecting".
- Config writes no longer surface as bare command errors.
- WebSocket upgrade rejections are logged with the reason (path vs token).

### Changed

- `/voice diagnose` probes the exact setup the session sends, including tools and
  generation config, rather than a minimal one.

## [0.1.0] - 2026-11-26

Initial internal milestone (never published or tagged). Everything below was
built and verified against the Gemini Live API during this milestone.

### Added

- Raw Gemini Live WebSocket client (`v1beta BidiGenerateContent`), no SDK:
  binary server frames, session resumption, context-window compression, GoAway
  handling, automatic VAD, barge-in, input/output transcription, usage metadata.
- Pi bridge: session digest, `pi_status`, `pi_recent`, `pi_ask` (async
  `NON_BLOCKING` when the model supports it), `pi_stop`, approval mediation and a
  `voice` tool so the main agent can speak and steer the voice channel.
- Spoken approval gate for risky `bash`/`powershell` calls (recursive delete,
  `git push`, `sudo`, pipe-to-shell, …), deferring to normal behaviour on
  timeout instead of hanging.
- Local audio endpoint: dependency-free RFC 6455 server on loopback with a
  per-run token, and a companion page using WebRTC AEC, capture/playback
  worklets, pre-roll and barge-in flush.
- Native ffmpeg transport (no browser tab) with a half-duplex echo gate.
- Wake-word layer: lazy offline KWS contract, Web Speech and energy-VAD
  fallbacks; compute backend selection (WebNN/NPU, WebGPU, CPU).
- `/voice` command surface with context-aware argument completions: subcommands,
  all four Live models, all 30 prebuilt voices, autonomy/wake/compute values and
  `set` JSON snippets.
- `/voice diagnose`: opens a real Live socket per model and reports the server's
  answer, distinguishing bad key from model config from quota/billing.
- Key resolution mirroring Pi's own order: config → `auth.json` (`google`) → env
  (`GEMINI_API_KEY`, …) → Pi provider registry. OAuth credentials are skipped.
- Google Search grounding as an opt-in feature (billed projects only) with
  automatic degrade when a project refuses it.
- Tests: protocol/config/capability shaping, argument completions, key order,
  failure classification, and an endpoint integration suite (handshake, masked
  frames, binary relay, token gate, path traversal).

### Fixed

- Server messages arrive as binary frames (`Blob` by default); they are parsed
  instead of silently ignored.
- `gemini-3.8-live-extended-thinking` requires `thinkingLevel`; the setup builder
  supplies `low` by default.
- A rejected resumption handle no longer kills the session permanently.
- Quota/billing refusals are fatal rather than retried indefinitely.
- Companion-page assets were token-gated, so the HTML loaded with no CSS or JS
  (dead buttons). Static assets are public; the page and client config stay
  gated, and path traversal is contained.
- `compute` defaults to `cpu` rather than auto-selecting a GPU/NPU backend.

## Versioning

- **0.x** while the Gemini Live API is in preview: a MINOR bump may include
  behaviour changes; PATCH is fixes only. **1.0.0** once the surface is stable
  and the extension has been used in anger.
- Add entries under `## [Unreleased]` as work lands. On release, rename that
  section to the new version and date, and bump `package.json` in the same
  commit.
- `test/smoke.ts` asserts the top versioned entry in this file matches
  `package.json`, so the two cannot drift.