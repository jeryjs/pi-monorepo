# Changelog

All notable changes to `@jeryjs/pi-voice` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] - 2026-12-01

Voice can now answer Pi's questions. Until this release, a tool that blocked on a human
(`ask_user_questions`, a questionnaire, any confirm-by-typing prompt) made voice go
silent: the socket stayed up, the mic was open, and nothing reached the model — so the
user could not even be told what Pi was waiting for, let alone answer it.

### Added

- **A question protocol on `pi.events`.** Four channels — `voice:question`,
  `voice:question:accepted`, `voice:question:withdraw`, `voice:answer` — so any extension
  can offer a prompt to voice without importing this package. `question.ts` holds the
  contract, validation and matching; the README shows the ten-line provider.
- **`voice_answer` tool.** The model answers with the option's value, the option's label,
  its 1-based number, a spoken ordinal ("the second one") or the user's own words as
  `text`. Matching happens in pi-voice, so a provider only ever receives an option it
  actually offered, and a choices-only question never turns an unmatched utterance into
  free text. `cancel: true` closes the provider's own UI instead.
- **Multi-question prompts** are answered one at a time and accumulated: a prompt is
  complete only when every question has an answer, and answering the same question again
  replaces it rather than being counted twice.
- **The mic is held open while a prompt is pending.** The next thing said is the answer,
  so the idle gate must not mute the mic mid-answer; the 5-minute TTL bounds it, so an
  abandoned question cannot keep the session (and its quota) awake.
- **Prompts are retired properly.** `withdraw` (answered on screen) tells the model to
  drop the question instead of asking again; teardown, restart and `/reload` clear the
  registry so an old id can never be answered by a new socket. Answering a closed id is
  refused with "the user may have already answered on screen" rather than reported as
  success.
- **A read-only fallback** for tools that block on input but never adopted the protocol:
  `tool_execution_start` with a questionnaire-shaped argument gets one announcement that
  reads the question and says plainly it must be answered on screen. It is suppressed
  when the protocol already covers the same tool call, and de-duplicated per call so a
  long-running tool cannot talk twice.
- `ask_user_questions` (in `~/.pi/agent/extensions/questionnaire.ts`) is the first adopter:
  options are answerable out loud, "Type something" answers work as `text`, the keyboard
  and the voice channel race and whichever answers first wins, and in a headless session
  (no UI) the tool now waits for a spoken answer instead of failing outright.

## [0.7.2] - 2026-12-01

A third audit, on the surface the first two skimmed (command parsing, status text,
prompt payloads, key handling) found one issue serious enough to block a release and
a set of honesty bugs in the reporting the user relies on. All fixed, each with a test.

### Security

- **A command being approved could be read out loud with its credentials.** The risky
  command's text is put in the approval summary, which is handed to the voice model
  with "ask the user to allow or deny" — so the whole prompt (and the spoken question)
  carried whatever the command line contained. `curl -H "Authorization: Bearer sk-…"`,
  `GITHUB_TOKEN=…`, `--password …`, `https://user:token@host`, `:_authToken=…` and raw
  `AIza`/`sk-`/`ghp_` key shapes are now redacted in the summary and again at the prompt
  boundary. The rest of the command (which tool, which path) is kept, because that is
  what makes the approval question worth asking.
- **The settings file holding the API key is written owner-only** (`0600` on POSIX) and
  through a unique temp file, so `/voice key` and a concurrent TUI edit can no longer
  share one `path.tmp` and rename a half-written file over the good one.

### Fixed

- **`PI_VOICE_DEBUG=1` did nothing.** `setDebug(config.debug)` ran on every config load
  and overwrote the environment with the config value, so the documented switch was
  dead unless the setting was also on. The environment is now read as an override and
  `/voice status` says which source won.
- **`/voice key` (and status, and the TUI header) said "not resolved" when a key was
  resolvable.** They reported the *controller's* last resolution, which does not exist
  before voice starts — exactly when a user asks because a start just failed. The chain
  is now resolved synchronously for display: config → auth.json → environment, with Pi's
  provider registry named as the last resort it cannot check without starting.
