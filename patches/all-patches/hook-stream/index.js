// Patch: expose pi's provider-request hook pipeline to extensions (pi-hook-stream).
//
// Why: `before_provider_headers` / `before_provider_request` / `after_provider_response` /
// `provider_stream_event` are installed by `core/sdk.ts` on the Agent it builds for the session.
// `ModelRegistry.streamSimple()` — the only streaming entry point extensions can reach — resolves
// auth and calls the provider directly, so a request made outside the agent loop (an extension
// serving pi's models over HTTP, a script, a nested agent) never reaches those handlers. Extensions
// that mutate requests or account for credentials (key pools like pi-keyrouter, header injectors,
// payload rewriters) silently do nothing for such requests.
//
// What it adds (additive only — no existing caller changes behaviour):
//   * `ExtensionRunner#createProviderHooks(modelOverride)` — returns the same four callbacks the
//     agent loop installs, built from the runner's own emitters (no duplicated hook logic).
//   * `ExtensionContext#providerHooks()` — the same set, for the session's current model.
//   * optional `ctxOverride` on `emit()`, `emitBeforeProviderRequest()`,
//     `emitBeforeProviderHeaders()` so a hook can be emitted with `ctx.model` pointing at the model
//     actually being requested (credential pools key off `ctx.model`, not the payload).
//
// Usage from an extension:
//   const runtime = ctx.modelRegistry.runtime;
//   const stream = runtime.streamSimple(model, context, { ...ctx.providerHooks(model), ...opts });
//
// Applied in two shapes, because pi ships both:
//   * `dist/core/extensions/runner.js`      — readable class source.
//   * `dist/bundle/chunks/*.js`             — the bundled single-line copy of the same class.
//   * `dist/core/extensions/types.d.ts`     — the ExtensionContext declaration (optional target).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { candidatePiDirs, matchingChunks, readTextCached } from "../_shared/pi-packages.js";

const MARKER = "PATCH(pi-hook-stream-v1)";
const RUNNER_REL = ["dist", "core", "extensions", "runner.js"];
const TYPES_REL = ["dist", "core", "extensions", "types.d.ts"];

/* ------------------------------------------------------------------ source anchors */

const CTX_OLD = `            getSystemPrompt: () => {
                runner.assertActive();
                return runner.getSystemPromptFn();
            },
        };
    }`;
const CTX_NEW = `            getSystemPrompt: () => {
                runner.assertActive();
                return runner.getSystemPromptFn();
            },
            /** ${MARKER}: provider-request hook set for this session's model. */
            providerHooks: (model) => {
                runner.assertActive();
                return runner.createProviderHooks(model);
            },
        };
    }`;

const METHOD_ANCHOR_OLD = `    /**
     * Create the context for executing the tool call \`toolCallId\`: the extension context plus`;
const METHOD_ANCHOR_NEW = `    /**
     * ${MARKER}: the provider-request hooks pi's own agent loop installs on every request,
     * assembled from this runner's emitters so there is one implementation of each hook.
     *
     * \`modelOverride\` becomes \`ctx.model\` inside those handlers: provider-scoped extensions
     * (credential pools, routers) read the provider from the context, not from the payload, so an
     * out-of-band request must say which model it is actually asking for.
     */
    createProviderHooks(modelOverride) {
        const runner = this;
        const contextFor = () => {
            const ctx = runner.createContext();
            if (!modelOverride) return ctx;
            // createContext() hands back a fresh object with live getters; shadow only \`model\`.
            return Object.defineProperties(Object.defineProperties({}, Object.getOwnPropertyDescriptors(ctx)), {
                model: { value: modelOverride, enumerable: true, configurable: true },
            });
        };
        return {
            transformHeaders: async (headers) => runner.hasHandlers("before_provider_headers")
                ? runner.emitBeforeProviderHeaders(headers, contextFor())
                : headers,
            onPayload: async (payload) => runner.hasHandlers("before_provider_request")
                ? runner.emitBeforeProviderRequest(payload, contextFor())
                : payload,
            onResponse: async (response) => {
                if (!runner.hasHandlers("after_provider_response")) return;
                await runner.emit({ type: "after_provider_response", status: response.status, headers: response.headers }, contextFor());
            },
            onProviderStreamEvent: async (data, model) => {
                if (!runner.hasHandlers("provider_stream_event")) return;
                await runner.emit({ type: "provider_stream_event", data, provider: model.provider, api: model.api, model: model.id }, contextFor());
            },
        };
    }
${METHOD_ANCHOR_OLD}`;

const EMIT_OLD = `    async emit(event) {
        const ctx = this.createContext();`;
const EMIT_NEW = `    async emit(event, ctxOverride) {
        // ${MARKER}: optional context, so out-of-band provider hooks see the request's model.
        const ctx = ctxOverride ?? this.createContext();`;

const REQ_OLD = `    async emitBeforeProviderRequest(payload) {
        const ctx = this.createContext();`;
const REQ_NEW = `    async emitBeforeProviderRequest(payload, ctxOverride) {
        const ctx = ctxOverride ?? this.createContext();`;

