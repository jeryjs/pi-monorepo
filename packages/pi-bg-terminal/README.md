# @jeryjs/pi-bg-terminal

Run long-lived commands and full-screen terminal applications alongside the
[Pi coding agent](https://pi.dev/) without blocking the conversation. Use it for
builds, servers, tests, watchers, REPLs, debuggers, and TUIs.

This is a fork of
[`@99percentpeople/pi-background-tasks`](https://www.npmjs.com/package/@99percentpeople/pi-background-tasks)
(MIT). See [Changes from upstream](#changes-from-upstream) and
[Credits](#credits).

All background behavior is exposed through a **single tool**, `bg_terminal`,
whose `action` parameter selects the operation. `/bg-terminal-attach` opens a live
terminal (`Ctrl+]` detaches without stopping the task).

## Highlights

- Keep Pi responsive while builds, servers, watchers, tests, REPLs, and TUIs run
- One compact `bg_terminal` tool instead of seven separate tool schemas
- Choose lightweight pipe logging or a real PTY with a parsed terminal screen
- Attach and detach without pausing, restarting, or reconnecting the child
- Forward PTY keyboard, mouse, focus, and resize events
- Retain output while detached and replay it before seamlessly following live data
- Track status, duration, and optional output in a compact widget
- Address tasks by stable, unique names as well as generated IDs
- Compose start, wait, read, input, signals, and termination without polling

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Tool reference](#tool-reference)
- [Tool ordering and parallelism](#tool-ordering-and-parallelism)
- [Pipe and PTY modes](#pipe-and-pty-modes)
- [Live attach and final snapshots](#live-attach-and-final-snapshots)
- [Output retention and cleanup](#output-retention-and-cleanup)
- [Sending input and keys](#sending-input-and-keys)
- [Output inspection](#output-inspection)
- [Status widget](#status-widget)
- [Settings](#settings)
- [Shell and platform behavior](#shell-and-platform-behavior)
- [Changes from upstream](#changes-from-upstream)
- [Source layout](#source-layout)
- [Native dependency](#native-dependency)
- [Credits](#credits)

## Install

```bash
pi install npm:@jeryjs/pi-bg-terminal
```

Or install from a local checkout:

```bash
pi install /path/to/pi-bg-terminal
```

PTY mode uses the native `node-pty` dependency; see
[Native dependency](#native-dependency).

## Quick start

Describe the desired outcome naturally:

```text
Run the development server in the background and tell me when it is ready.
Start lazygit in a background PTY named local-git so I can attach to it.
Run the test suite in the background and inspect the failures when it exits.
```

Background execution is appropriate when the user asks for it, the process must
remain available for later interaction, or Pi can perform useful independent
work while it runs. Runtime alone is not a reason to use this tool. If Pi needs
a command's result before it can continue, it should use the foreground `bash`
tool with an appropriate timeout instead of emulating synchronous execution
with `start` → `wait` → `read`.

Users normally need only two interactive commands:

```text
/bg-terminal-attach <task-id>
/bg-terminal-kill <task-id>
```

Omit the task ID to choose from an interactive list. Both commands autocomplete
task IDs and names. Press `Ctrl+]` to leave an attached console without stopping
its task.

## Tool reference

`bg_terminal` takes one required `action`. `id` accepts a task ID or unique
name; omit it for `status` to list every retained task.

| Action | Purpose | Key parameters |
| --- | --- | --- |
| `start` | Run a command detached | `name`, `command`, `cwd`, `mode` (`pipe`/`pty`), `cols`, `rows` |
| `wait` | Block for exit or a matching output line | `id`, `timeout` (default 30s), `pattern` (regex) |
| `status` | Inspect one task, or list all when `id` is omitted | `id` |
| `read` | Page retained output | `id`, `lines` (default 100, max 5000), `offset`, `stream` |
| `send` | Type input or send a signal | `id`, `input` xor `signal` |
| `kill` | Signal a task | `id`, `signal` (default `SIGTERM`) |
| `attach` | Open the live console | `id` |

`start` returns a minimal `id`, `name`, and `status`. `status`, `wait`, `kill`,
and `attach` return one compact summary line per task to keep responses small.
`attach` blocks until you detach, then follows the summary with the last few
output lines and a reminder that `read` can return more.

### `read` pagination

`read` pages like a signed cursor over the retained lines:

- `offset` omitted or `0` returns the tail (the most recent `lines`).
- A positive `offset` skips that many recent lines, paging upward from the end.
- A negative `offset` starts at that line from the top (`-1` is the first line).

A truncated read appends a `[lines A-B of N]` footer so the next page is easy to
request. `stream` selects `stdout`, `stderr`, `both` (default for pipe tasks), or
`terminal` (default for PTY tasks).

## Tool ordering and parallelism

`bg_terminal` calls that target the same task reference in one model response
execute strictly in source order. A reference can be the generated ID or the
unique task name. The `start` action joins the same ordering chain by name, so
the model does not need a separate round to learn the generated ID:

```text
start(name=A) → wait(id=A)                 # start, finish, latest pipe log line
start(name=A) → wait(id=A) → read(id=A)    # add full/multiline or PTY output
status(A)                                  # compact status for one task
send(A) → wait(A) → read(A)                # interact, wait, then read output
kill(A) → read(A)                          # terminate, then read final output
```

The model should emit each complete chain in one response instead of waiting for
one tool result before emitting the next call. Calls for different tasks remain
independent and execute in parallel. Ordering is intentional:
`read(A) → wait(A)` reads available output first and only then waits. A `status`
call without an ID is a global snapshot and is not part of any single-task chain.

## Pipe and PTY modes

| | Pipe mode | PTY mode |
| --- | --- | --- |
| Best for | Builds, servers, scripts, tests, and watchers | TUIs, REPLs, debuggers, and terminal-aware programs |
| Output model | Separate stdout and stderr logs | One terminal screen with ANSI control sequences interpreted |
| Attached view | Combined stdout/stderr in arrival order | Live virtual terminal |
| Direct attached input | Read-only; send stdin through Pi | Keyboard and mouse input are forwarded |
| Resize behavior | Local console reflow only | Debounced terminal and child-process resize |

Pipe mode is the simpler default for commands that only need reliable logs and
needs no pseudo-terminal at runtime. PTY mode sets up a real pseudo-terminal, so
programs can detect terminal capabilities, redraw their screen, request mouse
tracking, and respond to window size changes as they would in a standalone
terminal.

## Live attach and final snapshots

Each task owns a virtual console from the moment it starts. Output is processed
continuously whether attached or not. When `/bg-terminal-attach` (or the `attach` action)
opens the console, it first renders the retained terminal buffer and buffers
only the small amount of output arriving during that replay. The child process is
never paused and its stdout or stderr is never reconnected to the physical
terminal.

For PTY applications, attach forwards keyboard input and terminal resize events.
Extended mouse encodings, including SGR and SGR pixel mode, are restored when
the application enables them. Mouse tracking, encodings, and focus modes are
reset on detach so terminal state does not leak back into Pi.

If a task exits while attached, the console stays open until `Ctrl+]`:

- pipe mode appends a completion message;
- PTY mode overlays the message in the bottom-right corner without changing the
  application's final screen.

The completion message exists only on the user's physical terminal. It is not
written into retained logs, `read` output, or the final virtual-terminal
snapshot. A finished task can be attached again in read-only mode while its
snapshot is still retained.

## Output retention and cleanup

Within the current session, a running task continues across ordinary agent runs
and remains available to `bg_terminal`. Reloading or shutting down the session
terminates running tasks.

If a task finishes before the current agent run settles, its final status and
retained output remain available only for the rest of that run and are normally
removed before the next run starts. Only a task that is still running when the
agent settles and then finishes while the agent is idle remains available
throughout the next agent run. It can be inspected multiple times during that
run and is normally removed before the following run.

Once removed, the old task ID is no longer available through attach, status,
read, or wait operations. Task names must be unique (case-insensitively) among
all retained running and finished tasks; a name becomes available again when its
old task is removed by this cleanup lifecycle. Completed snapshots are
checkpointed as hidden Pi session entries, so reloading the extension or
navigating the session tree does not clear them early. Cleanup writes a matching
session event, so an expired snapshot cannot reappear after another reload.

Live pipe stdout and stderr remain in memory and are capped at 4 MiB each, with
the oldest bytes discarded when that limit is reached. A persisted pipe snapshot
keeps the latest 500 lines, capped at 256 KiB per stream. The attached console
snapshot keeps 200 lines of scrollback and is capped at 512 KiB. No task output
is written to a temporary disk directory. This is not persistent job management:
reload restores only completed read-only snapshots, while session shutdown still
terminates running processes and disposes live virtual terminals so it does not
leave orphaned tasks.

## Sending input and keys

Pi can send ordinary text, terminal keys, or signals without opening an attached
console in either mode. Text is exact and never implies Enter. Special keys use
`<...>` tokens:

```text
<C-o>filename.txt<Enter>
<Esc>iHello<Enter>
<Down*3><Enter>
```

The input syntax supports Ctrl+A-Z and Ctrl punctuation, Alt/Meta combinations,
arrows, navigation keys, Insert/Delete, F1-F12, Space, Enter, Escape, Tab, and
Backspace. Modifiers can be combined, such as `<C-A-d>` or `<S-A-Left>`, and key
repetition uses forms such as `<Down*3>`. Use `\<` for a literal `<` and `\\`
for a literal backslash. For a pipe task, `input=<C-d>` or `input=<EOF>` closes
stdin.

Pipe attachments do not forward keyboard input directly, but Pi can still send
stdin through `send`. PTY attachments forward input interactively and the same
key syntax remains available for model-driven input.

The `signal` parameter accepts a portable named-signal vocabulary such as
`SIGTERM`, `SIGINT`, or `SIGKILL`, and validates each request against the task's
actual execution environment. Local Unix tasks use their process group. Signal
behavior remains platform-specific, and unsupported requests return an explicit
error. Use `kill` when the goal is reliable process-tree termination.

## Output inspection

For pipe tasks, `wait` and `status` include the latest non-empty log line and
identify whether it came from stdout or stderr. The same value is available as
`latestLog` in tool details; a status list includes it per task. They omit the
field when no pipe output is available and never expose a PTY terminal snapshot.

Use `read` when one latest line is insufficient or any PTY output is needed.
Pipe tasks retain stdout and stderr separately, while PTY tasks expose the parsed
terminal buffer rather than raw ANSI escape sequences. Omitting `stream` works
in both modes: pipe tasks return stdout and stderr, and PTY tasks return terminal
output. Use `lines` with `offset` to page the retained range. An empty running
task reports `(no output yet)`; once it finishes, the same empty log is reported
as `(no output)` (or `(no terminal output)` for PTY mode).

`kill` returns termination status only. Emit `read` after `wait`, `status`, or
`kill` when fuller pipe output or PTY terminal output is needed.

## Status widget

Pi displays background tasks below the editor with their status, duration, and
optional latest pipe output. The collapsed widget shows only the task totals by
default, or it can show 1, 3, or 5 prioritized task rows. Running tasks are
selected before the most recently finished tasks while preserving task order.
Pi's standard tool expansion shortcut (`Ctrl+O` by default) reveals the complete
task list. Finished PTY tasks stay compact because their final screen remains
available through attach or explicit `read` output.

The header uses separate colors for the total, running, and finished counts so
active work stands out without making the whole widget look like a warning.
Running durations and recent output refresh without repeatedly registering a new
widget.

## Settings

Settings are self-contained: the extension reads and writes its own file at
`<pi agent dir>/pi-bg-terminal.json` (normally `~/.pi/agent/pi-bg-terminal.json`,
namespace `background-tasks`) and does not depend on any shared settings
package. Open the menu with:

```text
/bg-terminal-settings
```

The menu mirrors Pi's own `/settings` screen: a themed, searchable list between
dynamic borders. Move with the arrow keys, press `Enter` or `Space` to cycle a
value, and press `Esc` to close. Two options are available:

- **Collapsed tasks** — how many task rows the widget shows before it is
  expanded (`Summary only`, `1`, `3`, or `5`; any value from 0 to 10).
- **Output preview** — which pipe-task rows include their latest output
  (`Off`, `Failures`, `Finished`, or `All pipe tasks`).

Changes apply immediately. Operational commands such as `/bg-terminal-attach`
and `/bg-terminal-kill` remain separate from settings.

## Shell and platform behavior

Background commands follow Pi's configured Bash resolution and command prefix,
so they use the same syntax as the built-in `bash` tool. On Windows this means
Pi's configured `shellPath`, Git Bash, or a `bash.exe` found on `PATH`, rather
than `cmd.exe`.

Installing `@99percentpeople/pi-pwsh-adapter` explicitly switches both Pi's
built-in shell tool and background tasks to PowerShell syntax.

Shell providers can override how commands are launched. A provider is queried by
descending priority and falls through when its resolver returns `undefined`;
throwing fails closed. The resolved launch carries the immutable task
environment label shown in `bg_terminal` results, so a task stays bound to the
location where it started even if the active workspace changes.

Every `bg_terminal` action returns the task environment label in its task
information, and finished snapshots retain it across extension reloads.

### Shell adapter protocol v2

Shell adapters can register independently instead of competing through
last-writer-wins state:

```ts
pi.events.emit("bg:register", {
  id: "my-adapter",
  priority: 50,
  resolveShell,
  spawn,       // optional, scoped to this provider
  ptySpawn,    // optional, scoped to this provider
  onRegistered: ({ protocolVersion, taskControl }) => {},
});
```

For each launch, an adapter may return `control` alongside `file`, `args`, and
`env`. A control must implement async `sendSignal`, `probe`, `onTransportExit`,
and `dispose`; it may also declare `supportedSignals`, `terminatingSignals`, the
signal target (`process`, `process group`, or `process tree`), and stdin
availability. Signals receive the tool's `AbortSignal`. The control remains
bound to the task after its local launcher exits, allowing cleanup without
mistaking transport termination for process termination.

Every registration requires an `id` and `resolveShell`; unnamed v1 registrations
are rejected. Providers can unregister with
`pi.events.emit("bg:unregister", { id })`. If an adapter cannot confirm cleanup
after its local transport disappears, the task enters `disconnected`: retained
logs remain readable and adapter signals can be retried, but stdin is
unavailable until the task is terminated or confirmed finished.

## Changes from upstream

This fork keeps the upstream runtime intact — process-tree cleanup on shutdown
(including Windows `taskkill /T`), PTY + headless xterm formatting, the bounded
in-memory log store, the status widget, `/bg-terminal-attach` and `/bg-terminal-kill`, and
same-task ordering — and changes the model-facing surface:

- **One tool instead of seven.** Upstream registered `bg_start`, `bg_wait`,
  `bg_status`, `bg_logs`, `bg_send`, and `bg_kill` as separate model-facing
  tools. This fork registers a single `bg_terminal` tool with
  `action = start | wait | status | read | send | kill | attach`.
- **Smaller prompt surface.** The compact schema, description, and guidelines
  cost roughly 700 tokens, well under the ~3,000+ tokens the separate tool
  schemas used.
- **`read` replaces `bg_logs`.** It adds `lines` (default 100, max 5000) and
  `offset` pagination with a `[lines A-B of N]` footer, and keeps `stream`
  selection.
- **`attach` is now model-facing.** Upstream exposed attachment only through its
  `/bg-attach` command; the same console is now reachable with
  `bg_terminal action=attach` as well.
- **`wait` supports a regex `pattern`** and defaults to 30 seconds (upstream
  defaulted to 300).
- **Compact outputs.** `start` returns a minimal `id`/`name`/`status` line, and
  `status`, `wait`, `kill`, and `attach` return a single summary line, keeping
  conversation turns small.
- **Runtime-validated signals.** `signal` is a plain string validated at
  runtime rather than an enum of 34 names in the schema.
- **Self-contained settings.** Removed the
  `@99percentpeople/pi-shared-settings` dependency. Configuration now lives in
  `<pi agent dir>/pi-bg-terminal.json` and is edited with the extension's own
  `/bg-terminal-settings` command instead of a shared `/99settings` menu.
- **Prefixed commands.** The interactive commands were renamed
  `/bg-attach` → `/bg-terminal-attach`, `/bg-kill` → `/bg-terminal-kill`, and
  the new settings menu is `/bg-terminal-settings`.
- **Package identity.** Renamed to `@jeryjs/pi-bg-terminal` at version `3.0.0`.
  Install and update commands must use the new name.

If existing prompts or automations call `bg_start`, `bg_wait`, `bg_status`,
`bg_logs`, `bg_send`, or `bg_kill`, replace them with `bg_terminal` and the
matching `action`.

## Source layout

The extension source is split by responsibility while keeping `index.ts` as the
small public entry point:

- `extension.ts` wires lifecycle events, settings, tools, and commands
- `runtime.ts` owns task state, shell providers, process control, logs, and snapshots
- `tools.ts` and `commands.ts` register the model-facing and interactive APIs
- `attachment.ts` handles live/final terminal attachment
- `widget.ts` renders and refreshes task status
- `input.ts` parses model-driven text and terminal key sequences
- `types.ts` and `memory-log-store.ts` contain shared contracts and storage

The published extension loads a single bundled entry point, so the individual
implementation files are not required at runtime.

## Native dependency

PTY support uses `node-pty`. If a compatible prebuilt binary is unavailable,
installation may require Python and a native C/C++ build toolchain. On macOS
this generally means Xcode command-line tools; Windows builds may require Visual
Studio C++ and the Windows SDK. Pipe mode does not require a pseudo-terminal at
runtime, but `node-pty` is still installed as a package dependency.

## Credits

This project is a fork of
[`@99percentpeople/pi-background-tasks`](https://www.npmjs.com/package/@99percentpeople/pi-background-tasks)
by 99percentpeople / Zach Yuen, used under the MIT License. The runtime,
attachment, widget, and settings implementation originate there. The settings
store and menu from upstream's shared-settings package were replaced with a
small self-contained implementation in this fork.

## License

MIT. See [LICENSE](./LICENSE).
