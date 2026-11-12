import { spawn } from "node:child_process";
import {
  keyText,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import type * as NodePty from "node-pty";
import { MAX_INPUT_BYTES, parseInput, type ParsedInput } from "./input.ts";
import { loadNodePty } from "./runtime-dependencies.ts";
import { attachTask } from "./attachment.ts";
import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  closeTaskInput,
  createConsoleSession,
  emptyOutputMessage,
  findTaskByReference,
  flushConsole,
  formatDuration,
  formatElapsedSeconds,
  generateId,
  getTerminalSnapshotLines,
  isTaskControllable,
  normalizeTaskEnvironment,
  normalizeTaskName,
  persistFinishedTaskSnapshot,
  readLogLines,
  recordPipeData,
  recordPtyData,
  renderTaskCallLabel,
  resolveShell,
  runningTasks,
  sendProcessSignal,
  settleDisconnectedTaskAfterSignal,
  settleTaskTransportExit,
  takeNextTaskOrder,
  taskControlFromLaunch,
  taskEnvironmentDetails,
  taskEnvironmentSuffix,
  taskLatestPipeLog,
  taskLogKey,
  tasks,
  terminalIO,
  throwIfAborted,
  truncateText,
  waitForOrderedToolCall,
  waitForTaskEnd,
  waitUntilAllowed,
  withTaskEnvironment,
  writeTaskInput,
} from "./runtime.ts";
import type {
  BackgroundProcess,
  BackgroundSignal,
  BackgroundTasksExtensionDependencies,
  BgTask,
  BgWaitRenderState,
} from "./types.ts";
import { setWidgetContext, updateWidget } from "./widget.ts";

const BG_ACTIONS = ["start", "wait", "status", "read", "send", "kill", "attach"] as const;
type BgAction = (typeof BG_ACTIONS)[number];

const DEFAULT_WAIT_TIMEOUT_SECONDS = 30;
const MAX_WAIT_TIMEOUT_SECONDS = 3600;
const DEFAULT_READ_LINES = 100;
const MAX_READ_LINES = 5000;
const WAIT_POLL_INTERVAL_MS = 200;
const MAX_SUMMARY_DETAIL_CHARS = 80;
const MAX_MATCH_CHARS = 240;
const ATTACH_EXCERPT_LINES = 10;

const bgTerminalParameters = Type.Object({
  action: Type.Unsafe<BgAction>(StringEnum([...BG_ACTIONS], { description: "Operation to perform" })),
  id: Type.Optional(Type.String({ description: "Task ID or unique name; omit for status to list all" })),
  name: Type.Optional(Type.String({ description: "start: unique task name", minLength: 1 })),
  command: Type.Optional(Type.String({ description: "start: command to run" })),
  cwd: Type.Optional(Type.String({ description: "start: working directory" })),
  mode: Type.Optional(
    Type.Unsafe<"pipe" | "pty">(StringEnum(["pipe", "pty"] as const, {
      description: "start: pipe (default) or pty (TUIs)",
    })),
  ),
  cols: Type.Optional(Type.Number({
    description: "start pty: columns (default 120)",
    minimum: MIN_TERMINAL_COLS,
    maximum: MAX_TERMINAL_COLS,
  })),
  rows: Type.Optional(Type.Number({
    description: "start pty: rows (default 30)",
    minimum: MIN_TERMINAL_ROWS,
    maximum: MAX_TERMINAL_ROWS,
  })),
  timeout: Type.Optional(Type.Number({
    description: `wait: max seconds (default ${DEFAULT_WAIT_TIMEOUT_SECONDS})`,
    minimum: 1,
    maximum: MAX_WAIT_TIMEOUT_SECONDS,
  })),
  pattern: Type.Optional(Type.String({
    description: "wait: regex on output; returns early on match",
  })),
  input: Type.Optional(Type.String({
    description: "send: exact text, no Enter implied; append <Enter> to submit and use <...> key tokens, e.g. \"y<Enter>\", \"<Down*3><Enter>\", \"<C-d>\"",
    minLength: 1,
    maxLength: MAX_INPUT_BYTES,
  })),
  signal: Type.Optional(Type.String({
    description: "send/kill: OS signal, e.g. SIGTERM/SIGINT/SIGKILL (kill default SIGTERM); validated at runtime",
  })),
  lines: Type.Optional(Type.Number({
    description: `read: lines to return (default ${DEFAULT_READ_LINES}, max ${MAX_READ_LINES})`,
    minimum: 1,
    maximum: MAX_READ_LINES,
  })),
  offset: Type.Optional(Type.Number({
    description: "read: 0/omitted=tail, positive=skip back N, negative=start at line N from top (-1=first)",
  })),
  stream: Type.Optional(
    Type.Unsafe<"stdout" | "stderr" | "both" | "terminal">(StringEnum(["stdout", "stderr", "both", "terminal"] as const, {
      description: "read: stdout, stderr, both (default), terminal (pty)",
    })),
  ),
});