const HDR_OLD = `    async emitBeforeProviderHeaders(headers) {
        const ctx = this.createContext();`;
const HDR_NEW = `    async emitBeforeProviderHeaders(headers, ctxOverride) {
        const ctx = ctxOverride ?? this.createContext();`;

/* ------------------------------------------------------------------ bundle anchors */

const B_CTX_OLD = `getSystemPrompt:()=>(runner.assertActive(),runner.getSystemPromptFn())}}createToolContext(toolCallId,signal){`;
const B_CTX_NEW = `getSystemPrompt:()=>(runner.assertActive(),runner.getSystemPromptFn()),providerHooks:model=>(runner.assertActive(),runner.createProviderHooks(model))}}createProviderHooks(modelOverride){let runner=this,contextFor=()=>{let ctx=runner.createContext();if(!modelOverride)return ctx;return Object.defineProperties(Object.defineProperties({},Object.getOwnPropertyDescriptors(ctx)),{model:{value:modelOverride,enumerable:true,configurable:true}})};return{transformHeaders:async headers=>runner.hasHandlers("before_provider_headers")?runner.emitBeforeProviderHeaders(headers,contextFor()):headers,onPayload:async payload=>runner.hasHandlers("before_provider_request")?runner.emitBeforeProviderRequest(payload,contextFor()):payload,onResponse:async response=>{if(runner.hasHandlers("after_provider_response"))await runner.emit({type:"after_provider_response",status:response.status,headers:response.headers},contextFor())},onProviderStreamEvent:async(data,model)=>{if(runner.hasHandlers("provider_stream_event"))await runner.emit({type:"provider_stream_event",data,provider:model.provider,api:model.api,model:model.id},contextFor())}}}createToolContext(toolCallId,signal){`;

const B_EMIT_OLD = `async emit(event){let ctx=this.createContext(),`;
const B_EMIT_NEW = `async emit(event,ctxOverride){let ctx=ctxOverride??this.createContext(),`;

const B_REQ_OLD = `emitBeforeProviderRequest(payload){let ctx=this.createContext(),`;
const B_REQ_NEW = `emitBeforeProviderRequest(payload,ctxOverride){let ctx=ctxOverride??this.createContext(),`;

const B_HDR_OLD = `emitBeforeProviderHeaders(headers){let ctx=this.createContext()`;
const B_HDR_NEW = `emitBeforeProviderHeaders(headers,ctxOverride){let ctx=ctxOverride??this.createContext()`;

/* ------------------------------------------------------------------ d.ts anchors */

const T_OLD = `    /** Get the current effective system prompt. */
    getSystemPrompt(): string;
}`;
const T_NEW = `    /** Get the current effective system prompt. */
    getSystemPrompt(): string;
    /** ${MARKER}: provider-request hook set, spread into stream options.
     *  \`model\` overrides \`ctx.model\` inside the handlers (defaults to the session model). */
    providerHooks(model?: Model<any>): {
        transformHeaders?(headers: Record<string, string>): Promise<Record<string, string>>;
        onPayload?(payload: unknown): Promise<unknown>;
        onResponse?(response: { status: number; headers: Record<string, string> }): Promise<void>;
        onProviderStreamEvent?(data: unknown, model: Model<any>): Promise<void>;
    };
}`;

/** Does this file carry the readable runner source we rewrite? */
const hasSourceSite = (content) => content.includes(CTX_OLD) || content.includes(MARKER);
/** Does this file carry the bundled copy of the runner class? */
const hasBundleSite = (content) => content.includes(B_CTX_OLD) || content.includes(B_CTX_NEW);

function applySource(content) {
    let next = content;
    const steps = [];

    if (!next.includes(MARKER)) {
        // 1. the method itself (inserted ahead of its sibling factory).
        if (next.includes(METHOD_ANCHOR_OLD)) {
            next = next.replace(METHOD_ANCHOR_OLD, METHOD_ANCHOR_NEW);
            steps.push("added ExtensionRunner#createProviderHooks");
        } else {
            return { missingAnchor: true, summary: "createToolContext() doc block changed upstream" };
        }
        // 2. the context accessor.
        if (next.includes(CTX_OLD)) {
            next = next.replace(CTX_OLD, CTX_NEW);
            steps.push("added ExtensionContext#providerHooks");
        } else {
            return { missingAnchor: true, summary: "createContext() tail changed upstream" };
        }
    }

    // 3. optional ctx overrides on the emitters. Each is independent and additive.
    for (const [label, oldText, newText] of [
        ["emit", EMIT_OLD, EMIT_NEW],
        ["emitBeforeProviderRequest", REQ_OLD, REQ_NEW],
        ["emitBeforeProviderHeaders", HDR_OLD, HDR_NEW],
    ]) {
        if (next.includes(newText)) continue;
        if (next.includes(oldText)) {
            next = next.replace(oldText, newText);
            steps.push(`accepts ctx override in ${label}`);
        } else {
            return { missingAnchor: true, summary: `${label}() signature changed upstream` };
        }
    }

    if (next === content) return { unchanged: true, summary: "hook stream already exposed" };
    return { content: next, summary: steps.join(", ") || "hook stream exposed" };
}