- **`/voice always-on enabled` turned the wake word off.** Any value that was not
  `on|true|yes|1` was coerced to false. Unrecognised values are now rejected with the
  accepted list; the same applies to `announce` and `debug`. The `pi_voice` tool's
  `always_on` action likewise required `enabled`, instead of treating an omitted field
  as "off".
- **`/voice set` answered "config updated" whatever happened.** Unknown keys were dropped
  and `{"idleSleepMs":"soon"}` silently became the default, so a typo was indistinguishable
  from success. The command now names the ignored keys and the values the validators
  coerced (with before → after), and reports those as warnings.
- **`/voice voice-name Aepide` was accepted** and only failed when the server rejected the
  setup frame. Names are now checked against the prebuilt list at the command.
- **Status text contradicted the controller.** The `start:` line claimed "connects at
  startup (connectOnWake off)" whenever always-on was off, even with `connectOnWake` on —
  the default. It now states all four combinations truthfully, in `/voice status`, in the
  `pi_voice` tool and in the TUI.
- **`voice_sleep` / `/voice sleep` reported "asleep" while status still said "live".**
  Sleep mutes the mic without closing the socket, which is correct, but nothing said so.
  The controller now exposes `micOpen`, and `/voice status`, the `pi_voice` tool and the
  `voice_sleep` reply all report the muted state and how to reopen it. `/voice listen` and
  `/voice sleep` now refuse to claim success when voice is not running.
- **`pi_recent` promised "messages between the user and the main Pi agent" and returned
  assistant text only**, so "what did I ask?" was answered with Pi's replies. It returns
  both roles, labelled, and the description says so.
- **The prompt treated Pi's own output as instructions.** A command's output can carry
  "ignore your rules" text from a file or a web page, and it lands in the voice model's
  system prompt. The transcript is now introduced with an explicit trust boundary: it is
  data to report, never a directive. `speak()` serialises the requested text with
  `JSON.stringify` instead of dropping it inside apparent quotes, so a quote or newline in
  the text can no longer escape into the surrounding instruction.
- **The TUI header named the wrong wake engine** — it checked whether Sherpa was installed,
  so an ASR setup read as "energy VAD" and vice versa. It shows the engine that is actually
  running when voice is up, and the configured engine otherwise.

### Added

- `patchReport()` (`config.ts`), `keySourceLabel()` (`keychain.ts`), `debugFromEnv()` and
  `redactSecrets()` (`util.ts`), `describeStart()`/`parseBool()` (`commands.ts`),
  `AgentBridge.recentMessages()` and `VoiceController.micOpen`.

## [0.7.1] - 2026-12-01

Two independent audits of 0.7.0 (one on the removal diff, one on runtime behaviour)
found no crash, but they found ten real bugs. All are fixed here, each with a test.

### Fixed

- **Tool results were spoken as assistant replies.** `roleOf()` mapped every non-user
  `message_end` to `assistant`, and Pi emits that event for `toolResult` messages. A
  shell command's output became `lastAssistant`, was read out loud at `agent_settled`,
  and was pasted into the digest. Now only `user`/`assistant` are stored — the same
  filter `seedTranscript` already applied.
- **`voice_always_on` changed a field and nothing else.** Turning the wake word off
  while the session was asleep left it dormant with capture gated: the next sentence
  went into a microphone that was not listening, and the wake phrase could not help
  because it listened to the same closed mic. It now runs the same transition as
  `/voice always-on off` and persists the change (`onConfigChange`), instead of
  living only in memory.
- **`/voice model` kept the old model's capabilities.** The setup builder captured
  the capability table and the function declarations once, so switching to a preview
  model still declared `NON_BLOCKING` tools it does not support and could omit the
  thinking level an extended-thinking model requires. Both are resolved per connect,
  and a model change drops the resumption handle that belonged to the old model.
