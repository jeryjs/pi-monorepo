/**
 * Compaction Model Override
 *
 * Pi's built-in compaction summarizes with the currently active model and the
 * session's current thinking level. This extension keeps Pi's exact summarization
 * behavior (same prompts, same split-turn history/prefix merging, same file
 * tracking, same usage accounting) but swaps in a dedicated, large-context free
 * model, with failover across providers.
 *
 * How it works: `session_before_compact` fires before every manual (`/compact`)
 * and automatic (threshold / overflow) compaction. We call Pi's own exported
 * `compact()` with a chosen model and a stream function that resolves auth
 * through the model registry, then hand the result back to Pi.
 *
 * Returning `undefined` (no candidate worked, or everything errored) falls back
 * to Pi's default compaction with the active model, so compaction never becomes
 * worse than stock behavior.
 *
 * Notes:
 * - Summarization uses the model's own output limit, clamped so input + output
 *   fit that model's context window (pi-ai `clampMaxTokensToContext`). Each
 *   candidate below carries >= 256K context, enough for a ~220K-token span.
 * - Compaction runs inline at turn boundaries, so the thinking level is pinned
 *   low here instead of inheriting a `high`/`max` session level.
 * - Pi does not carry file lists forward from extension-provided compactions
 *   (`fromHook: true`), so we merge the previous compaction's lists into the
 *   preparation ourselves to keep cumulative `<read-files>`/`<modified-files>`.
 */

import {
	type ExtensionAPI,
	type FileOperations,
	type SessionEntry,
	compact,
} from "@earendil-works/pi-coding-agent";

/** Ordered failover chain. The first model that produces a summary wins. */
const CANDIDATES: Array<{ provider: string; id: string }> = [
	{ provider: "r-gemini", id: "models/gemini-3.6-flash" },
	// Nemotron 3 Ultra 550B - 1M ctx / 65.5K out, free natively on NIM.
	{ provider: "nvidia", id: "nvidia/nemotron-3-ultra-550b-a55b" },
	// Same model through Kilo's free gateway.
	{ provider: "kilo", id: "nvidia/nemotron-3-ultra-550b-a55b:free" },
	// Same model through OpenRouter (own key, so not shared-capacity capped).
	{ provider: "openrouter", id: "nvidia/nemotron-3-ultra-550b-a55b:free" },
	// Inkling - 1M ctx / 262K out. `cline/thinkingmachines/inkling:free` proxies
	// OpenRouter's shared capacity and 429s once the daily cap is hit; drop it to
	// the end of the chain rather than remove it.
	{ provider: "openrouter", id: "thinkingmachines/inkling:free" },
	{ provider: "cline", id: "thinkingmachines/inkling:free" },
];

/**
 * Thinking level for summarization. "low" keeps a mechanical formatting task
 * cheap; use "off" for maximum speed or "medium" if summaries lose detail.
 */
const THINKING_LEVEL = "low";

/** Per-candidate wall clock budget. A 220K-token prompt on a free tier is slow. */
const TIMEOUT_MS = 4 * 60 * 1000;

/**
 * Merge the previous compaction's file lists so tracking stays cumulative.
 *
 * `prepareCompaction()` skips those lists when the previous compaction was
 * extension-provided, which ours always is, so we redo the carry here.
 */
function mergePreviousFileOps(fileOps: FileOperations, branchEntries: readonly SessionEntry[]): FileOperations {
	const read = new Set(fileOps.read);
	const written = new Set(fileOps.written);
	const edited = new Set(fileOps.edited);

	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i];
		if (entry.type !== "compaction") continue;
		const details = entry.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
		if (Array.isArray(details?.readFiles)) for (const f of details.readFiles) if (typeof f === "string") read.add(f);
		if (Array.isArray(details?.modifiedFiles)) for (const f of details.modifiedFiles) if (typeof f === "string") edited.add(f);
		break;
	}

	return { read, written, edited };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, branchEntries, customInstructions, signal } = event;

		const models = [];
		for (const candidate of CANDIDATES) {
			const model = ctx.modelRegistry.find(candidate.provider, candidate.id);
			if (model) models.push(model);
		}
		// Prefer models whose provider has credentials, but never filter everything
		// out: env-var keys can be missing from the availability snapshot.
		const withAuth = models.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
		const usable = withAuth.length > 0 ? withAuth : models;
		if (usable.length === 0) return;

		const augmented = {
			...preparation,
			fileOps: mergePreviousFileOps(preparation.fileOps, branchEntries),
		};

		// Resolve credentials at request time for whichever model is passed in.
		const streamFn = (model: any, context: any, options: any): any =>
			ctx.modelRegistry.streamSimple(model, context, { ...options, timeoutMs: TIMEOUT_MS });

		for (const model of usable) {
			if (signal.aborted) return;
			const label = `${model.provider}/${model.id}`;
			try {
				const result = await compact(
					augmented,
					model,
					undefined,
					undefined,
					customInstructions,
					signal,
					THINKING_LEVEL as any,
					streamFn,
					undefined,
					undefined,
					undefined,
					undefined,
				);
				if (signal.aborted) return;
				if (!result.summary?.trim()) {
					ctx.ui.notify(`Compaction: empty summary from ${label}, trying next model`, "warning");
					continue;
				}
				ctx.ui.notify(`Compaction summarized by ${label}`, "info");
				return {
					compaction: {
						summary: result.summary,
						firstKeptEntryId: result.firstKeptEntryId,
						tokensBefore: result.tokensBefore,
						usage: result.usage,
						details: result.details,
					},
				};
			} catch (error) {
				if (signal.aborted) return;
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Compaction: ${label} failed (${message}), trying next model`, "warning");
			}
		}

		ctx.ui.notify("Compaction: no fallback model succeeded, using the active model", "warning");
		return;
	});
}