function revertSource(content) {
    let next = content;
    const steps = [];
    for (const [label, oldText, newText] of [
        ["emit", EMIT_OLD, EMIT_NEW],
        ["emitBeforeProviderRequest", REQ_OLD, REQ_NEW],
        ["emitBeforeProviderHeaders", HDR_OLD, HDR_NEW],
        ["createContext", CTX_OLD, CTX_NEW],
        ["createProviderHooks", METHOD_ANCHOR_OLD, METHOD_ANCHOR_NEW],
    ]) {
        if (!next.includes(newText)) continue;
        next = next.replace(newText, oldText);
        steps.push(`removed ${label}`);
    }
    if (next === content) return { unchanged: true, summary: "nothing to revert" };
    return { content: next, summary: steps.join(", ") };
}

export default {
    id: "hook-stream",
    name: "Expose provider request hooks to extensions",
    description:
        "Adds ExtensionRunner#createProviderHooks()/ExtensionContext#providerHooks() so an extension can stream through pi's own before_provider_headers, before_provider_request, after_provider_response and provider_stream_event handlers. Lets out-of-band requests (HTTP gateways, scripts) see key pools and payload transforms.",
    version: "1.0.0",
    tags: ["pi", "extensions", "providers"],
    params: [],

    targets(ctx) {
        const out = [];
        for (const dir of candidatePiDirs(ctx)) {
            const runner = join(dir, ...RUNNER_REL);
            if (existsSync(runner)) {
                const content = readTextCached(runner);
                if (content !== undefined && hasSourceSite(content)) {
                    out.push({ file: runner, content, required: false, label: "extensions/runner.js" });
                }
            }
            for (const chunk of matchingChunks(dir, hasBundleSite)) {
                out.push({ ...chunk, required: false, label: `chunk ${chunk.label}` });
            }
            const types = join(dir, ...TYPES_REL);
            if (existsSync(types)) {
                const content = readTextCached(types);
                if (content !== undefined && (content.includes(T_OLD) || content.includes(MARKER))) {
                    out.push({ file: types, content, required: false, label: "extensions/types.d.ts" });
                }
            }
        }
        return out;
    },

    transform(ctx, file, content) {
        if (file.endsWith("types.d.ts")) {
            if (content.includes(MARKER)) return { unchanged: true, summary: "ExtensionContext already declares providerHooks" };
            if (!content.includes(T_OLD)) {
                return { unchanged: true, missingAnchor: true, summary: "ExtensionContext tail changed upstream" };
            }
            return { content: content.replace(T_OLD, T_NEW), summary: "declared ExtensionContext#providerHooks" };
        }
        if (content.includes(B_CTX_OLD) || content.includes(B_CTX_NEW)) {
            if (content.includes(B_CTX_NEW)) return { unchanged: true, summary: "hook stream already exposed (bundle)" };
            let next = content.replace(B_CTX_OLD, B_CTX_NEW);
            const missing = [B_EMIT_OLD, B_REQ_OLD, B_HDR_OLD].filter((anchor) => !next.includes(anchor));
            if (missing.length) {
                return { unchanged: true, missingAnchor: true, summary: "bundle emitters changed upstream" };
            }
            next = next
                .replace(B_EMIT_OLD, B_EMIT_NEW)
                .replace(B_REQ_OLD, B_REQ_NEW)
                .replace(B_HDR_OLD, B_HDR_NEW);
            return { content: next, summary: "hook stream exposed (bundle)" };
        }
        if (content.includes(MARKER) && !content.includes(CTX_OLD)) {
            return { unchanged: true, summary: "hook stream already exposed" };
        }
        return applySource(content);
    },

    revert(ctx, file, content) {
        if (file.endsWith("types.d.ts")) {
            if (!content.includes(T_NEW)) return { unchanged: true, summary: "nothing to revert in types" };
            return { content: content.replace(T_NEW, T_OLD), summary: "removed providerHooks declaration" };
        }
        if (content.includes(B_CTX_NEW)) {
            let next = content
                .replace(B_CTX_NEW, B_CTX_OLD)
                .replace(B_EMIT_NEW, B_EMIT_OLD)
                .replace(B_REQ_NEW, B_REQ_OLD)
                .replace(B_HDR_NEW, B_HDR_OLD);
            if (next === content) {
                return { unchanged: true, missingAnchor: true, summary: "marker present but injected bundle code no longer matches" };
            }
            return { content: next, summary: "removed hook stream exposure (bundle)" };
        }
        return revertSource(content);
    },

    verify(ctx, file, content) {
        // Three shapes: the .d.ts declaration, the bundled single-line copy (which carries no
        // comment marker), and the readable runner source (which does). Check the shape the file
        // actually is instead of demanding the source marker everywhere.
        const ok = file.endsWith("types.d.ts")
            ? content.includes("providerHooks")
            : content.includes(B_REQ_NEW) && content.includes(B_CTX_NEW)
                ? true
                : content.includes(MARKER) && content.includes("createProviderHooks");
        return { ok, message: ok ? "provider hooks exposed" : "provider hooks missing" };
    },
};
