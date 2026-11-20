// Patch: keep pi-hermes-memory off the startup critical path (migrated from scripts/apply-optimizations.mjs).
//
// What it does: `hermes-memory-config.json` controls when the hermes memory extension opens its
// database. With defaults the extension runs its SQLite PRAGMA quick_check scan and a Windows
// powershell.exe lock probe while pi is still mounting tools. Turning on lazy initialization and
// turning off the open-time quick check moves both behind first use.
//
// The file is JSON, so the patch parses it and only rewrites when a value actually differs —
// untouched configs stay byte-identical and verify reports them clean.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentDirOf, readTextCached } from "../_shared/pi-packages.js";

const CONFIG_FILE = "hermes-memory-config.json";
const WANT = { lazyInitialization: true, quickCheckOnOpen: false };

const describe = () => `lazyInitialization=${WANT.lazyInitialization}, quickCheckOnOpen=${WANT.quickCheckOnOpen}`;
const tuned = (cfg) => Object.entries(WANT).every(([key, value]) => cfg[key] === value);

export default {
  id: "hermes-config",
  name: "Defer hermes memory startup work",
  description:
    "Sets lazyInitialization=true and quickCheckOnOpen=false in hermes-memory-config.json so the memory database's integrity scan and lock probe run on first use instead of during pi startup.",
  version: "2.0.0",
  tags: ["hermes", "startup", "performance"],
  params: [],

  targets(ctx) {
    const file = join(agentDirOf(ctx), CONFIG_FILE);
    if (!existsSync(file)) return [];
    const content = readTextCached(file);
    if (content === undefined) return [];
    return [{ file, content, required: false, label: CONFIG_FILE }];
  },

  transform(ctx, file, content) {
    let cfg;
    try {
      cfg = JSON.parse(content);
    } catch (err) {
      throw new Error(`${file} is not valid JSON: ${err.message}`);
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
      throw new Error(`${file} is not a JSON object`);
    }
    if (tuned(cfg)) return { unchanged: true, summary: `already tuned (${describe()})` };
    const changedKeys = Object.keys(WANT).filter((key) => cfg[key] !== WANT[key]);
    return {
      content: `${JSON.stringify({ ...cfg, ...WANT }, null, 2)}\n`,
      summary: `set ${changedKeys.join(", ")} (${describe()})`,
    };
  },

  // No revert hook on purpose: the previous values are not knowable from the file alone, so the
  // runner's pre-patch backup restores the exact bytes instead of guessing.
};
