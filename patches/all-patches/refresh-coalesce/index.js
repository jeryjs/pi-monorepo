// Patch: coalesce concurrent ModelRuntime.refresh() calls (migrated from scripts/apply-optimizations.mjs).
//
// What it does: when pi registers N providers it fires N `void this.refresh(...)` calls, and each
// one reloads every provider config and rebuilds the whole model snapshot. This patch splits the
// public `refresh()` from a private `refreshCatalog()` and lets concurrent callers that ask for the
// same thing share one in-flight promise. Scoped refreshes (`providers`, `signal`) and network
// semantics are passed through untouched, so behaviour only changes by being cheaper.
//
// Applied in two shapes, because pi ships both:
//   * `dist/core/model-runtime.js` — readable class source (method + new field).
//   * `dist/bundle/chunks/*.js`    — the minified single-line bundle of the same class.
//
// Revert is a transform (not a backup restore) so a later pi upgrade that keeps our marker can
// still be cleaned without losing unrelated upstream changes.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { candidatePiDirs, matchingChunks, readTextCached } from "../_shared/pi-packages.js";

const MARKER = "PATCH(pi-refresh-coalesce-v2)";
const CORE_REL = ["dist", "core", "model-runtime.js"];

const UNB_METHOD_OLD = `    async refresh(options = {}) {
        this.config = await ModelConfig.load(this.modelsPath);`;
const UNB_METHOD_NEW = `    async refresh(options = {}) {
        // ${MARKER}: coalesce concurrent whole-catalog refreshes. Registering N
        // providers fires N \`void this.refresh(...)\` calls; without coalescing
        // each one rebuilds every provider and the whole model snapshot.
        // Only refreshes with identical semantics share a promise, so network /
        // availability / scoped-refresh behaviour is unchanged.
        if (options.providers || options.signal)
            return this.refreshCatalog(options);
        const allowNetwork = options.allowNetwork ?? this.modelNetworkEnabled;
        if (this.refreshInFlight && this.refreshInFlight.allowNetwork === allowNetwork)
            return this.refreshInFlight.promise;
        const promise = this.refreshCatalog(options).finally(() => {
            if (this.refreshInFlight?.promise === promise)
                this.refreshInFlight = null;
        });
        this.refreshInFlight = { allowNetwork, promise };
        return promise;
    }
    async refreshCatalog(options = {}) {
        this.config = await ModelConfig.load(this.modelsPath);`;

const UNB_FIELD_OLD = `    modelsPath;
    modelNetworkEnabled;
    config;`;
const UNB_FIELD_NEW = `    modelsPath;
    modelNetworkEnabled;
    /** ${MARKER}: in-flight whole-catalog refresh + its effective allowNetwork. */
    refreshInFlight = null;
    config;`;

const BUNDLE_OLD = `async refresh(options={}){if(this.config=await ModelConfig.load(this.modelsPath),`;
const BUNDLE_NEW = `async refresh(options={}){/*${MARKER}*/if(options.providers||options.signal)return this.refreshCatalog(options);const allowNetwork=options.allowNetwork??this.modelNetworkEnabled;if(this.refreshInFlight&&this.refreshInFlight.allowNetwork===allowNetwork)return this.refreshInFlight.promise;const promise=this.refreshCatalog(options).finally(()=>{if(this.refreshInFlight?.promise===promise)this.refreshInFlight=null});this.refreshInFlight={allowNetwork,promise};return promise}async refreshCatalog(options={}){if(this.config=await ModelConfig.load(this.modelsPath),`;

/** Does this file carry the bundled (minified) refresh, untouched or already coalesced? */
const hasBundleSite = (content) => content.includes(BUNDLE_OLD) || content.includes(MARKER);
/** Does this file carry the readable class source we rewrite? */
const hasSourceSite = (content) => content.includes(UNB_METHOD_OLD) || (content.includes(MARKER) && content.includes("refreshInFlight"));

export default {
  id: "refresh-coalesce",
  name: "Coalesce model catalog refreshes",
  description:
    "Shares one in-flight promise between concurrent ModelRuntime.refresh() calls so provider registration stops rebuilding the whole model catalog N times at startup.",
  version: "2.0.0",
  tags: ["pi", "startup", "performance"],
  params: [{ key: "packages", env: "PI_REFRESH_COALESCE_PACKAGES", default: [], type: "list" }],

  targets(ctx) {
    const out = [];
    for (const dir of candidatePiDirs(ctx)) {
      const core = join(dir, ...CORE_REL);
      if (existsSync(core)) {
        const content = readTextCached(core);
        // The readable source is the file we must be able to patch; a pi build without it
        // (pure bundle distribution) is fine as long as some chunk carries the class.
        if (content !== undefined && hasSourceSite(content)) {
          out.push({ file: core, content, required: false, label: "model-runtime.js" });
        }
      }
      for (const chunk of matchingChunks(dir, hasBundleSite)) {
        out.push({ ...chunk, required: false, label: `chunk ${chunk.label}` });
      }
    }
    return out;
  },

  transform(ctx, file, content) {
    if (content.includes(MARKER)) {
      return { unchanged: true, summary: "refresh already coalesced" };
    }
    if (content.includes(BUNDLE_OLD)) {
      const next = content.replace(BUNDLE_OLD, BUNDLE_NEW);
      if (next === content) return { unchanged: true };
      return { content: next, summary: "coalesced ModelRuntime.refresh (bundle)" };
    }
    if (content.includes(UNB_METHOD_OLD) && content.includes(UNB_FIELD_OLD)) {
      const next = content.replace(UNB_METHOD_OLD, UNB_METHOD_NEW).replace(UNB_FIELD_OLD, UNB_FIELD_NEW);
      if (next === content) return { unchanged: true };
      return { content: next, summary: "coalesced ModelRuntime.refresh + added refreshInFlight field" };
    }
    if (content.includes(UNB_METHOD_OLD)) {
      return { unchanged: true, missingAnchor: true, summary: "refresh() found but the class field block changed upstream" };
    }
    return { unchanged: true, missingAnchor: true, summary: `no refresh() merge site in ${file} (pi version changed?)` };
  },

  revert(ctx, file, content) {
    if (!content.includes(MARKER)) return { unchanged: true, summary: "nothing to revert in this file" };
    let next = content;
    if (next.includes(BUNDLE_NEW)) next = next.replace(BUNDLE_NEW, BUNDLE_OLD);
    if (next.includes(UNB_METHOD_NEW)) next = next.replace(UNB_METHOD_NEW, UNB_METHOD_OLD);
    if (next.includes(UNB_FIELD_NEW)) next = next.replace(UNB_FIELD_NEW, UNB_FIELD_OLD);
    if (next === content) {
      return { unchanged: true, missingAnchor: true, summary: "marker present but the injected code no longer matches" };
    }
    return { content: next, summary: "removed refresh coalescing" };
  },
};