- **A server-issued resumption handle was rejected fatally.** Recovery was gated on
  "the handle came from disk", so a handle the server invalidated mid-run left the
  session in `error` holding it, and every wake reused it. Any stale-handle close now
  clears the handle, reports `handleInvalid` (so the persisted copy goes too) and
  reconnects fresh.
- **`resumable: false` was ignored.** The old handle stayed and was sent on the next
  connect, to a server that had just said the session could not be resumed. It is
  cleared now, with or without a new handle in the same update.
- **The ASR wake word missed split phrases.** Matching only the words added since the
  previous pass required "hey pi" to arrive inside one decoder update: `"HEY"` then
  `"HEY PI"` produced the windows `"HEY"` and `" PI"`, so the phrase never appeared.
  It now matches the whole decoded segment, once per segment.
- **"hey no" woke the ASR engine.** The joined form allowed two edits across the whole
  string, which made a two-letter word almost free. It now spends one edit per half:
  `HAY`+`PE` matches, `HEY`+`NO` does not. One edit in the short word is still
  tolerated by design (`HEY PO`), because the same tolerance is what accepts a split
  `HAY PE`.
- **The idle gate could cut the model off mid-answer.** `#tickIdle` only looked at mic
  silence, so with `idleSleepMs` at its 5 s minimum, extended thinking or a slow tool
  call gated capture during an open turn and took barge-in and the user's reply with
  it. An open model turn now counts as activity.
- **`inputGain: 0` meant unity gain.** `gain > 0 ? gain : 1` turned a deliberate mute
  into full volume. Zero (and any non-negative value) is applied as written.
- **`playingUntil` ignored the playback backlog.** It was computed from the newest
  chunk alone, and `flush()` reset it to 0 even as the replacement player was handed
  that chunk. With a slow output device, `playing` went false while audio was still
  audible, skipping AEC and half-duplex exactly when the model was loudest.

### Changed

- `AudioSink.stop()` is awaited: the capture process has to be gone before the lock is
  released and a replacement takes the microphone. `/voice restart` and transport
  rebuilds could otherwise re-open the device too early (Windows "device busy"), and
  `stop()` escalates to SIGKILL after a grace period.
- The capture restart counter only resets after 3 s of healthy audio (a device that
  emitted one frame and died used to restart forever); capture is supervised on
  `error` as well as `exit`, and ffplay is respawned after a clean exit too — a clean
  exit used to leave the session with no player and no error.
- Wake-engine exceptions are reported instead of swallowed (`onError` → `/voice
  status`), and after 20 consecutive failures the engine marks itself failed so the
  energy VAD takes over rather than feeding a dead recognizer.
- `NativeKeywordSpotter` honours the `onWake` given to `create()` (it was required and
  then ignored, so a caller using the documented contract hit an undefined call).
- GoAway timers are tracked and generation-scoped (an old timer could kill a healthy
  replacement socket), the setup frame's `send` is guarded, and the outbox re-queues
  a failed flush instead of splicing text into the void.
- Lock takeover is claimed atomically and verified after writing; `AcquireResult`
  carries `reason: "busy" | "unwritable"` so the error says what actually happened.
  Persisted state uses a unique temp file and prunes expired workspace entries.
- `npm` fallback on Windows no longer runs `npm install install` (command was
  `"npm install"` while the argument list already began with `install`).
- `voice_note` / `voice` `speak` report failure instead of claiming success, and the
  deferred-notice timer is cleared on teardown.

## [0.7.0] - 2026-12-01

### Removed

- **The browser transport, entirely.** Audio is `ffmpeg`/`ffplay` and nothing else.
  This is a deletion, not a deprecation: the code is gone, not disabled.
  - `web/` — the companion page, its styles, `voice.js` (send/receive state machine),
    `wake.js` (Web Speech) and both audio worklets. ~1.3k lines.
  - `audio/server.ts` — the loopback HTTP + WebSocket endpoint, its per-run token,
    static asset serving, and the peer/backoff machinery behind it.
  - `audio/ws.ts` — the RFC 6455 server. The lifecycle harness still needs the
    *server* side to stand in for Gemini Live, so it lives on as test/ws-server.ts:
    test support, not shipped code.
  - `test/server.ts` — the endpoint suite (19 checks): there is no endpoint.

