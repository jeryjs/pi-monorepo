import { createRealpathRequire } from "./realpath-require.ts";

const runtimeRequire = createRealpathRequire(import.meta.url);

export type NodePtyModule = typeof import("node-pty");
type XtermHeadlessModule = typeof import("@xterm/headless");
type XtermSerializeModule = typeof import("@xterm/addon-serialize");

// The virtual console backend is required by both pipe and PTY tasks, so it is
// resolved eagerly. node-pty is native and only needed for PTY mode, so a
// missing or unbuildable binary must not stop the extension from loading.
export const { Terminal: HeadlessTerminal } = runtimeRequire(
  "@xterm/headless",
) as XtermHeadlessModule;
export const { SerializeAddon } = runtimeRequire(
  "@xterm/addon-serialize",
) as XtermSerializeModule;

let nodePtyModule: NodePtyModule | null = null;
let nodePtyLoadError: Error | null = null;

/** Load node-pty on first PTY launch, with an actionable error if it is missing. */
export function loadNodePty(): NodePtyModule {
  if (nodePtyModule) return nodePtyModule;
  try {
    nodePtyModule = runtimeRequire("node-pty") as NodePtyModule;
    return nodePtyModule;
  } catch (error) {
    nodePtyLoadError = new Error(
      'PTY mode requires the native "node-pty" dependency, which could not be loaded '
      + `(${error instanceof Error ? error.message : String(error)}). `
      + "Install dependencies for this extension, or start the task in pipe mode instead.",
    );
    throw nodePtyLoadError;
  }
}
