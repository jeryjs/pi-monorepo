import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  DynamicBorder,
  getAgentDir,
  getSelectListTheme,
  loadSkillsFromDir,
  parseFrontmatter,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Focusable,
  Input,
  Key,
  matchesKey,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";

type PromptMode = "compact" | "original";
type Settings = Record<string, unknown>;

type ManualSkill = {
  path: string;
  name?: string;
  description?: string;
};

type ManualStore = {
  version: 1;
  skills: Record<string, ManualSkill>;
};

type SkillRow = {
  id: string;
  name: string;
  description: string;
  path?: string;
  pattern: string;
  enabled: boolean;
  manual: boolean;
};

type SelectorAction =
  | { type: "add" }
  | { type: "remove"; row: SkillRow }
  | { type: "cancel" };

const AGENT_DIR = getAgentDir();
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");
const MANUAL_STORE_PATH = join(AGENT_DIR, "skills-manual.json");
const SKILL_FILE = "skill.md";
const MAX_VISIBLE = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function readSettings(): Settings {
  const value = readJson(SETTINGS_PATH);
  return isRecord(value) ? value : {};
}

function writeSettings(settings: Settings): void {
  atomicWriteJson(SETTINGS_PATH, settings);
}

function resolveManualPath(input: string): string {
  let value = input.trim().replace(/^['"]|['"]$/g, "");
  if (value === "~") value = homedir();
  else if (value.startsWith("~/") || value.startsWith("~\\")) {
    value = join(homedir(), value.slice(2));
  }
  return resolve(value);
}

function readManualStore(): ManualStore {
  const parsed = readJson(MANUAL_STORE_PATH);
  const skills: Record<string, ManualSkill> = {};
  const rawSkills = isRecord(parsed) && isRecord(parsed.skills) ? parsed.skills : {};

  for (const [rawId, rawValue] of Object.entries(rawSkills)) {
    const id = normalizePatternTarget(rawId);
    if (!id?.startsWith("manual/")) continue;

    const value = typeof rawValue === "string" ? { path: rawValue } : rawValue;
    if (!isRecord(value) || typeof value.path !== "string" || value.path.trim() === "") continue;

    skills[id] = {
      path: resolveManualPath(value.path),
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.description === "string" ? { description: value.description } : {}),
    };
  }

  return { version: 1, skills };
}

function writeManualStore(store: ManualStore): void {
  atomicWriteJson(MANUAL_STORE_PATH, store);
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function normalizePatternTarget(target: string): string | undefined {
  let value = target.trim().replace(/\\/g, "/");
  if (value === "") return undefined;
  if (value.startsWith("./")) value = value.slice(2);
  if (value.startsWith("/") || value.startsWith("//") || /^[A-Za-z]:\//.test(value)) return undefined;

  const parts = value.split("/").filter(Boolean);
  if (parts.length === 0 || parts.includes("..")) return undefined;
  return parts.join("/");
}

function rawSkillEntries(settings: Settings): string[] {
  return Array.isArray(settings.skills)
    ? settings.skills.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Keep settings.json compatible with Pi's resource-pattern format:
 * only relative `+pattern` / `-pattern` entries are retained.
 */
function normalizedSkillEntries(settings: Settings): string[] {
  const byTarget = new Map<string, string>();

  for (const entry of rawSkillEntries(settings)) {
    if (!entry.startsWith("+") && !entry.startsWith("-")) continue;
    const target = normalizePatternTarget(entry.slice(1));
    if (!target) continue;

    const sign = entry.startsWith("-") ? "-" : "+";
    const existing = byTarget.get(target);
    // Pi gives an exact `-` exclusion precedence over an exact `+` inclusion.
    if (sign === "-" || existing === undefined || existing.startsWith("+")) {
      byTarget.set(target, `${sign}${target}`);
    }
  }

  return [...byTarget.values()];
}

function patternTarget(entry: string): string | undefined {
  if (!entry.startsWith("+") && !entry.startsWith("-")) return undefined;
  return normalizePatternTarget(entry.slice(1));
}

function patternEnabled(pattern: string, entries: string[]): boolean {
  let forceExcluded = false;
  for (const entry of entries) {
    if (patternTarget(entry) !== pattern) continue;
    if (entry.startsWith("-")) forceExcluded = true;
  }
  // As in Pi's exact override handling, `-` wins regardless of entry order.
  return !forceExcluded;
}

function promptMode(settings: Settings): PromptMode {
  return settings.skills_prompt === "compact" ? "compact" : "original";
}

function canonical(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function isPathInside(baseDir: string, path: string): boolean {
  const rel = relative(resolve(baseDir), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

function readSkillMetadata(path: string): { name: string; description: string } {
  try {
    const parsed = parseFrontmatter<{ name?: string; description?: string }>(
      readFileSync(path, "utf8"),
    );
    return {
      name: parsed.frontmatter.name?.trim() || basename(dirname(path)),
      description: parsed.frontmatter.description?.trim() || "",
    };
  } catch {
    return { name: basename(dirname(path)), description: "" };
  }
}

function relativeSkillPattern(filePath: string, baseDir: string): string | undefined {
  const absoluteFile = resolve(filePath);
  const absoluteBase = resolve(baseDir);
  const parent = dirname(absoluteFile);
  const parentRelative = toPosix(relative(absoluteBase, parent));
  const fileRelative = toPosix(relative(absoluteBase, absoluteFile));
  const value = parentRelative && parentRelative !== "." ? parentRelative : fileRelative;

  if (!value || isAbsolute(value) || value === ".." || value.startsWith("../")) return undefined;
  return normalizePatternTarget(value);
}

function inferredUserBaseDir(filePath: string): string | undefined {
  const candidates = [AGENT_DIR, dirname(join(homedir(), ".agents", "skills"))];
  for (const baseDir of candidates) {
    if (isPathInside(baseDir, filePath)) return baseDir;
  }
  return undefined;
}

function standardRows(skills: Skill[], entries: string[]): SkillRow[] {
  const rows: SkillRow[] = [];
  const seenPaths = new Set<string>();
  const seenNames = new Set<string>();

  const addSkill = (skill: Skill, baseDir: string | undefined): void => {
    const key = canonical(skill.filePath);
    if (seenPaths.has(key) || seenNames.has(skill.name)) return;

    const resolvedBase = inferredUserBaseDir(skill.filePath) ?? baseDir ?? skill.sourceInfo?.baseDir;
    if (!resolvedBase) return;
    const pattern = relativeSkillPattern(skill.filePath, resolvedBase);
    if (!pattern) return;

    seenPaths.add(key);
    seenNames.add(skill.name);
    rows.push({
      id: `path:${key}`,
      name: skill.name,
      description: skill.description,
      path: skill.filePath,
      pattern,
      enabled: patternEnabled(pattern, entries),
      manual: false,
    });
  };

  // The live list is authoritative for source metadata and package precedence.
  for (const skill of skills) {
    if (skill.sourceInfo?.scope !== "user" || skill.sourceInfo?.origin !== "top-level") continue;
    addSkill(skill, skill.sourceInfo.baseDir);
  }

  // Disabled auto-discovered skills are absent from the live list, so scan the
  // two user-level Pi skill roots as well.
  const scanRoots = [
    { dir: join(AGENT_DIR, "skills"), baseDir: AGENT_DIR },
    { dir: join(homedir(), ".agents", "skills"), baseDir: dirname(join(homedir(), ".agents", "skills")) },
  ];

  for (const root of scanRoots) {
    if (!existsSync(root.dir)) continue;
    for (const skill of loadSkillsFromDir({ dir: root.dir, source: "user" }).skills) {
      addSkill(skill, root.baseDir);
    }
  }

  return rows.sort((left, right) => left.name.localeCompare(right.name) || left.path!.localeCompare(right.path!));
}

function manualRows(store: ManualStore, entries: string[]): SkillRow[] {
  return Object.entries(store.skills)
    .map(([pattern, manual]) => {
      const metadata = existsSync(manual.path) ? readSkillMetadata(manual.path) : undefined;
      return {
        id: `manual:${pattern}`,
        name: metadata?.name || manual.name || basename(dirname(manual.path)),
        description: metadata?.description || manual.description || "",
        path: manual.path,
        pattern,
        enabled: patternEnabled(pattern, entries),
        manual: true,
      } satisfies SkillRow;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function buildRows(skills: Skill[], settings: Settings, store: ManualStore): SkillRow[] {
  const entries = normalizedSkillEntries(settings);
  const manualPaths = new Set(Object.values(store.skills).map((manual) => canonical(manual.path)));
  const standard = standardRows(skills, entries).filter((row) => !manualPaths.has(canonical(row.path!)));
  return [...standard, ...manualRows(store, entries)];
}

function manualIdForPath(store: ManualStore, path: string, name: string): string {
  const key = canonical(path);
  for (const [id, manual] of Object.entries(store.skills)) {
    if (canonical(manual.path) === key) return id;
  }

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "skill";
  const base = `manual/${slug}`;
  if (!store.skills[base]) return base;

  let index = 2;
  while (store.skills[`${base}-${index}`]) index++;
  return `${base}-${index}`;
}

class SkillsState {
  readonly settings: Settings;
  readonly manualStore: ManualStore;
  rows: SkillRow[];
  mode: PromptMode;
  selectedId?: string;
  revision = 0;

  constructor(skills: Skill[]) {
    this.settings = readSettings();
    this.manualStore = readManualStore();
    this.rows = buildRows(skills, this.settings, this.manualStore);
    this.mode = promptMode(this.settings);
  }

  save(): void {
    this.settings.skills = normalizedSkillEntries(this.settings);
    this.settings.skills_prompt = this.mode;
    writeSettings(this.settings);
    this.revision++;
  }

  setPattern(pattern: string, enabled: boolean): void {
    const entries = normalizedSkillEntries(this.settings).filter((entry) => patternTarget(entry) !== pattern);
    entries.push(`${enabled ? "+" : "-"}${pattern}`);
    this.settings.skills = entries;

    for (const row of this.rows) {
      if (row.pattern === pattern) row.enabled = enabled;
    }
  }

  toggle(row: SkillRow): void {
    this.setPattern(row.pattern, !row.enabled);
    this.save();
  }

  setAll(enabled: boolean): void {
    let entries = normalizedSkillEntries(this.settings);
    const patterns = [...new Set(this.rows.map((row) => row.pattern))];

    for (const pattern of patterns) {
      entries = entries.filter((entry) => patternTarget(entry) !== pattern);
      entries.push(`${enabled ? "+" : "-"}${pattern}`);
    }

    this.settings.skills = entries;
    for (const row of this.rows) row.enabled = enabled;
    this.save();
  }

  togglePrompt(): void {
    this.mode = this.mode === "compact" ? "original" : "compact";
    this.save();
  }

  addManual(input: string): string {
    let path = resolveManualPath(input);
    try {
      if (statSync(path).isDirectory()) path = join(path, "SKILL.md");
    } catch {
      throw new Error(`Path does not exist: ${path}`);
    }
    if (basename(path).toLowerCase() !== SKILL_FILE) {
      throw new Error("Manual skill path must point to a SKILL.md file");
    }
    if (!existsSync(path)) throw new Error(`SKILL.md does not exist: ${path}`);

    const existingStandard = this.rows.find(
      (row) => !row.manual && row.path && canonical(row.path) === canonical(path),
    );
    if (existingStandard) {
      throw new Error(`Path is already managed as the standard skill '${existingStandard.name}'`);
    }

    const metadata = readSkillMetadata(path);
    const id = manualIdForPath(this.manualStore, path, metadata.name);
    this.manualStore.skills[id] = {
      path,
      name: metadata.name,
      description: metadata.description,
    };
    writeManualStore(this.manualStore);

    const entries = normalizedSkillEntries(this.settings).filter((entry) => patternTarget(entry) !== id);
    entries.push(`+${id}`);
    this.settings.skills = entries;

    const existingRow = this.rows.find((row) => row.manual && row.pattern === id);
    if (existingRow) {
      existingRow.path = path;
      existingRow.name = metadata.name;
      existingRow.description = metadata.description;
      existingRow.enabled = true;
      this.selectedId = existingRow.id;
    } else {
      const row: SkillRow = {
        id: `manual:${id}`,
        name: metadata.name,
        description: metadata.description,
        path,
        pattern: id,
        enabled: true,
        manual: true,
      };
      this.rows.push(row);
      this.selectedId = row.id;
    }

    this.save();
    return path;
  }

  removeManual(row: SkillRow): void {
    if (!row.manual || !row.path) return;

    delete this.manualStore.skills[row.pattern];
    writeManualStore(this.manualStore);

    this.settings.skills = normalizedSkillEntries(this.settings).filter(
      (entry) => patternTarget(entry) !== row.pattern,
    );
    this.rows = this.rows.filter((candidate) => candidate.id !== row.id);
    this.save();
  }
}

class SkillsSelector extends Container implements Focusable {
  focused = true;
  private readonly search = new Input({ prompt: "Search: " });
  private readonly listHost = new Container();
  private readonly footer = new Text();
  private list?: SelectList;
  private currentRows: SkillRow[] = [];
  private selectedIndex = 0;

  constructor(
    private readonly state: SkillsState,
    private readonly done: (action: SelectorAction) => void,
  ) {
    super();
    this.addChild(new DynamicBorder());
    this.addChild(this.search);
    this.addChild(this.listHost);
    this.addChild(this.footer);
    this.addChild(new DynamicBorder());
    this.refresh();
  }

  private visibleRows(): SkillRow[] {
    const query = this.search.getValue().trim().toLowerCase();
    if (!query) return this.state.rows;
    return this.state.rows.filter((row) =>
      `${row.name} ${row.description} ${row.path ?? ""} ${row.pattern}`.toLowerCase().includes(query),
    );
  }

  refresh(): void {
    const previousId = this.state.selectedId;
    const previousIndex = this.selectedIndex;
    const rows = this.visibleRows();
    const byId = new Map(rows.map((row) => [row.id, row]));

    this.listHost.clear();
    this.list = new SelectList(
      rows.map((row) => ({
        value: row.id,
        label: `${row.enabled ? "✓" : "·"} ${row.name}${row.manual ? " [manual]" : ""}`,
        description: `${row.description || "No description"}${row.path ? `\n${row.path}` : ""}`,
      })),
      MAX_VISIBLE,
      getSelectListTheme(),
    );
    this.list.onSelectionChange = (item) => {
      this.state.selectedId = item.value;
      this.selectedIndex = this.currentRows.findIndex((row) => row.id === item.value);
    };
    this.list.onSelect = (item) => {
      const row = byId.get(item.value);
      if (!row) return;
      this.state.toggle(row);
      this.refresh();
    };

    this.currentRows = rows;
    let restoreIndex = rows.findIndex((row) => row.id === previousId);
    if (restoreIndex === -1) restoreIndex = Math.min(Math.max(previousIndex, 0), Math.max(rows.length - 1, 0));
    if (rows.length > 0) {
      this.list.setSelectedIndex(restoreIndex);
      this.selectedIndex = restoreIndex;
      this.state.selectedId = rows[restoreIndex].id;
    } else {
      this.selectedIndex = 0;
      this.state.selectedId = undefined;
    }
    this.listHost.addChild(this.list);

    const enabled = this.state.rows.filter((row) => row.enabled).length;
    this.footer.setText(
      `${enabled}/${this.state.rows.length} enabled · prompt: ${this.state.mode}\n`
      + "Enter toggle · Ctrl+A/X all/none · Ctrl+O add · Ctrl+R remove · Ctrl+P format · Esc close",
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done({ type: "cancel" });
      return;
    }
    if (matchesKey(data, Key.ctrl("a"))) {
      this.state.setAll(true);
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.ctrl("x"))) {
      this.state.setAll(false);
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.ctrl("p"))) {
      this.state.togglePrompt();
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.ctrl("o"))) {
      this.done({ type: "add" });
      return;
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      const selected = this.list?.getSelectedItem();
      const row = selected ? this.state.rows.find((candidate) => candidate.id === selected.value) : undefined;
      if (row?.manual) this.done({ type: "remove", row });
      return;
    }
    if (
      matchesKey(data, Key.enter)
      || matchesKey(data, Key.up)
      || matchesKey(data, Key.down)
      || matchesKey(data, Key.pageUp)
      || matchesKey(data, Key.pageDown)
    ) {
      this.list?.handleInput(data);
      return;
    }
    this.search.handleInput(data);
    this.refresh();
  }

  getSearchInput(): Input {
    return this.search;
  }
}

function displayPath(path: string): string {
  const home = resolve(homedir());
  const absolute = resolve(path);
  const relativeToHome = relative(home, absolute);
  if (relativeToHome && relativeToHome !== ".." && !relativeToHome.startsWith(`..\\`) && !relativeToHome.startsWith("../")) {
    return `~/${toPosix(relativeToHome)}`;
  }
  return toPosix(absolute);
}

function compactSkills(skills: Skill[]): string {
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  if (visible.length === 0) return "";

  const lines = ["Available skills (read the matching SKILL.md when the task matches):"];
  for (const skill of visible) {
    const description = skill.description.replace(/\s+/g, " ").trim();
    lines.push(`${skill.name} [${displayPath(skill.filePath)}]: ${description}`);
  }
  return lines.join("\n");
}

function discoverManualSkillPaths(): string[] {
  const settings = readSettings();
  const entries = normalizedSkillEntries(settings);
  const store = readManualStore();
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const [id, manual] of Object.entries(store.skills)) {
    if (!patternEnabled(id, entries)) continue;
    if (basename(manual.path).toLowerCase() !== SKILL_FILE || !existsSync(manual.path)) continue;

    const key = canonical(manual.path);
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push(manual.path);
  }

  return paths;
}

async function runSelector(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/skills requires Pi TUI mode.", "warning");
    return;
  }

  const state = new SkillsState(ctx.getSystemPromptOptions().skills ?? []);
  const initialRevision = state.revision;

  while (true) {
    const action = await ctx.ui.custom<SelectorAction>((_tui, _theme, _keybindings, done) =>
      new SkillsSelector(state, done),
    );

    if (action?.type === "add") {
      const input = await ctx.ui.input("Add manual skill", "Absolute path to SKILL.md");
      if (input?.trim()) {
        try {
          state.addManual(input);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
      }
      continue;
    }

    if (action?.type === "remove") {
      const confirmed = await ctx.ui.confirm(
        "Remove manual skill",
        `${action.row.path}\n\nRemove this mapping from skills-manual.json and settings.json?`,
      );
      if (confirmed) {
        state.removeManual(action.row);
      }
      continue;
    }

    break;
  }

  if (state.revision !== initialRevision) {
    await ctx.reload();
  }
}

export default function skillsExtension(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => ({
    skillPaths: discoverManualSkillPaths(),
  }));

  pi.on("before_agent_start", (event) => {
    if (promptMode(readSettings()) !== "compact") return;
    const skills = event.systemPromptOptions.skills ?? [];
    event.systemPromptOptions.sections.skills = compactSkills(skills);
  });

  pi.registerCommand("skills", {
    description: "Manage enabled skills and the skills prompt format",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (!command) {
        await runSelector(ctx);
        return;
      }

      const state = new SkillsState(ctx.getSystemPromptOptions().skills ?? []);
      try {
        if (/^add\s+/i.test(command)) {
          state.addManual(command.replace(/^add\s+/i, ""));
          await ctx.reload();
          return;
        }
        if (/^remove\s+/i.test(command)) {
          const value = command.replace(/^remove\s+/i, "").trim();
          const row = state.rows.find((candidate) =>
            candidate.manual
            && (candidate.pattern === value || (candidate.path && canonical(candidate.path) === canonical(resolveManualPath(value)))),
          );
          if (!row?.manual) throw new Error(`Manual skill not found: ${value}`);
          state.removeManual(row);
          await ctx.reload();
          return;
        }
        if (/^prompt\s+/i.test(command)) {
          const value = command.replace(/^prompt\s+/i, "").trim().toLowerCase();
          if (value !== "compact" && value !== "original") {
            throw new Error("Prompt format must be 'compact' or 'original'");
          }
          state.mode = value;
          state.save();
          await ctx.reload();
          return;
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      ctx.ui.notify("Usage: /skills [add <SKILL.md>|remove <path-or-manual-id>|prompt compact|original]", "info");
    },
  });
}
