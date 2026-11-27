/**
 * Managed optional dependencies for the offline (sherpa-onnx) wake word.
 *
 * Neither the inference runtime nor the KWS model is a package dependency: both
 * are installed on demand into the Pi agent directory, driven from the `/voice`
 * settings screen or `/voice sherpa`. Nothing here is magic — the npm install,
 * the tarball extraction and the BPE keyword tokenizer are all exercised by
 * `test/sherpa.ts`, and the whole path was verified against the real package,
 * the real model tarball and the model's own test wav.
 *
 * Layout:
 *   <agentDir>/pi-voice-deps/                 npm prefix for sherpa-onnx-node
 *   <agentDir>/pi-voice-models/<model>/       extracted KWS model
 *   <agentDir>/pi-voice-models/keywords/      generated (tokenised) keywords files
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir } from "./keychain.ts";
import { log } from "./util.ts";

export const KWS_PACKAGE = "sherpa-onnx-node";

/**
 * English KWS model (BPE, 3.3M params). The `-mobile` variant of the same model
 * aborts inside onnxruntime ("/downsample/Reshape_1" shape mismatch), so the full
 * model is the one we install.
 */
export const KWS_MODEL = {
    name: "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/"
        + "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2",
    bytes: 17_626_723,
    label: "sherpa-onnx zipformer KWS (gigaspeech, English, BPE)",
};

/**
 * English streaming ASR used as the alternative wake engine.
 *
 * The keyword spotter is cheap but fragile: on some speakers it never fires at any
 * threshold. A general recognizer hears the same words and the wake phrase is
 * matched as *text*, which works on voices the spotter cannot hear and lets the
 * phrase be anything the user types. The int8 files are what gets loaded.
 */
export const ASR_MODEL = {
    name: "sherpa-onnx-streaming-zipformer-en-20M-2023-02-17",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
        + "sherpa-onnx-streaming-zipformer-en-20M-2023-02-17.tar.bz2",
    bytes: 127_887_156,
    label: "sherpa-onnx streaming zipformer ASR (English, 20M)",
};

/** Default boost applied to keyword tokens when the user did not set one. */
export const DEFAULT_KEYWORD_SCORE = 1.5;

const MODEL_FILES = ["encoder", "decoder", "joiner"] as const;

export interface StepResult {
    ok: boolean;
    detail: string;
}

export interface SherpaStatus {
    packageInstalled: boolean;
    version?: string;
    packageDetail: string;
    /** Configured dir, or the managed one when the config leaves it empty. */
    modelDir: string;
    managed: boolean;
    modelReady: boolean;
    missing: string[];
    keywordsDetail: string;
    ready: boolean;
    detail: string;
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

export function managedDepsDir(): string {
    return process.env.PI_VOICE_DEPS || join(agentDir(), "pi-voice-deps");
}

export function managedModelsRoot(): string {
    return process.env.PI_VOICE_MODELS || join(agentDir(), "pi-voice-models");
}

export function managedModelDir(): string {
    return join(managedModelsRoot(), KWS_MODEL.name);
}

export function keywordsDir(): string {
    return join(managedModelsRoot(), "keywords");
}

/** The model dir in use: an explicit config wins, otherwise the managed one. */
export function resolvedModelDir(configured: string): string {
    const trimmed = configured.trim();

    return trimmed.length > 0 ? trimmed : managedModelDir();
}

export function isManagedModelDir(dir: string): boolean {
    return dir === managedModelDir();
}

export function managedAsrModelDir(): string {
    return join(managedModelsRoot(), ASR_MODEL.name);
}

/** The ASR model dir in use: an explicit config wins, otherwise the managed one. */
export function resolvedAsrModelDir(configured = ""): string {
    const trimmed = configured.trim();

    return trimmed.length > 0 ? trimmed : managedAsrModelDir();
}

/** Same file requirements as the KWS model: transducer + tokens. */
export function asrModelStatus(modelDir: string): { ok: boolean; missing: string[] } {
    return modelStatus(modelDir);
}

// ---------------------------------------------------------------------------
// package resolution
// ---------------------------------------------------------------------------

function packageRoot(): string {
    try {
        return fileURLToPath(new URL(".", import.meta.url));
    } catch {
        return process.cwd();
    }
}

/** Where to look for `sherpa-onnx-node`: our managed dir first, then the usual places. */
function resolutionRefs(): string[] {
    return [
        join(managedDepsDir(), "package.json"),
        join(packageRoot(), "package.json"),
        join(process.cwd(), "package.json"),
    ];
}

/** Resolve without executing anything (safe for status checks). */
export function resolveSherpaEntry(): { version: string; path: string } | undefined {
    for (const ref of resolutionRefs()) {
        try {
            const require = createRequire(ref);
            const path = require.resolve(`${KWS_PACKAGE}/package.json`);
            const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: string };

            return { version: parsed.version ?? "unknown", path };
        } catch {
            // try the next location
        }
    }