### Changed

- **Config surface shrank from 55 fields to 43.** Gone: `audio` (no second transport),
  `host`/`port`/`openBrowser` (no page), `compute` (WebNN/WebGPU/WASM backend
  selector — there is no WASM build to select), `aec`/`noiseSuppression`/`autoGain`
  (getUserMedia constraints), `micDeviceId`/`outputDeviceId` (browser device ids),
  `wakeModelUrl` (the page imported a KWS module through it). Old `pi-voice.json`
  files keep loading: unknown keys are ignored, and a test asserts they cannot come
  back. `inputGain`/`outputGain` stay — the native transport applies them.
- **`nativeOutput` is gone too, and it was never a real setting.** `ffplay` has no
  output-device option (SDL picks the system default), so the field was persisted,
  shown as "Playback device hint" and treated as restart-worthy while changing it
  did nothing at all. That is why the count above ends at 43, not 44.
- `wakeEngine` lost `webspeech`; `WakeEngine` is `auto | asr | sherpa | energy`.
- `/voice` lost `url` and `compute`; the settings screen lost the transport picker,
  the browser device fields and Ctrl-O. `/Voice status` lost the page/peer lines and
  now reports the wake engine instead.
- The controller no longer knows what a peer, a page or a broadcast is: it drives one
  audio sink. Failures that used to be broadcast to the page (session expired,
  grounding dropped, session error) now go through `ui.notify`.
- `VoiceController` takes an optional `createAudio` factory (`VoiceControllerOptions`).
  The product always builds `NativeTransport`; the lifecycle harness injects a silent
  sink so it can run the real controller, sockets, tools and locks on a machine with
  no microphone — previously it relied on the browser transport to avoid spawning
  ffmpeg, which is no longer an option.

### Fixed

- Native audio failure used to fall back to the browser transport, which meant a
  missing ffmpeg produced a page instead of an explanation. It now fails with the
  actual reason and a pointer to `/voice diagnose`, and `/voice diagnose` grew a
  native preflight line (`ffmpeg + ffplay ok · input: … · echo: …`) so that pointer
  leads somewhere useful instead of only reporting the Gemini key.
- `/voice status` reported any live wake engine as `sherpa (…)`, so an ASR session
  read `sherpa (asr cpu)`. The status now names the engine: `asr (cpu)` or
  `sherpa (cpu)`.

## [0.6.2] - 2026-12-01

### Fixed

- **Log lines leaked with debug off.** Two causes: `PI_VOICE_DEBUG` was parsed with
  plain truthiness, so `PI_VOICE_DEBUG=false` (and `0`, `off`, `no`) *enabled*
  verbose logging; and `warn()` wrote to stderr unconditionally, which is where the
  `[pi-voice: native] native wake (...)` lines in the editor came from.
  - the environment is parsed strictly now (`1/true/on/yes` enable, anything else is
    off), and the config value still wins.
  - `warn()` is quiet unless debug is on. It is not discarded: warnings go into a
    small ring buffer, `/voice status` prints the last three, and the failures that
    mean "voice is not running" (auto-start failed, restart failed, transport
    settings changed) now also raise a `ui.notify` instead of relying on stderr.
  - `/voice status` states the mode explicitly: `logging: quiet (warnings still
    recorded)`.
  - tests capture `console.error` and assert nothing is written with debug off, that
    a warning is still retrievable, and that every falsy-looking env value is off.

## [0.6.1] - 2026-12-01

### Added