type BgTerminalParams = Static<typeof bgTerminalParameters>;

interface LineWindow {
  lines: string[];
  start: number;
  total: number;
}

/** Window a retained log by line count and a bottom-anchored or top-anchored offset. */
function selectWindow(all: string[], count: number, offset: number): LineWindow {
  const total = all.length;
  let start: number;
  let end: number;
  if (offset < 0) {
    // Negative offsets anchor to the top: -1 is the first line.
    start = Math.min(total, -offset - 1);
    end = Math.min(total, start + count);
  } else if (offset > 0) {
    // Positive offsets page upward from the end: skip `offset` recent lines.
    end = Math.max(0, total - offset);
    start = Math.max(0, end - count);
  } else {
    start = Math.max(0, total - count);
    end = total;
  }
  return { lines: all.slice(start, end), start, total };
}

function paginationNote(window: LineWindow): string {
  return window.total > window.lines.length
    ? `\n[lines ${window.start + 1}-${window.start + window.lines.length} of ${window.total}]`
    : "";
}

/** Compact one-line task summary used by status/wait/kill/attach outputs. */
function taskSummary(task: BgTask): string {
  const duration = task.endedAt !== null
    ? formatDuration(task.endedAt - task.startedAt)
    : formatDuration(Date.now() - task.startedAt);
  const detail = task.statusDetail
    ? ` (${truncateText(task.statusDetail, MAX_SUMMARY_DETAIL_CHARS)})`
    : "";
  const exit = task.exitCode !== null ? ` exit=${task.exitCode}` : "";
  return `[${task.id}] ${task.name} ${task.status}${detail}${exit} ${duration}${taskEnvironmentSuffix(task)}`;
}

function clampReadLines(value: unknown): number {
  const requested = typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : DEFAULT_READ_LINES;
  return Math.min(MAX_READ_LINES, Math.max(1, requested));
}

function clampOffset(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
}

/** All searchable output lines for a task, regardless of pipe or PTY mode. */
function taskOutputLines(task: BgTask): string[] {
  if (task.mode === "pty") return getTerminalSnapshotLines(task);
  return [...readLogLines(task.stdoutLogKey), ...readLogLines(task.stderrLogKey)];
}

interface OutputExcerpt {
  label: string;
  lines: string[];
}

/**
 * Latest output lines per stream, used to show what happened around the moment
 * an attached console was closed. Combine with flushConsole() first for PTY.
 */
function recentTaskOutputExcerpts(task: BgTask, maxLines: number): OutputExcerpt[] {
  if (task.mode === "pty") {
    const lines = getTerminalSnapshotLines(task).slice(-maxLines);
    return lines.length > 0 ? [{ label: "terminal", lines }] : [];
  }
  const excerpts: OutputExcerpt[] = [];
  const stdout = readLogLines(task.stdoutLogKey).slice(-maxLines);
  if (stdout.length > 0) excerpts.push({ label: "stdout", lines: stdout });
  const stderr = readLogLines(task.stderrLogKey).slice(-maxLines);
  if (stderr.length > 0) excerpts.push({ label: "stderr", lines: stderr });
  return excerpts;
}

function findPatternMatch(lines: string[], pattern: RegExp): string | undefined {
  if (!pattern.test(lines.join("\n"))) return undefined;
  return lines.findLast((line) => pattern.test(line)) ?? "";
}