    return undefined;
}

/** Load the runtime. Executes package code, so only call it when it is needed. */
export function loadSherpaModule(): unknown | undefined {
    for (const ref of resolutionRefs()) {
        try {
            return createRequire(ref)(KWS_PACKAGE) as unknown;
        } catch (error) {
            log("sherpa", `cannot load ${KWS_PACKAGE} from ${dirname(ref)}`, String(error));
        }
    }

    return undefined;
}

// ---------------------------------------------------------------------------
// model + keyword checks
// ---------------------------------------------------------------------------

export function pickModelFile(modelDir: string, prefix: string): string | undefined {
    let names: string[];

    try {
        names = readdirSync(modelDir).filter((name) => name.startsWith(prefix) && name.endsWith(".onnx"));
    } catch {
        return undefined;
    }

    // Prefer the quantised file: same result, much faster on CPU.
    const int8 = names.filter((name) => name.includes(".int8."));

    return (int8.length > 0 ? int8 : names)[0]
        ? join(modelDir, (int8.length > 0 ? int8 : names)[0] as string)
        : undefined;
}

export function modelStatus(modelDir: string): { ok: boolean; missing: string[] } {
    const missing: string[] = [];

    for (const prefix of MODEL_FILES) {
        if (!pickModelFile(modelDir, prefix)) {
            missing.push(`${prefix}*.onnx`);
        }
    }

    if (!existsSync(join(modelDir, "tokens.txt"))) {
        missing.push("tokens.txt");
    }

    return { ok: missing.length === 0, missing };
}

function readTokens(modelDir: string): Set<string> | undefined {
    try {
        return new Set(
            readFileSync(join(modelDir, "tokens.txt"), "utf8")
                .split(/\r?\n/)
                .filter(Boolean)
                .map((line) => line.split(" ")[0] as string),
        );
    } catch {
        return undefined;
    }
}

export interface KeywordSpec {
    phrase: string;
    boost?: number;
}

/** `"HEY PI :2.0"` -> `{ phrase: "HEY PI", boost: 2 }`; `;` separates keywords. */
export function parseKeywordSpec(spec: string): KeywordSpec[] {
    return spec
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const match = /^(.*?)\s*:\s*([0-9]*\.?[0-9]+)$/.exec(entry);

            if (!match) {
                return { phrase: entry };
            }

            return { phrase: (match[1] as string).trim(), boost: Number(match[2]) };
        })
        .filter((entry) => entry.phrase.length > 0);
}

/**
 * Turn a phrase into the BPE token sequence sherpa expects.
 *
 * The shipped `keywords.txt` is already tokenised (`▁HE Y ▁S I RI`), not raw
 * text, and sherpa rejects unknown tokens. We reconstruct that with a greedy
 * longest-match over the model's own `tokens.txt`; for the reference keyword set
 * of the gigaspeech model this reproduces 7 of 9 lines exactly and the other two
 * are an equally valid segmentation of the same text (verified by running the
 * spotter against the model's test wav).
 */