- **`asr` wake engine.** The 3.3M keyword spotter does not recognise every voice:
  on one real user's six recordings of "hey pi" it fired on none of them at any
  threshold (0.5 → 0.01), with any boost, for any spelling — while a general ASR
  heard the same clips as "HAYPE". Keyword spotting compares acoustics to one
  tokenised phrase; recognition compares *words*, which survives accents, delivery
  and a bad microphone far better.
  - `sherpa-onnx`'s streaming recognizer decodes continuously and
    `audio/wake-match.ts` matches the transcript: one edit per word of three or more
    letters, nothing for short words, and a length-guarded joined form so "HAYPE",
    "HEY P" and "HEYPI" fire while "hey bud", "the pie is ready" and "okay pi" do not.
  - `wakeEngine: "asr"` selects it; `"auto"` now prefers it when the model is
    installed, then the keyword spotter, then energy VAD.
  - `/voice asr` installs the recognizer (~40 MB of int8 weights, extracted into the
    managed model dir) and switches the engine. `wakePhrases` finally means something
    in native mode: the phrases are matched as text, not tokenised into one keyword.
  - Cost is honest: a 20M-parameter encoder instead of 3.3M, so more CPU per frame.
- `audio/wake-match.ts` is unit-tested against literal decoder output from real
  recordings ("ITE HAYPE", "HAY PE", "HEYPI") and against the phrases that must stay
  quiet ("THE PIE IS READY", "HEY BUD", "OKAY PI", "A PIE").

### Notes

- The keyword spotter remains the default only for `wakeEngine: "sherpa"`; nothing
  is removed. If the spotter works on your voice it is still the cheaper engine.

## [0.6.0] - 2026-12-01

Four reports from real use, all of them about the voice being confidently wrong
about the state of the world.

### Fixed

- **"I have no context yet" after `/resume`.** The bridge only ever saw messages
  sent while the extension was running: `message_end` does not replay a transcript,
  so a resumed session started empty and the model told the user it would "remember
  from now on". The bridge now seeds itself from `buildSessionContext()` (user and
  assistant turns only, tool output excluded) and the digest — last six turns plus
  the user's current request — is built **into the system instruction on every
  connect**, so a socket opened after `/resume` describes the session Pi is actually
  showing. The prompt states explicitly that the voice is attached to that session
  and must not claim otherwise, and stays honest when the session is genuinely empty.