function asSignal(value: unknown): BackgroundSignal | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().toUpperCase() as BackgroundSignal
    : undefined;
}

export function registerBackgroundTaskTools(
  pi: ExtensionAPI,
  dependencies: BackgroundTasksExtensionDependencies,
): void {
  const requireTask = (reference: string | undefined, action: BgAction): BgTask => {
    const id = reference?.trim();
    if (!id) throw new Error(`bg_terminal action=${action} requires id.`);
    const task = findTaskByReference(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  };

  const mustWaitForPredecessor = async (
    toolCallId: string,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    const predecessor = waitForOrderedToolCall(toolCallId, signal);
    if (predecessor) await predecessor;
  };

  const startTask = async (
    params: BgTerminalParams,
    ctx: ExtensionToolContext,
  ): Promise<AgentToolResult<Record<string, unknown>>> => {
    const name = normalizeTaskName(params.name ?? "");
    if (!name) throw new Error("bg_terminal action=start requires name.");
    const command = params.command?.trim() ? params.command : "";
    if (!command) throw new Error("bg_terminal action=start requires command.");
    const duplicate = findTaskByReference(name);
    if (duplicate) {
      throw new Error(
        `Background task name "${name}" is already in use by task ${duplicate.id} (${duplicate.status}) or conflicts with its ID.`
        + " Choose a unique name that is not another task's ID.",
      );
    }

    const id = generateId();
    const stdoutLogKey = taskLogKey(id, "stdout");
    const stderrLogKey = taskLogKey(id, "stderr");
    const mode = params.mode === "pty" ? "pty" : "pipe";
    const cwd = params.cwd || ctx.cwd;
    const shell = resolveShell(command, mode === "pty", {
      cwd,
      projectTrusted: ctx.isProjectTrusted(),
    });
    const launchCwd = shell.cwd ?? cwd;
    const taskControl = taskControlFromLaunch(shell);
    const cols = Math.min(MAX_TERMINAL_COLS, Math.max(
      MIN_TERMINAL_COLS,
      Math.floor(params.cols ?? terminalIO.output.columns ?? 120),
    ));
    const rows = Math.min(MAX_TERMINAL_ROWS, Math.max(
      MIN_TERMINAL_ROWS,
      Math.floor(params.rows ?? terminalIO.output.rows ?? 30),
    ));
    let taskProcess: BackgroundProcess;
    const console = createConsoleSession(cols, rows, mode);

    try {
      if (mode === "pty") {
        const ptyProcess: NodePty.IPty = (shell.ptySpawnProcess ?? dependencies.ptySpawnProcess ?? loadNodePty().spawn)(shell.file, shell.args, {
          name: shell.env.TERM || "xterm-256color",
          cols,
          rows,
          cwd: launchCwd,
          env: { ...shell.env, TERM: shell.env.TERM || "xterm-256color" },
        });
        taskProcess = { kind: "pty", pid: ptyProcess.pid, pty: ptyProcess };
      } else {
        const child = (shell.spawnProcess ?? dependencies.spawnProcess ?? spawn)(shell.file, shell.args, {
          cwd: launchCwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: shell.env,
          detached: process.platform !== "win32",
        });
        taskProcess = { kind: "pipe", pid: child.pid ?? 0, child };
      }
    } catch (error) {
      console.terminal.dispose();
      if (taskControl) await taskControl.dispose();
      throw error;
    }

    const task: BgTask = {
      id, name, command, mode,
      environment: normalizeTaskEnvironment(shell.taskEnvironment),
      process: taskProcess,
      control: taskControl,
      controlDisposed: false,
      transportExitPending: null,
      console,
      attachment: {},
      status: "running",
      statusDetail: null,
      exitCode: null, signal: null,
      order: takeNextTaskOrder(),
      startedAt: Date.now(), endedAt: null,
      stdoutLogKey, stderrLogKey, stdoutLines: 0, stderrLines: 0,
      done: new AbortController(),
      latestLog: null,
      retainForNextAgentTurn: false,
      stdoutPending: "", stderrPending: "",
      requestedStopSignal: null,
    };
    tasks.set(id, task);
    runningTasks.add(task);

    if (taskProcess.kind === "pty") {
      taskProcess.pty.onData((data) => recordPtyData(task, data));
      taskProcess.pty.onExit(({ exitCode, signal }) => {
        settleTaskTransportExit(task, exitCode, signal ? `signal ${signal}` : null);
      });
    } else {
      const child = taskProcess.child;
      let outputRevision = 0;
      child.stdout?.on("data", (d: Buffer) => {
        outputRevision += 1;
        recordPipeData(task, "stdout", d);
      });
      child.stderr?.on("data", (d: Buffer) => {
        outputRevision += 1;
        recordPipeData(task, "stderr", d);
      });
      let spawned = false;
      child.once("spawn", () => {
        spawned = true;
      });
      child.once("error", (err) => {
        const errorLine = `[error: ${err.message}]`;
        recordPipeData(task, "stderr", Buffer.from(`\n${errorLine}\n`));
        // A launch failure emits `error` and `close`, but never `exit`.
        if (!spawned) settleTaskTransportExit(task, null, null, true);
      });
      let outputRevisionAtExit: number | null = null;
      // Process state follows `exit` only. On Windows, inherited stdio handles can
      // keep `close` pending long after this PID no longer exists.
      child.once("exit", (code, signal) => {
        outputRevisionAtExit = outputRevision;
        settleTaskTransportExit(task, code, signal);
      });
      // `close` is an I/O lifecycle event. If more output arrived after `exit`,
      // update the snapshot without adding a redundant entry for the normal case.
      child.once("close", () => {
        if (
          task.status !== "running" &&
          outputRevisionAtExit !== null &&
          outputRevision !== outputRevisionAtExit
        ) {
          void persistFinishedTaskSnapshot(task).catch(() => {});
        }
      });
      if (shell.initialStdin !== undefined) {
        child.stdin?.end(shell.initialStdin);
      }
    }

    setWidgetContext(ctx);
    updateWidget();

    return {
      content: [{ type: "text", text: taskSummary(task) }],
      details: {
        id,
        name,
        status: task.status,
        command,
        pid: taskProcess.pid,
        mode,
        cols: mode === "pty" ? cols : undefined,
        rows: mode === "pty" ? rows : undefined,
        ...taskEnvironmentDetails(task),
      },
    };
  };

  const waitTask = async (
    params: BgTerminalParams,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<Record<string, unknown>> | undefined,
  ): Promise<AgentToolResult<Record<string, unknown>>> => {
    const task = requireTask(params.id, "wait");
    const timeoutSeconds = typeof params.timeout === "number"
      ? Math.min(MAX_WAIT_TIMEOUT_SECONDS, Math.max(1, params.timeout))
      : DEFAULT_WAIT_TIMEOUT_SECONDS;
    const timeoutMs = timeoutSeconds * 1000;
    let pattern: RegExp | undefined;
    if (params.pattern) {
      try {
        pattern = new RegExp(params.pattern);
      } catch (error) {
        throw new Error(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const deadline = Date.now() + timeoutMs;
    let timedOut = false;
    let match: string | undefined;
    if (task.status === "running") {
      onUpdate?.({
        content: [],
        details: {
          id: task.id,
          name: task.name,
          status: task.status,
          ...taskEnvironmentDetails(task),
        },
      });
      if (pattern) {
        while (true) {
          if (task.mode === "pty") await flushConsole(task);
          match = findPatternMatch(taskOutputLines(task), pattern);
          if (match !== undefined || task.status !== "running") break;
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            timedOut = true;
            break;
          }
          await waitUntilAllowed(Math.min(remaining, WAIT_POLL_INTERVAL_MS), [task.done.signal], signal);
        }
      } else {
        await waitUntilAllowed(timeoutMs, [task.done.signal], signal);
        timedOut = task.status === "running";
      }
    }
    await flushConsole(task);

    const lines = [taskSummary(task)];
    if (timedOut) lines[0] = `${lines[0]} (wait timeout ${timeoutSeconds}s; task still running)`;
    if (match !== undefined) {
      lines.push(`match: ${truncateText(match, MAX_MATCH_CHARS)}`);
    } else {
      const latest = taskLatestPipeLog(task);
      if (latest) lines.push(`latest: [${latest.stream}] ${latest.text}`);
      if (task.statusDetail && !timedOut) lines.push(`detail: ${task.statusDetail}`);
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: {
        id: task.id,
        name: task.name,
        status: task.status,
        mode: task.mode,
        timedOut,
        exitCode: task.exitCode,
        signal: task.signal,
        statusDetail: task.statusDetail ?? undefined,
        ...(match !== undefined ? { matched: true } : {}),
        ...taskEnvironmentDetails(task),
      },
    };
  };

  const statusTask = async (
    params: BgTerminalParams,
    signal: AbortSignal | undefined,
  ): Promise<AgentToolResult<Record<string, unknown>>> => {
    const reference = params.id?.trim() ? params.id : undefined;
    if (!reference) {
      const entries = Array.from(tasks.values());
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No background tasks." }], details: { tasks: [] } };
      }
      return {
        content: [{ type: "text", text: entries.map(taskSummary).join("\n") }],
        details: {
          tasks: entries.map((task) => {
            const latestLog = taskLatestPipeLog(task);
            return {
              id: task.id,
              name: task.name,
              status: task.status,
              mode: task.mode,
              exitCode: task.exitCode,
              duration: task.endedAt !== null ? task.endedAt - task.startedAt : Date.now() - task.startedAt,
              ...(latestLog ? { latestLog } : {}),
              ...taskEnvironmentDetails(task),
            };
          }),
        },
      };
    }

    const task = requireTask(reference, "status");
    await settleDisconnectedTaskAfterSignal(task, signal).catch(() => {});
    return {
      content: [{ type: "text", text: taskSummary(task) }],
      details: {
        id: task.id,
        name: task.name,
        status: task.status,
        mode: task.mode,
        exitCode: task.exitCode,
        signal: task.signal,
        pid: task.process?.pid,
        statusDetail: task.statusDetail ?? undefined,
        ...taskEnvironmentDetails(task),
      },
    };
  };

  const readTask = async (
    params: BgTerminalParams,
  ): Promise<AgentToolResult<Record<string, unknown>>> => {
    const task = requireTask(params.id, "read");
    const count = clampReadLines(params.lines);
    const offset = clampOffset(params.offset);
    const stream = params.stream;

    if (task.mode === "pty") {
      if (stream === "stdout" || stream === "stderr") {
        return {
          content: [{ type: "text", text: withTaskEnvironment(task, "(PTY output combines stdout and stderr; use stream=terminal)") }],
          details: { id: task.id, name: task.name, status: task.status, mode: task.mode, ...taskEnvironmentDetails(task) },
        };
      }
      await flushConsole(task);
      const window = selectWindow(getTerminalSnapshotLines(task), count, offset);
      const body = window.lines.length ? window.lines.join("\n") : emptyOutputMessage(task, "terminal output");
      return {
        content: [{ type: "text", text: withTaskEnvironment(task, `── terminal ──\n${body}${paginationNote(window)}`) }],
        details: {
          id: task.id,
          name: task.name,
          status: task.status,
          mode: task.mode,
          lines: window.lines.length,
          totalLines: window.total,
          cols: task.console.terminal.cols,
          rows: task.console.terminal.rows,
          ...taskEnvironmentDetails(task),
        },
      };
    }

    if (stream === "terminal") {
      return {
        content: [{ type: "text", text: withTaskEnvironment(task, "(terminal output is only available for PTY tasks)") }],
        details: { id: task.id, name: task.name, status: task.status, mode: task.mode, ...taskEnvironmentDetails(task) },
      };
    }

    const sections: string[] = [];
    const includeStdout = stream === undefined || stream === "stdout" || stream === "both";
    const includeStderr = stream === undefined || stream === "stderr" || stream === "both";
    if (includeStdout) {
      const window = selectWindow(readLogLines(task.stdoutLogKey), count, offset);
      if (window.lines.length) {
        sections.push(`── stdout ──\n${window.lines.join("\n")}${paginationNote(window)}`);
      } else if (stream === "stdout") {
        sections.push("(no stdout)");
      }
    }
    if (includeStderr) {
      const window = selectWindow(readLogLines(task.stderrLogKey), count, offset);
      if (window.lines.length) {
        sections.push(`── stderr ──\n${window.lines.join("\n")}${paginationNote(window)}`);
      } else if (stream === "stderr") {
        sections.push("(no stderr)");
      }
    }
    if (sections.length === 0) sections.push(emptyOutputMessage(task, "output"));

    return {
      content: [{ type: "text", text: withTaskEnvironment(task, sections.join("\n")) }],
      details: {
        id: task.id,
        name: task.name,
        status: task.status,
        mode: task.mode,
        stdoutLines: task.stdoutLines,
        stderrLines: task.stderrLines,
        ...taskEnvironmentDetails(task),
      },
    };
  };

  const DEFAULT_TERMINATING_SIGNALS = new Set<BackgroundSignal>([
    "SIGABRT", "SIGHUP", "SIGINT", "SIGKILL", "SIGQUIT", "SIGTERM",
  ]);
  const signalClassifiesStop = (task: BgTask, signal: BackgroundSignal): boolean =>
    task.control?.terminatingSignals
      ? task.control.terminatingSignals.includes(signal)
      : DEFAULT_TERMINATING_SIGNALS.has(signal);

  const sendTask = async (
    params: BgTerminalParams,
    abortSignal: AbortSignal | undefined,
  ): Promise<AgentToolResult<Record<string, unknown>>> => {
    const task = requireTask(params.id, "send");
    await task.transportExitPending?.catch(() => {});

    const input = params.input;
    const signal = asSignal(params.signal);
    if ((input === undefined) === (signal === undefined)) {
      throw new Error("bg_terminal action=send requires exactly one of input or signal.");
    }

    if (signal) {
      if (!isTaskControllable(task)) {
        return {
          content: [{ type: "text", text: `[${task.id}] ${task.name} ${task.status}: not controllable.` }],
          details: { id: task.id, name: task.name, status: task.status, ...taskEnvironmentDetails(task) },
        };
      }
      const previousStopSignal = task.requestedStopSignal;
      const target = task.control?.signalTarget ?? "process group";
      if (signalClassifiesStop(task, signal)) task.requestedStopSignal = signal;
      try {
        await sendProcessSignal(task, signal, false, abortSignal);
        await settleDisconnectedTaskAfterSignal(task, abortSignal);
        return {
          content: [{ type: "text", text: `[${task.id}] ${task.name}: sent ${signal} to ${target}${taskEnvironmentSuffix(task)}.` }],
          details: { id: task.id, name: task.name, signal, ...taskEnvironmentDetails(task) },
        };
      } catch (err) {
        task.requestedStopSignal = previousStopSignal;
        throwIfAborted(abortSignal);
        return {
          content: [{ type: "text", text: `[${task.id}] ${task.name}: failed to send ${signal}${taskEnvironmentSuffix(task)}: ${err instanceof Error ? err.message : String(err)}` }],
          details: { id: task.id, name: task.name, ...taskEnvironmentDetails(task) },
        };
      }
    }

    if (task.status !== "running" || !task.process || task.control?.stdinAvailable === false) {
      const reason = task.status === "disconnected"
        ? "transport is disconnected; only adapter signals remain available"
        : task.control?.stdinAvailable === false
          ? "stdin is unavailable for this adapter launch; use PTY mode for interactive input"
          : "is not running";
      return {
        content: [{ type: "text", text: `[${task.id}] ${task.name} ${reason}.` }],
        details: { id: task.id, name: task.name, status: task.status, ...taskEnvironmentDetails(task) },
      };
    }

    let parsed: ParsedInput;
    try {
      parsed = parseInput(task, input ?? "");
    } catch (err) {
      return {
        content: [{ type: "text", text: `[${task.id}] ${task.name}: ${err instanceof Error ? err.message : String(err)}` }],
        details: { id: task.id, name: task.name, ...taskEnvironmentDetails(task) },
      };
    }

    if (parsed.eof) {
      closeTaskInput(task);
      return {
        content: [{ type: "text", text: `[${task.id}] ${task.name}: closed stdin.` }],
        details: { id: task.id, name: task.name, eof: true, mode: task.mode, ...taskEnvironmentDetails(task) },
      };
    }

    try {
      writeTaskInput(task, parsed.data);
      return {
        content: [{ type: "text", text: `[${task.id}] ${task.name}: sent ${parsed.data.length} bytes (${parsed.keyTokens} key tokens).` }],
        details: {
          id: task.id,
          name: task.name,
          bytes: parsed.data.length,
          keyTokens: parsed.keyTokens,
          textBytes: parsed.textBytes,
          mode: task.mode,
          ...taskEnvironmentDetails(task),
        },
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `[${task.id}] ${task.name}: ${err instanceof Error ? err.message : String(err)}` }],
        details: { id: task.id, name: task.name, ...taskEnvironmentDetails(task) },
      };
    }
  };

  const killTask = async (
    params: BgTerminalParams,
    abortSignal: AbortSignal | undefined,
  ): Promise<AgentToolResult<Record<string, unknown>>> => {
    const task = requireTask(params.id, "kill");
    await task.transportExitPending?.catch(() => {});
    if (!isTaskControllable(task)) {
      return {
        content: [{ type: "text", text: `[${task.id}] ${task.name} is already ${task.status}.` }],
        details: { id: task.id, name: task.name, status: task.status, ...taskEnvironmentDetails(task) },
      };
    }

    const signal = asSignal(params.signal) ?? "SIGTERM";
    const previousStopSignal = task.requestedStopSignal;
    if (signalClassifiesStop(task, signal)) task.requestedStopSignal = signal;
    try {
      await sendProcessSignal(task, signal, true, abortSignal);
      await settleDisconnectedTaskAfterSignal(task, abortSignal);
    } catch (err) {
      task.requestedStopSignal = previousStopSignal;
      throwIfAborted(abortSignal);
      return {
        content: [{ type: "text", text: `[${task.id}] ${task.name}: failed to send ${signal}${taskEnvironmentSuffix(task)}: ${err instanceof Error ? err.message : String(err)}` }],
        details: { id: task.id, name: task.name, ...taskEnvironmentDetails(task) },
      };
    }

    await waitForTaskEnd(task, 2500);
    return {
      content: [{ type: "text", text: `${taskSummary(task)} — sent ${signal}.` }],
      details: {
        id: task.id,
        name: task.name,
        status: task.status,
        signal,
        mode: task.mode,
        ...taskEnvironmentDetails(task),
      },
    };
  };

  const attachTaskAction = async (
    params: BgTerminalParams,
    ctx: ExtensionToolContext,
  ): Promise<AgentToolResult<Record<string, unknown>>> => {
    const task = requireTask(params.id, "attach");
    // The attach action blocks until the user detaches, so on return we can
    // report what the console showed just before it closed. A future
    // non-blocking attach should skip this excerpt.
    await attachTask(task, ctx);
    await flushConsole(task);

    const parts = [`${taskSummary(task)} — detached.`];
    const excerpts = recentTaskOutputExcerpts(task, ATTACH_EXCERPT_LINES);
    if (excerpts.length === 0) {
      parts.push(`${emptyOutputMessage(task, "output")} Use action=read to check again.`);
    } else {
      for (const excerpt of excerpts) {
        parts.push(`── ${excerpt.label} ──\n${excerpt.lines.join("\n")}`);
      }
      parts.push(`Use action=read id="${task.id}" for more output.`);
    }

    return {
      content: [{ type: "text", text: parts.join("\n") }],
      details: { id: task.id, name: task.name, status: task.status, mode: task.mode, ...taskEnvironmentDetails(task) },
    };
  };

  pi.registerTool({
    name: "bg_terminal",
    label: "BG Terminal",
    description:
      "Background terminals: start runs detached, wait blocks for exit or a pattern, status lists or inspects, read pages output, send types input or a signal, kill signals, attach opens the live console.",
    promptSnippet: "Manage background terminal tasks (start, wait, status, read, send, kill, attach)",
    promptGuidelines: [
      "Use only for genuine background needs: an explicit user request, a process kept for later interaction, or useful concurrent work; otherwise use foreground bash.",
      "Emit whole same-task chains in one response (e.g. start→wait→read); same id/name runs in source order, different tasks in parallel. Never poll.",
      "send input is exact text and never appends Enter — end with <Enter> yourself to submit a line (e.g. \"y<Enter>\", \"<Down*3><Enter>\"). Keys are <...> tokens: <Tab>, <Esc>, <Up>, <C-c>, <C-d>, <A-f>, <Space>, repeat with <Down*3>, and escape a literal '<' as \\<; text and keys combine. For pipe tasks, <C-d> or <EOF> closes stdin.",
      "start defaults to pipe; use mode=pty for TUIs. wait already returns the latest pipe line, so read only for fuller, multiline, paginated, or PTY output.",
      "Session reload or shutdown terminates running tasks.",
    ],
    parameters: bgTerminalParameters,
    executionMode: "parallel",

    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<Record<string, unknown>>> {
      await mustWaitForPredecessor(toolCallId, signal);
      switch (params.action) {
        case "start": return startTask(params, ctx);
        case "wait": return waitTask(params, signal, onUpdate);
        case "status": return statusTask(params, signal);
        case "read": return readTask(params);
        case "send": return sendTask(params, signal);
        case "kill": return killTask(params, signal);
        case "attach": return attachTaskAction(params, ctx);
        default: throw new Error(`Unknown bg_terminal action: ${String(params.action)}`);
      }
    },

    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const action = typeof args.action === "string" ? args.action : "";
      const parts = [theme.fg("toolTitle", theme.bold("bg_terminal")), theme.fg("accent", action)];
      if (action === "start") {
        if (args.name) parts.push(theme.fg("accent", args.name));
        if (args.command) parts.push(theme.fg("muted", `$ ${args.command}`));
        if (args.mode === "pty") parts.push(theme.fg("dim", "[pty]"));
      } else if (args.id) {
        parts.push(renderTaskCallLabel(args.id, theme));
      }
      if (action === "wait") {
        if (args.pattern) parts.push(theme.fg("dim", `/${truncateText(String(args.pattern), 40)}/`));
        if (typeof args.timeout === "number") parts.push(theme.fg("dim", `timeout=${args.timeout}s`));
      }
      if (action === "read") {
        if (typeof args.lines === "number") parts.push(theme.fg("dim", `lines=${args.lines}`));
        if (typeof args.offset === "number" && args.offset !== 0) parts.push(theme.fg("dim", `offset=${args.offset}`));
        if (args.stream && args.stream !== "both") parts.push(theme.fg("dim", String(args.stream)));
        parts.push(theme.fg("dim", `(${keyText("app.tools.expand")} to expand)`));
      }
      if (action === "send") {
        const value = args.signal ?? (args.input !== undefined ? truncateText(JSON.stringify(args.input), 60) : undefined);
        if (value !== undefined) parts.push(theme.fg("dim", `→ ${value}`));
      }
      if (action === "kill" && args.signal) parts.push(theme.fg("error", String(args.signal)));
      text.setText(parts.filter(Boolean).join(" "));
      return text;
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const state = context.state as BgWaitRenderState;
      const waiting = context.args?.action === "wait";
      if (waiting && context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
      }
      const stopTimer = () => {
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      };
      if (waiting && isPartial && state.startedAt !== undefined && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
        state.interval.unref?.();
      }
      if (!isPartial || context.isError) stopTimer();

      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      if (isPartial) {
        if (waiting) {
          const elapsed = state.startedAt === undefined
            ? "0.0s"
            : formatElapsedSeconds(Date.now() - state.startedAt);
          text.setText(theme.fg("muted", `Elapsed ${elapsed}`));
          return text;
        }
        text.setText(theme.fg("warning", "Working..."));
        return text;
      }

      if (context.args?.action === "read" && !expanded) {
        text.setText("");
        return text;
      }

      const content = result.content[0]?.type === "text" ? result.content[0].text : "";
      const details = result.details as { status?: BgTask["status"]; timedOut?: boolean } | undefined;
      const color = details?.timedOut
        ? "warning"
        : details?.status === "failed"
          ? "error"
          : details?.status === "stopped" || details?.status === "disconnected"
            ? "warning"
            : "toolOutput";
      text.setText(theme.fg(color, content) || content);
      return text;
    },
  });
}