export function tokenizeKeyword(modelDir: string, phrase: string): { ok: true; tokens: string } | { ok: false; reason: string } {
    const tokens = readTokens(modelDir);

    if (!tokens) {
        return { ok: false, reason: `cannot read ${join(modelDir, "tokens.txt")}` };
    }

    const words = phrase.trim().toUpperCase().split(/\s+/).filter(Boolean);

    if (words.length === 0) {
        return { ok: false, reason: "the keyword is empty" };
    }

    // SentencePiece marks word starts with U+2581 instead of a space.
    const text = words.map((word) => `\u2581${word}`).join("");
    const out: string[] = [];
    let position = 0;

    while (position < text.length) {
        let matched = "";

        for (let end = text.length; end > position; end--) {
            const candidate = text.slice(position, end);

            if (tokens.has(candidate)) {
                matched = candidate;
                break;
            }
        }

        if (!matched) {
            return {
                ok: false,
                reason: `no token in tokens.txt spells "${text.slice(position, position + 8)}". `
                    + "Use a simpler wake phrase, or tokenise it yourself with "
                    + "`sherpa-onnx-cli text2token --tokens-type bpe --bpe-model <model>/bpe.model`.",
            };
        }

        out.push(matched);
        position += matched.length;
    }

    return { ok: true, tokens: out.join(" ") };
}

/**
 * Write a sherpa keywords file. It lives in our own cache directory, not in the
 * model dir, so a read-only or shared model still works.
 */