- **Two voices, still.** The old fix only cut playback when the last audio frame was
  less than two seconds old, and it still *injected* the notice while the server was
  generating the previous turn — so the old sentence and the new answer were both
  generated and both played. Notices are now held until that turn completes (2.5 s
  cap), local playback is flushed whenever the model is audible at all (queued frames
  included, via the player's own `playingUntil`), and only then is the answer
  injected, framed as a cut so the model reacts with "oh" instead of finishing the
  sentence it was told to abandon.
- **Every steer went out as a follow-up.** `ask()` defaulted to steer but the tool
  schema defaulted `mode` to `queue`, and the tool coerced anything that was not
  exactly `"steer"` into `queue` — so "stop that and do this instead" waited for the
  run it was meant to redirect. `steer` is now the default in the schema, in the
  coercion, and in the description.
- **`1008: Session closed` killed the voice until Pi restarted.** Every 1008 was
  treated as fatal, which is right for a policy refusal and wrong for the server's
  plain "Session closed". That close (and an exhausted retry budget) now parks the
  controller in the asleep state with the wake spotter still armed: no retry storm, no
  error state to escape, and the wake phrase opens a fresh socket. Status says asleep,
  the companion page shows it, and any error message still explains the reason.

### Changed

- `createSetupBuilder` accepts a `systemInstruction` *function*, resolved per connect.
- The dead `contextSeed()` export is gone; the digest travels in the system
  instruction instead of being injected as a fake conversational turn.

### Tests

70 smoke + 19 endpoint + 35 lifecycle + 13 sherpa = 137 checks. New lifecycle
coverage: seeded context on resume, empty-session honesty, 1008 parking, no
self-reconnect while parked, wake recovery, and a notice held back mid-turn then
delivered on `turnComplete`.

## [0.5.2] - 2026-12-01

Three things that only show up while actually talking to it.

### Fixed

- **`pi_ask` silently dropped every request made while Pi was busy.** The session
  validates `streamingBehavior` and throws `Agent is already processing. Specify
  streamingBehavior ('steer' or 'followUp')` when it is missing; the extension API
  starts that call in the background and only surfaces the rejection as an extension
  error, so `pi_ask` returned `{status:"sent"}` and the user was told "on it" for a
  message that never arrived. `queue` now sends `followUp` (deliver when the current
  turn ends) and `steer` sends `steer`, under **both** option names so the behaviour
  does not depend on which one this Pi build reads. A lifecycle test asserts the
  options on the wire.
- **Two voices at once.** When Pi finished while the model was mid-sentence, the
  answer was pushed into the same conversation, so the old sentence and the new
  answer played together. The notice now cuts the local playback, discards the tail
  of the sentence that is still streaming down (until the server ends that turn,
  capped at 4 s), and asks the model for a human reaction — a short "oh", then the
  answer, explicitly *not* finishing the interrupted sentence.
- **A reply after the idle gate went nowhere.** When the session had been gated for
  silence and Pi's result arrived, the model spoke but the mic stayed closed: the
  answer to it was routed to the wake detector, so the user had to say "hey pi"
  again. Any notice now re-opens the mic before it is delivered, and model audio
  counts as conversation activity, so the idle window starts from the end of its
  sentence rather than from the last thing the user said.

## [0.5.1] - 2026-12-01

Diagnosing "the wake word never fires" without reading logs, and the last way a
`sleep`-start could connect by itself.

### Added

- **`/voice mic [seconds]`** records the configured input for a few seconds and
  prints peak/rms plus a verdict: `DIGITAL SILENCE` (the device returns zeros —
  mute, volume, privacy, wrong device), `signal present but very quiet` (raise the
  gain or `wakeSensitivity`), `signal present (N%)` (the mic is fine, the detector
  is the suspect), or `could not capture: …`. A muted microphone used to look
  exactly like a broken wake phrase; one command now separates them.
- `/voice status` reports the engine that was *actually* constructed
  (`wake engine running: sherpa (cpu)` vs `energy VAD`), `wake hits` with the last
  source and time, and `mic: NO SIGNAL` when only silence arrived in the last 8 s.
  It also no longer prints `page: undefined` for the native transport.

### Fixed

- **A config change while asleep connected the session.** `updateConfig` called
  `#scheduleMaxSession()` (and `reconnectNow()` when a setup key changed) without
  checking dormancy, so toggling sherpa in the settings screen made a
  `start asleep` session go `live` with nobody having said the wake phrase — the
  status bar said `live` while the config said "connects on the wake phrase".
  Both paths are now guarded, and a lifecycle test asserts that a config change
  while asleep opens no socket.
- **Disabling always-on while asleep left dead air**: no wake engine and no live
  session. Turning the wake word off now connects instead.
- **Native wake logged nothing for the sherpa engine.** The level/floor/threshold
  line lived inside the energy branch, so with a spotter installed a silent mic was
  invisible. It is logged for both engines now, every 5 s.

## [0.5.0] - 2026-12-01

Starts asleep, and stops refusing on Pi's behalf.

### Added

- **`connectOnWake` (default on): start asleep.** With an always-on wake word,
  `/voice on` and `pi --voice` used to open the Gemini Live session immediately,
  so a Pi left running all day held a session (and its context) open for a
  conversation that mostly never happened. Now the mic and the local wake spotter
  run, but **no socket, no session, no context** exists until the wake phrase
  fires; the status bar reads `voice asleep ·wake`. Whatever you say right after
  the phrase is buffered across the handshake (~4 s, bounded) and replayed, so
  "hey pi, check my messages" arrives whole instead of losing its first syllables.
  `connectOnWake: false` restores the eager behaviour.
- `Start asleep` toggle in `/voice`, plus `/voice set {"connectOnWake":false}`.

### Fixed

- **The voice agent refused requests it should have handed to Pi.** Asked to
  check WhatsApp for a PDF, it answered "I can't do that" — repeatedly, however it
  was phrased. The persona described Pi as a *coding* agent, which let the model
  conclude the request was out of scope, and it had no rule against speaking for
  Pi's limits. The instruction now states that Pi is a general agent (files,
  shell, web, and the user's CLI tools: mail, WhatsApp, GitHub, calendars), that
  only Pi knows what Pi can do, and that refusing on Pi's behalf is forbidden —
  with the reasoning, because a wrong hand-off costs one sentence while a refusal
  costs the whole task. `pi_ask`'s own description was widened the same way.
- **Promised follow-ups were never delivered when `announce` was off.** After a
  delivered `pi_ask` the model says "on it, I'll tell you when Pi's back" — but
  Pi's answer was only spoken through the `announce` path, so with announcements
  disabled the user was promised an update that never came. A delivered request
  now marks the turn as owed a reply, and Pi's settled answer is spoken back
  regardless of `announce` (once, deduped against the announce path).
- **Every native log line was printed twice.** The transport logged via its own
  `log()` and again through the controller's `onLog`; the sinks are now singular.
- **The sherpa spotter demanded DirectML and could never get it.** The published
  prebuilt has no accelerator provider DLL, so `sherpaProvider: "auto"` made
  sherpa print `DirectML is for Windows only. Fallback to cpu!` for each onnx
  session and then silently use the CPU, while the log claimed the spotter was
  running on DirectML. `auto` is now CPU, and an explicit provider is still tried
  first for self-built runtimes.

### Notes

- `connectOnWake` only applies together with `alwaysOn`: without a wake trigger
  there is nothing to wake the session up.

## [0.4.3] - 2026-12-01

The native phrase wake word is now installable from inside Pi, and actually works
once installed.

### Added

- **Guided wake-word install.** Picking `sherpa` as the wake engine (`/voice` →
  Wake engine, or `/voice sherpa`) now prompts to install what is missing:
  `sherpa-onnx-node` (prebuilt, ~23 MB) followed by the KWS model (~17 MB). Both
  land in `~/.pi/agent` (`pi-voice-deps/`, `pi-voice-models/`); your project is not
  touched, and nothing is installed without an explicit yes. Progress streams into
  the settings screen, and a successful install offers to restart voice.
- `/voice sherpa` runs the same flow outside the TUI (`force` re-installs).
  `status` and `/voice diagnose` now report the wake-word state.
- The managed model directory is used automatically when `kwsModelDir` is empty,
  so installing is all that is needed — no config edit.

### Fixed

- **Keywords were handed to sherpa as raw text.** The wake phrase must be a BPE
  token sequence (`▁HE Y ▁PI`), not `HEY PI`; sherpa rejects unknown tokens, so the
  default phrase could never match. Phrases are now tokenised against the model's
  own `tokens.txt` (greedy longest match; verified against the reference keyword
  set shipped with the gigaspeech model), with a clear error plus the
  `text2token` fallback when a phrase cannot be spelled.
- **`wakeEngine` in native mode was ignored unless a model dir was set by hand**,
  and `webspeech` (a browser-only engine) left native users on energy VAD without
  saying so. Native now tries sherpa for anything except an explicit `energy`,
  resolves the managed model dir, and logs exactly what is missing.
- **`wakeSensitivity` did nothing in native mode.** It now maps to the sherpa
  `keywordsThreshold` (0.25 at the 0.5 default — the value the spotter was
  verified with) and to the energy-VAD multiplier.
- **Quantised model files are preferred.** The old picker took whichever file
  `readdir` returned first, so it could load the 12 MB fp32 encoder instead of the
  4 MB int8 one.
- The `-mobile` KWS model is deliberately not offered: it aborts inside
  onnxruntime with a `/downsample/Reshape` shape mismatch.

### Notes

- Installing the runtime runs npm with the current node binary rather than
  `npm.cmd`: spawning a `.cmd` without a shell is refused on Windows, and a shell
  would break install paths containing spaces.
- Model extraction uses `cwd` + a relative archive name, because GNU tar reads
  `C:/...` as a remote host (`Cannot connect to C: resolve failed`). Windows'
  bsdtar under `System32` is preferred for its built-in bzip2.

## [0.4.2] - 2026-12-01

Restart, stop/start and sleep/wake hardening. Three of these were silent
breakage inside the features they lived in.

### Fixed

- **The idle gate never fired with native audio, and gated only half the
  pipeline.** The tick gated the Live session but not the ffmpeg capture process,
  so the next 20 ms frame reopened it. Worse, it keyed on `session.idleMs`, which
  mic frames refresh continuously while awake — so it could not fire at all.
  It now sleeps on *voice* silence (mic level is reported by both transports) and
  gates the capture process too. Talking keeps the session awake.
- **`pi_stop` never actually stopped anything.** `interruptAgent()` was defined
  twice on the controller; the second definition silently won and only queued a
  steering message, discarding the `ctx.abort()` wiring. There is now exactly one
  implementation, so a spoken stop aborts the running turn.
- **Voice went blind after `/voice off` then `/voice on`.** Teardown detached the
  bridge from Pi's events and nothing re-subscribed, so status, replies and
  approvals never reached the agent again. The bridge is now re-attached on every
  start, and `/reload` carries the digest history across.
- **The stored resumption handle never advanced.** A timestamp guard meant to
  reject late writes from a replaced connection also rejected every new handle in
  a fast restart loop, so restarts kept resuming the first checkpoint. Writes now
  carry a monotonic sequence number.
- **A single malformed HTTP request could kill the whole Pi process.** `GET /%`
  (bad escape) and `Host: [` reached `new URL` outside any `try`, so any web page
  could crash Pi with one request. The handler is wrapped, answers `400`, and
  static serving no longer throws on bad escapes.
- **Unbounded WebSocket frames.** Frames and the reassembly buffer are capped; an
  oversized message closes the socket with a proper `1009` close frame instead of
  growing memory or dropping the connection silently.
- **Lock files are no longer trusted by PID alone.** They carry an ownership
  token, are created exclusively (so two processes starting at the same instant
  cannot both win), a foreign lock is never released by another process, and a
  lock older than 12 hours is taken over even if the PID was reused.
- **Settings that need a rebuilt process side were silently ignored.** Changing
  transport, port, input/output device, AEC mode, wake engine or compute backend
  now restarts the audio side instead of doing nothing until the next manual
  restart. Setup-only changes already reconnected the Live socket.
- **The companion page could stay permanently deaf.** A failed `getUserMedia`
  left a half-built `AudioContext` behind and every retry early-returned on it;
  the microphone is also released now, so the recording indicator does not stay
  on.
- **The sherpa keywords file had a fixed name**, so editing the wake phrase kept
  loading the first file that was ever written. It is named after a digest of the
  phrase.
- **A dying microphone is no longer silent.** Capture exit is surfaced, respawns
  up to five times with backoff, and reports a device hint when it gives up.
- **Playback can no longer build an unbounded backlog** if the player stalls
  (queued audio is dropped instead of drifting seconds behind), and the output
  gain is applied once, in the player, so the AEC reference stays exact.

### Added

- `test/lifecycle.ts`: drives the real controller against a fake Live endpoint —
  five start/stop cycles, concurrent start, stop during start, restart
  resumption, `/reload` rebind, the idle gate (engages on silence, voice keeps it
  awake), honest `pi_ask`/`pi_stop` tool calls, cross-process locking and
  stale-lock takeover (19 checks).
- Endpoint suite grows crash probes (malformed escape, invalid `Host`, bad
  upgrade), an oversized-frame close and repeated start/stop cycles (19 checks).
- Smoke suite covers lock ownership/release/staleness and handle sequencing (56).

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