// Patch: cap pi's image resize dimensions (migrated from extensions/patch-image-resize.js).
//
// What it does: pi builds resize options as `{ ...DEFAULT_OPTIONS, ...options }`, which lets a
// per-model catalog limit (usually 2000px) win over the defaults. This patch injects an explicit
// `maxWidth` / `maxHeight` after the spread so the cap always wins, in the unbundled utils files
// and in the bundled worker chunks.
//
// Params:  PI_IMAGE_RESIZE_WIDTH (default 480), PI_IMAGE_RESIZE_HEIGHT (default 640),
//          PI_IMAGE_RESIZE_PACKAGES (extra package dirs, ";" separated).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { candidatePiDirs, matchingChunks, readTextCached } from "../_shared/pi-packages.js";

const PKG = "@earendil-works/pi-coding-agent";
const CORE_REL = ["dist", "utils", "image-resize-core.js"];
const WORKER_REL = ["dist", "utils", "image-resize-worker.js"];

// Matches the merge site whether it is untouched or already carrying our override.
const MERGE =
  /\{\s*\.\.\.DEFAULT_OPTIONS,\s*\.\.\.options\s*(?:,\s*maxWidth:\s*\d+\s*,\s*maxHeight:\s*\d+\s*)?\}/g;
// Matches only a merge site that already carries the override (used for revert).
const INJECTED = /(\{\s*\.\.\.DEFAULT_OPTIONS,\s*\.\.\.options)\s*,\s*maxWidth:\s*\d+\s*,\s*maxHeight:\s*\d+\s*\}/g;

function mergeSite(content) {
  return content.includes("DEFAULT_OPTIONS") && content.includes("...options");
}

export default {
  id: "image-resize",
  name: "Cap image resize dimensions",
  description:
    "Injects maxWidth/maxHeight after `{ ...DEFAULT_OPTIONS, ...options }` so pi downscales images to the configured cap instead of the per-model catalog limit.",
  version: "2.0.0",
  tags: ["pi", "images", "tokens"],

  params: [
    { key: "maxWidth", env: "PI_IMAGE_RESIZE_WIDTH", default: 480, type: "int", min: 16, max: 20000 },
    { key: "maxHeight", env: "PI_IMAGE_RESIZE_HEIGHT", default: 640, type: "int", min: 16, max: 20000 },
    { key: "packages", env: "PI_IMAGE_RESIZE_PACKAGES", default: [], type: "list" },
  ],

  /** Files to look at: the two utils modules (required) and any bundle chunk mentioning the anchor. */
  targets(ctx) {
    const out = [];
    for (const dir of candidatePiDirs(ctx)) {
      for (const rel of [CORE_REL, WORKER_REL]) {
        const file = join(dir, ...rel);
        if (!existsSync(file)) continue;
        const content = readTextCached(file);
        // Only files that actually carry the merge site; the core module is the one we
        // insist on, so a missing anchor there is reported as a conflict.
        if (content === undefined || !mergeSite(content)) continue;
        const label = rel[rel.length - 1];
        out.push({ file, content, required: label === "image-resize-core.js", label });
      }
      for (const chunk of matchingChunks(dir, mergeSite)) {
        out.push({ ...chunk, required: false, label: chunk.label });
      }
    }
    return out;
  },

  transform(ctx, file, content) {
    if (!mergeSite(content)) {
      return { unchanged: true, missingAnchor: true, summary: `no image-resize merge site in ${file}` };
    }
    const { maxWidth, maxHeight } = ctx.params;
    let hits = 0;
    const next = content.replace(MERGE, (match) => {
      hits++;
      // Decide the whitespace style from the upstream base only. Testing the whole match would
      // flip to spaced formatting on the *second* pass (our own "maxWidth: 480" contains spaces),
      // which made every apply report drift until it was applied again.
      const base = /^\{\s+\.\.\./.test(match) ? "{ ...DEFAULT_OPTIONS, ...options" : "{...DEFAULT_OPTIONS,...options";
      return `${base}, maxWidth: ${maxWidth}, maxHeight: ${maxHeight} }`;
    });
    if (!hits) {
      return { unchanged: true, missingAnchor: true, summary: "merge site pattern no longer matches upstream code" };
    }
    if (next === content) {
      return { unchanged: true, summary: `already capped at ${maxWidth}x${maxHeight}` };
    }
    return { content: next, summary: `cap image resize at ${maxWidth}x${maxHeight} (${hits} site(s))` };
  },

  /** Strip only the override we injected, leaving upstream whitespace style intact. */
  revert(ctx, file, content) {
    if (!mergeSite(content)) return { unchanged: true, summary: "nothing to revert in this file" };
    const next = content.replace(INJECTED, (_match, base) => {
      const minified = !/\s/.test(base);
      return minified ? `${base}}` : `${base} }`;
    });
    if (next === content) return { unchanged: true, summary: "no injected override found" };
    return { content: next, summary: "removed the injected maxWidth/maxHeight override" };
  },

  verify(ctx, file, content) {
    if (!mergeSite(content)) return { ok: true, message: "anchor absent, nothing to verify" };
    const matches = content.match(MERGE) || [];
    if (!matches.length) {
      return { ok: false, message: "merge site anchor disappeared after patching" };
    }
    const want = `maxWidth: ${ctx.params.maxWidth}, maxHeight: ${ctx.params.maxHeight}`;
    const bad = matches.filter((m) => !m.replace(/\s+/g, " ").includes(want.replace(/\s+/g, " ")));
    if (bad.length) {
      return { ok: false, message: `override missing from ${bad.length} merge site(s): ${bad[0].slice(0, 120)}` };
    }
    return { ok: true, message: `${matches.length} merge site(s) capped at ${ctx.params.maxWidth}x${ctx.params.maxHeight}` };
  },

  /** Directories worth watching for a pi upgrade / reinstall. */
  watch(ctx) {
    return candidateDirs(ctx);
  },
};