export function writeKeywordsFile(
    modelDir: string,
    spec: string,
    outDir = keywordsDir(),
): { ok: true; path: string; lines: string[] } | { ok: false; reason: string } {
    const entries = parseKeywordSpec(spec);

    if (entries.length === 0) {
        return { ok: false, reason: "no wake phrase configured" };
    }

    const lines: string[] = [];

    for (const entry of entries) {
        const tokenized = tokenizeKeyword(modelDir, entry.phrase);

        if (!tokenized.ok) {
            return { ok: false, reason: `${entry.phrase}: ${tokenized.reason}` };
        }

        lines.push(entry.boost === undefined ? tokenized.tokens : `${tokenized.tokens} :${entry.boost}`);
    }

    const digest = createHash("sha1").update(`${modelDir}|${spec}`).digest("hex").slice(0, 12);
    const path = join(outDir, `keywords-${digest}.txt`);

    try {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    } catch (error) {
        return { ok: false, reason: `cannot write ${path}: ${String(error)}` };
    }

    return { ok: true, path, lines };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export function sherpaStatus(configuredModelDir = ""): SherpaStatus {
    const entry = resolveSherpaEntry();
    const modelDir = resolvedModelDir(configuredModelDir);
    const managed = isManagedModelDir(modelDir);
    const model = modelStatus(modelDir);
    const packageInstalled = Boolean(entry);

    const keywordsDetail = (() => {
        if (!model.ok) {
            return "waiting for the model";
        }

        const tokens = readTokens(modelDir);

        return tokens ? `${tokens.size} tokens` : "tokens.txt unreadable";
    })();

    const ready = packageInstalled && model.ok;

    const detail = ready
        ? `sherpa-onnx-node ${entry?.version ?? ""} + ${managed ? "managed" : "configured"} KWS model`
        : !packageInstalled && !model.ok
            ? "sherpa-onnx-node and the wake model are not installed"
            : !packageInstalled
                ? "sherpa-onnx-node is not installed"
                : `model files missing in ${modelDir}: ${model.missing.join(", ")}`;

    return {
        packageInstalled,
        ...(entry ? { version: entry.version } : {}),
        packageDetail: entry ? `${KWS_PACKAGE} ${entry.version}` : `${KWS_PACKAGE} not found`,
        modelDir,
        managed,
        modelReady: model.ok,
        missing: model.missing,
        keywordsDetail,
        ready,
        detail,
    };
}

// ---------------------------------------------------------------------------
// install: runtime
// ---------------------------------------------------------------------------

interface Invocation {
    command: string;
    prefixArgs: string[];
    shell: boolean;
}

/**
 * How to run npm. On Windows `spawn("npm.cmd")` without a shell is refused by
 * Node (and a shell would break paths with spaces), so run npm's CLI with the
 * current node binary whenever we can find it. Tests override through
 * `PI_VOICE_NPM_JS` (a JS file executed with node).
 */
export function npmInvocation(): Invocation {
    const jsOverride = process.env.PI_VOICE_NPM_JS?.trim();

    if (jsOverride) {
        return { command: process.execPath, prefixArgs: [jsOverride], shell: false };
    }

    if (process.platform !== "win32") {
        return { command: "npm", prefixArgs: [], shell: false };
    }

    const nodeDir = dirname(process.execPath);
    const cli = [
        join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
        join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ].find((candidate) => existsSync(candidate));

    if (cli) {
        return { command: process.execPath, prefixArgs: [cli], shell: false };
    }

    // Last resort: let a shell resolve npm.cmd. Args are quoted by cmd, so the
    // prefix dir must not contain shell metacharacters.
    return { command: "npm install", prefixArgs: [], shell: true };
}

function run(
    invocation: Invocation,
    args: string[],
    onLine: (line: string) => void,
    timeoutMs: number,
): Promise<StepResult> {
    return new Promise<StepResult>((resolve) => {
        const tail: string[] = [];
        let settled = false;

        const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
            shell: invocation.shell,
            windowsHide: true,
        });

        const finish = (result: StepResult): void => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(result);
            }
        };

        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch {
                // ignore
            }

            finish({ ok: false, detail: `timed out after ${Math.round(timeoutMs / 1000)}s` });
        }, timeoutMs);
        (timer as { unref?: () => void }).unref?.();

        const consume = (chunk: Buffer): void => {
            for (const line of chunk.toString("utf8").split(/\r?\n/)) {
                const text = line.trim();

                if (!text) {
                    continue;
                }

                tail.push(text);

                if (tail.length > 12) {
                    tail.shift();
                }

                onLine(text);
            }
        };

        child.stdout?.on("data", consume);
        child.stderr?.on("data", consume);
        child.on("error", (error) => finish({ ok: false, detail: `cannot run ${invocation.command}: ${error.message}` }));
        child.on("close", (code) => {
            finish(code === 0
                ? { ok: true, detail: `exit 0` }
                : { ok: false, detail: `npm exited ${code}: ${tail.slice(-4).join(" | ")}` });
        });
    });
}

export async function installSherpaPackage(onLine: (line: string) => void): Promise<StepResult> {
    const dir = managedDepsDir();

    try {
        mkdirSync(dir, { recursive: true });
    } catch (error) {
        return { ok: false, detail: `cannot create ${dir}: ${String(error)}` };
    }

    onLine(`installing ${KWS_PACKAGE} into ${dir}`);

    const result = await run(
        npmInvocation(),
        ["install", "--prefix", dir, "--no-fund", "--no-audit", "--loglevel=error", KWS_PACKAGE],
        onLine,
        15 * 60_000,
    );

    if (!result.ok) {
        return { ok: false, detail: `${result.detail} (install it yourself: npm install --prefix "${dir}" ${KWS_PACKAGE})` };
    }

    const entry = resolveSherpaEntry();

    if (!entry) {
        return { ok: false, detail: `npm reported success but ${KWS_PACKAGE} cannot be resolved from ${dir}` };
    }

    return { ok: true, detail: `${KWS_PACKAGE} ${entry.version} installed` };
}

// ---------------------------------------------------------------------------
// install: model
// ---------------------------------------------------------------------------

/** Windows ships bsdtar at System32 with built-in bzip2; GNU tar needs bzip2 on PATH. */
function tarCandidates(): string[] {
    if (process.platform !== "win32") {
        return ["tar"];
    }

    return [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), "tar"];
}

function extractArchive(dir: string, file: string): StepResult {
    let last = "no tar available";

    for (const binary of tarCandidates()) {
        // Relative file name with `cwd` set: GNU tar reads `C:/...` as a remote
        // host spec ("Cannot connect to C: resolve failed") and would fail.
        const result = spawnSync(binary, ["-xjf", file], {
            cwd: dir,
            encoding: "utf8",
            timeout: 10 * 60_000,
            windowsHide: true,
        });

        if (result.error) {
            last = `${binary}: ${result.error.message}`;

            continue;
        }

        if (result.status === 0) {
            return { ok: true, detail: binary };
        }

        last = `${binary}: ${(result.stderr ?? "").trim().split("\n").slice(-1)[0] ?? `exit ${result.status}`}`;
    }

    return { ok: false, detail: last };
}

async function download(url: string, target: string, onLine: (line: string) => void): Promise<StepResult> {
    let response: Response;

    try {
        response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
    } catch (error) {
        return { ok: false, detail: `download failed: ${String(error)}` };
    }

    if (!response.ok || !response.body) {
        return { ok: false, detail: `download failed: HTTP ${response.status} ${response.statusText}` };
    }

    const total = Number(response.headers.get("content-length") ?? 0);
    const reader = response.body.getReader();
    const fd = openSync(target, "w");
    let written = 0;
    let nextReport = 0;

    try {
        for (;;) {
            const { done, value } = await reader.read();

            if (done) {
                break;
            }

            if (value) {
                writeSync(fd, value);
                written += value.byteLength;

                if (written >= nextReport) {
                    nextReport = written + 4 * 1024 * 1024;
                    const mb = (written / 1024 / 1024).toFixed(1);
                    const percent = total > 0 ? ` (${Math.round((written / total) * 100)}%)` : "";

                    onLine(`downloading ${mb}${total > 0 ? ` / ${(total / 1024 / 1024).toFixed(1)}` : ""} MB${percent}`);
                }
            }
        }
    } catch (error) {
        closeSync(fd);

        return { ok: false, detail: `download interrupted: ${String(error)}` };
    }

    closeSync(fd);

    if (total > 0 && written !== total) {
        return { ok: false, detail: `download truncated: ${written} of ${total} bytes` };
    }

    return { ok: true, detail: `${(written / 1024 / 1024).toFixed(1)} MB` };
}

export async function downloadKwsModel(
    onLine: (line: string) => void,
    targetDir = managedModelDir(),
): Promise<StepResult> {
    return fetchModel({
        url: process.env.PI_VOICE_KWS_MODEL_URL?.trim() || KWS_MODEL.url,
        label: KWS_MODEL.label,
        target: targetDir,
        onLine,
    });
}

export async function downloadAsrModel(
    onLine: (line: string) => void,
    targetDir = managedAsrModelDir(),
): Promise<StepResult> {
    return fetchModel({
        url: process.env.PI_VOICE_ASR_MODEL_URL?.trim() || ASR_MODEL.url,
        label: ASR_MODEL.label,
        target: targetDir,
        onLine,
    });
}

/**
 * Download a `.tar.bz2` model into `target`: stage next to it so the last step is a
 * rename on the same volume, and never leave a half-extracted directory behind.
 */
async function fetchModel(options: {
    url: string;
    label: string;
    target: string;
    onLine: (line: string) => void;
}): Promise<StepResult> {
    const { url, label, target, onLine } = options;
    const existing = modelStatus(target);

    if (existing.ok) {
        return { ok: true, detail: `model already installed in ${target}` };
    }
    // Stage next to the target so the final move is a rename on the same volume.
    const staging = join(dirname(target), `.staging-${process.pid}`);
    const archive = "model.tar.bz2";

    const cleanup = (): void => {
        try {
            rmSync(staging, { recursive: true, force: true });
        } catch {
            // ignore
        }
    };

    cleanup();

    try {
        mkdirSync(staging, { recursive: true });
    } catch (error) {
        return { ok: false, detail: `cannot create ${staging}: ${String(error)}` };
    }

    onLine(`downloading ${label}`);

    const fetched = await download(url, join(staging, archive), onLine);

    if (!fetched.ok) {
        cleanup();

        return { ok: false, detail: `${fetched.detail}. Manual: download ${url} and extract it into ${target}` };
    }

    onLine("extracting…");

    const extracted = extractArchive(staging, archive);

    if (!extracted.ok) {
        cleanup();

        return { ok: false, detail: `extraction failed (${extracted.detail}). Manual: tar -xjf ${url} -C ${dirname(target)}` };
    }

    // The tarball contains a single directory; find the one with the model files.
    let source: string | undefined;

    try {
        source = readdirSync(staging)
            .map((name) => join(staging, name))
            .find((path) => statSync(path).isDirectory() && modelStatus(path).ok);
    } catch {
        source = undefined;
    }

    if (!source) {
        cleanup();

        return { ok: false, detail: "the archive did not contain a complete model (encoder/decoder/joiner + tokens.txt)" };
    }

    try {
        rmSync(target, { recursive: true, force: true });
        renameSync(source, target);
    } catch (error) {
        cleanup();

        return { ok: false, detail: `cannot move the model into ${target}: ${String(error)}` };
    }

    cleanup();

    const after = modelStatus(target);

    if (!after.ok) {
        return { ok: false, detail: `model incomplete after extraction: ${after.missing.join(", ")}` };
    }

    return { ok: true, detail: `model installed in ${target}` };
}

// ---------------------------------------------------------------------------
// guided setup
// ---------------------------------------------------------------------------

export interface SetupOptions {
    /** Current config value for kwsModelDir (empty = managed). */
    modelDir?: string;
    onLine: (line: string) => void;
    confirm: (title: string, message: string) => Promise<boolean>;
}

export interface SetupResult extends StepResult {
    status: SherpaStatus;
}

/**
 * Walk the user through whatever is missing. Used by the TUI wake-engine picker
 * and by `/voice sherpa`, so both paths behave identically.
 */
export async function setupSherpaWake(options: SetupOptions): Promise<SetupResult> {
    let status = sherpaStatus(options.modelDir ?? "");

    if (!status.packageInstalled) {
        const agreed = await options.confirm(
            `Install ${KWS_PACKAGE}?`,
            `The offline wake word needs ${KWS_PACKAGE} (about 23 MB, prebuilt binaries for this platform).\n`
                + `It is installed into ${managedDepsDir()} — your project is not touched.`,
        );

        if (!agreed) {
            return { ok: false, detail: "cancelled at the runtime install", status };
        }

        const step = await installSherpaPackage(options.onLine);

        if (!step.ok) {
            return { ok: false, detail: step.detail, status: sherpaStatus(options.modelDir ?? "") };
        }

        options.onLine(step.detail);
        status = sherpaStatus(options.modelDir ?? "");
    }

    if (!status.modelReady) {
        const mb = (KWS_MODEL.bytes / 1024 / 1024).toFixed(1);
        const agreed = await options.confirm(
            "Download the wake-word model?",
            `${KWS_MODEL.label}\n${mb} MB from GitHub, extracted into ${status.modelDir}.\n`
                + "It provides tokens.txt and the encoder/decoder/joiner for the offline spotter.",
        );

        if (!agreed) {
            return { ok: false, detail: "cancelled at the model download", status };
        }

        const step = await downloadKwsModel(options.onLine, status.modelDir);

        if (!step.ok) {
            return { ok: false, detail: step.detail, status: sherpaStatus(options.modelDir ?? "") };
        }

        options.onLine(step.detail);
        status = sherpaStatus(options.modelDir ?? "");
    }

    if (!status.ready) {
        return { ok: false, detail: status.detail, status };
    }

    return { ok: true, detail: status.detail, status };
}
