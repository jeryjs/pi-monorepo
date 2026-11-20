/**
 * pi-reverse-gateway - serve pi's *live* provider registry as OpenAI + Anthropic compatible APIs.
 *
 * Why this exists (and how it differs from pi-model-proxy / pi-gateway / pi-openai-proxy):
 * those either run in their own process and re-read ~/.pi/agent/models.json + auth.json, or they
 * call pi-ai's low-level `models.streamSimple()`. Both miss two things:
 *
 *   1. providers registered *at runtime* by other extensions (pi-free, cx-providers, virtual
 *      models, ...) - they only exist in `ctx.modelRegistry`;
 *   2. pi's provider hook pipeline - `before_provider_headers`, `before_provider_request`,
 *      `after_provider_response`, `provider_stream_event`. Those live on the session's Agent,
 *      which extensions cannot reach, so credential pools (pi-keyrouter), header injectors and
 *      payload rewriters never see an out-of-band request.
 *
 * This extension runs the HTTP server *inside* the pi process, resolves every request through
 * `ctx.modelRegistry` (the same instance `pi.registerProvider()` mutates) and streams through
 * `registry.streamSimple()` with the hook set from `ctx.providerHooks(model)` - the additive
 * `hook-stream` patch in ~/.pi/agent/patches. Every request therefore travels pi's real path,
 * with pi's own OAuth/credential stores, retries, transforms and key pools.
 *
 * Endpoints
 *   GET  /health
 *   GET  /v1/models                     OpenAI + Anthropic model list
 *   GET  /v1/models/{id}                OpenAI model object
 *   POST /v1/chat/completions           OpenAI Chat Completions (SSE + JSON, tools)
 *   POST /v1/responses                  OpenAI Responses API (SSE events + JSON, tools)
 *   POST /v1/messages                   Anthropic Messages (SSE + JSON, tools, thinking)
 *   POST /v1/messages/count_tokens      Anthropic token estimate
 *
 * Environment
 *   PI_REVERSE_GATEWAY_HOST           bind address      (default 127.0.0.1)
 *   PI_REVERSE_GATEWAY_PORT           port              (default 8792)
 *   PI_REVERSE_GATEWAY_AUTH_TOKEN     require this bearer token / x-api-key (default: none)
 *   PI_REVERSE_GATEWAY_AUTO_START     "1" starts the server whenever a session opens
 *   PI_REVERSE_GATEWAY_LOG            off | error | all                     (default all)
 *   PI_REVERSE_GATEWAY_LOG_FILE       NDJSON log path   (default ~/.pi/agent/pi-reverse-gateway.ndjson)
 *   PI_REVERSE_GATEWAY_LOG_MAX_BODY   body bytes kept for logs             (default 4096)
 *   PI_REVERSE_GATEWAY_SCOPE          "all" widens the default (scoped) model list
 *
 * Enable
 *   pi --gateway             start the server for every session (default: off - nothing runs)
 *   /gateway start           or start it on demand from inside a session
 *
 * Transcript
 *   Every logged exchange is appended to the session as a custom entry (zero LLM context cost)
 *   and drawn in the TUI: one summary line when collapsed, the full request/response envelope
 *   when expanded with the configured expand key. Errors are always shown.
 *
 * Command
 *   /gateway            status        /gateway start | stop | restart
 *   /gateway models     list served   /gateway scoped     toggle all <-> scoped (default: scoped)
 *   /gateway log [n]    recent requests from the in-memory ring
 *   /gateway log LEVEL  off | error | all - transcript + NDJSON verbosity
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	estimateTokens,
} from "@earendil-works/pi-coding-agent";
// Rendered transcript entries: pi's own component primitives, so gateway rows look native.
import { Box, Text } from "@earendil-works/pi-tui";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	JsonObject,
	Message,
	Model,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { EntryRenderer } from "@earendil-works/pi-coding-agent";

type Registry = ExtensionContext["modelRegistry"];
type PiContext = { systemPrompt?: string; messages: Message[]; tools?: Tool[] };
/** Structurally identical to pi-tui's AutocompleteItem, kept local so the extension needs no
 *  extra package import just for a shape. */
type AutocompleteItem = { value: string; label: string; description?: string };

/* ------------------------------------------------------------------ configuration */

const HOST = process.env.PI_REVERSE_GATEWAY_HOST ?? "0.0.0.0";
const PORT = Number(process.env.PI_REVERSE_GATEWAY_PORT ?? 8792);
const AUTH_TOKEN = process.env.PI_REVERSE_GATEWAY_AUTH_TOKEN?.trim() || undefined;
/** Opt-in only: `pi --gateway`, or PI_REVERSE_GATEWAY_AUTO_START=1. Nothing listens otherwise. */
const AUTO_START_ENV = process.env.PI_REVERSE_GATEWAY_AUTO_START === "1";
const FLAG_NAME = "gateway";
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const KEEPALIVE_MS = 15_000;

const LOG_LEVELS = ["off", "error", "all"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];
const LOG_LEVEL: LogLevel = (() => {
	const raw = (process.env.PI_REVERSE_GATEWAY_LOG ?? "all").trim().toLowerCase();
	return (LOG_LEVELS as readonly string[]).includes(raw) ? (raw as LogLevel) : "all";
})();
const LOG_FILE =
	process.env.PI_REVERSE_GATEWAY_LOG_FILE?.trim() || join(homedir(), ".pi", "agent", "pi-reverse-gateway.ndjson");
const LOG_MAX_BODY = Number(process.env.PI_REVERSE_GATEWAY_LOG_MAX_BODY ?? 4096);
const LOG_RETENTION = 200;
/** Custom-entry type for transcript rows. Custom entries never reach the LLM context. */
const LOG_ENTRY_TYPE = "pi-reverse-gateway";

const SCOPE_MODES = ["all", "scoped"] as const;
type ScopeMode = (typeof SCOPE_MODES)[number];

const REASONING_LEVELS: Record<string, ThinkingLevel> = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

/* ------------------------------------------------------------------ provider hooks (hook-stream patch) */

type ProviderHooks = {
	transformHeaders?: (headers: Record<string, string>) => Promise<Record<string, string>>;
	onPayload?: (payload: unknown) => Promise<unknown>;
	onResponse?: (response: { status: number; headers: Record<string, string> }) => Promise<void>;
	onProviderStreamEvent?: (data: unknown, model: Model<Api>) => Promise<void>;
};

let warnedNoHooks = false;

/**
 * The request hook set pi installs on its own agent loop, replayed for an out-of-band request.
 * Present only when the `hook-stream` patch is applied; without it pi still serves the model,
 * but key pools and payload transforms do not observe the request.
 */
function providerHooks(ctx: ExtensionContext, model: Model<Api>, notify: (m: string) => void): ProviderHooks {
	const fn = (ctx as unknown as { providerHooks?: (m: Model<Api>) => ProviderHooks }).providerHooks;
	if (typeof fn !== "function") {
		if (!warnedNoHooks) {
			warnedNoHooks = true;
			notify("pi-reverse-gateway: provider hooks unavailable - run `node ~/.pi/agent/patches/mainrunner.js run`");
		}
		return {};
	}
	try {
		return fn.call(ctx, model);
	} catch {
		return {};
	}
}

/* ------------------------------------------------------------------ logging */

interface GatewayLogRecord {
	seq: number;
	ts: number;
	method: string;
	path: string;
	status: number;
	durationMs: number;
	level: "info" | "warning" | "error";
	model?: string;
	provider?: string;
	stream?: boolean;
	error?: string;
	request?: unknown;
	response?: unknown;
	usage?: { input: number; output: number; total: number };
}

function clipForLog(value: unknown): unknown {
	if (value === undefined) return undefined;
	let text: string;
	try {
		text = JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		text = String(value);
	}
	text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/\\?\\?\\"/g, '"') // Clean and make human readable.
	if (text.length <= LOG_MAX_BODY) return value;
	return { clipped: true, bytes: text.length, preview: `${text.slice(0, LOG_MAX_BODY*0.1)}\n…${text.slice(text.length - LOG_MAX_BODY*0.9, text.length)}\n(${text.length} total bytes)` };
}

function appendLogFile(record: GatewayLogRecord): void {
	if (!LOG_FILE) return;
	try {
		mkdirSync(join(LOG_FILE, ".."), { recursive: true });
		const size = statSync(LOG_FILE, { throwIfNoEntry: false })?.size ?? 0;
		if (size > 4 * 1024 * 1024) renameSync(LOG_FILE, `${LOG_FILE}.1`);
		appendFileSync(LOG_FILE, `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		// A broken log sink must never take the gateway down.
	}
}

/* ------------------------------------------------------------------ transcript renderer */

/**
 * Draws one logged exchange in the pi transcript.
 *
 * Custom entries are not part of the LLM context, so this is a free, durable record of what
 * the gateway served. Collapsed it is a single summary line; expanding it (the configured
 * tools-expand key) reveals provider, usage and the full request/response envelope.
 *
 * Wrapped in render-safe fallbacks: a renderer that throws would break the transcript.
 */
const renderGatewayEntry: EntryRenderer<GatewayLogRecord> = (entry, { expanded, keyHint }, theme) => {
	const data = entry.data;
	if (!data) return new Text(theme.fg("warning", "[gateway] missing log data"), 0, 0);
	const color = data.level === "error" ? "error" : data.level === "warning" ? "warning" : "success";
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));

	const head: string[] = [
		theme.fg("customMessageLabel", "[gateway]"),
		theme.fg("dim", new Date(data.ts).toLocaleTimeString()),
		data.method,
		theme.fg("accent", data.path),
	];
	if (data.model) head.push(theme.fg("muted", data.model));
	if (data.stream) head.push(theme.fg("dim", "stream"));
	// `ok`/`err` reads better than a bare 200 for a row whose point is whether the request worked.
	// The number is the status the client actually received, which for a mid-stream failure is a
	// 200 that carried an error frame - hence `err 200` rather than a lie about the wire.
	head.push(theme.fg(color, `${data.error ? "err" : "ok"} ${data.status}`));
	head.push(theme.fg("dim", `${data.durationMs}ms`));

	// keyHint reads configured keybindings and can throw before the theme is up; never let that
	// escape into the transcript renderer.
	let hint = "";
	if (!expanded) {
		try {
			hint = ` ${theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`)}`;
		} catch {
			hint = ` ${theme.fg("dim", "(expand for details)")}`;
		}
	}
	box.addChild(new Text(head.join(" ") + hint, 0, 0));
	if (data.error) box.addChild(new Text(theme.fg("error", `error: ${data.error}`), 0, 0));

	if (expanded) {
		const label = (text: string) => theme.fg("muted", text);
		const detail = (name: string, value: string) => box.addChild(new Text(`${label(name.padEnd(9))}${value}`, 0, 0));
		if (data.provider) detail("provider", data.provider);
		if (data.usage) detail("usage", `in ${data.usage.input} · out ${data.usage.output} · total ${data.usage.total}`);
		if (data.request !== undefined) {
			box.addChild(new Text(theme.fg("accent", "request"), 0, 0));
			box.addChild(new Text(stringifyForView(data.request), 0, 0));
		}
		if (data.response !== undefined) {
			box.addChild(new Text(theme.fg("accent", "response"), 0, 0));
			box.addChild(new Text(stringifyForView(data.response), 0, 0));
		}
	}
	return box;
};

/** Printable form of a logged payload; strings pass through, everything else is pretty JSON. */
function stringifyForView(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

/* ------------------------------------------------------------------ content helpers */

/** Flatten any text-bearing content shape (string, part list, OpenAI/Anthropic blocks) to text. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return content == null ? "" : String(content);
	const out: string[] = [];
	for (const raw of content) {
		if (typeof raw === "string") {
			out.push(raw);
			continue;
		}
		if (!raw || typeof raw !== "object") continue;
		const part = raw as Record<string, unknown>;
		// Anthropic tool_result / OpenAI function_call_output nesting.
		if (part.type === "tool_result" || part.type === "function_call_output") {
			out.push(textOf(part.content ?? part.output));
			continue;
		}
		if (typeof part.text === "string") out.push(part.text);
		else if (typeof part.output === "string") out.push(part.output);
	}
	return out.join("");
}

function dataUrlToImage(url: string): ImageContent | undefined {
	const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
	return match ? { type: "image", data: match[2], mimeType: match[1] } : undefined;
}

/** JSON arguments, tolerating the string form every OpenAI-compatible client sends. */
function parseArguments(raw: unknown): JsonObject {
	if (raw && typeof raw === "object") return raw as JsonObject;
	if (typeof raw !== "string" || raw.trim() === "") return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as JsonObject) : {};
	} catch {
		return {};
	}
}

function userContent(content: unknown): string | (TextContent | ImageContent)[] {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return textOf(content);
	const blocks: (TextContent | ImageContent)[] = [];
	for (const raw of content) {
		if (typeof raw === "string") {
			blocks.push({ type: "text", text: raw });
			continue;
		}
		if (!raw || typeof raw !== "object") continue;
		const part = raw as Record<string, unknown>;
		if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
			if (typeof part.text === "string") blocks.push({ type: "text", text: part.text });
			continue;
		}
		if (part.type === "image_url") {
			const url = (part.image_url as { url?: string } | undefined)?.url ?? "";
			const image = dataUrlToImage(url);
			if (image) blocks.push(image);
			continue;
		}
		if (part.type === "input_image") {
			// Responses API: either a string URL or { url }.
			const rawUrl = part.image_url;
			const url = typeof rawUrl === "string" ? rawUrl : ((rawUrl as { url?: string } | undefined)?.url ?? "");
			const image = dataUrlToImage(url);
			if (image) blocks.push(image);
			continue;
		}
		if (part.type === "image") {
			// Anthropic: { source: { type: "base64", media_type, data } }.
			const source = part.source as { type?: string; media_type?: string; data?: string } | undefined;
			if (source?.type === "base64" && source.data) {
				blocks.push({ type: "image", data: source.data, mimeType: source.media_type ?? "image/png" });
			}
		}
	}
	if (blocks.length === 1 && blocks[0].type === "text") return blocks[0].text;
	return blocks;
}

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(
	model: Model<Api>,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

/* ------------------------------------------------------------------ tool name resolution */

/** tool_call_id -> tool name, so a tool result can be rebuilt from protocols that omit it. */
function toolNames(messages: Message[]): Map<string, string> {
	const names = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") names.set(block.id, block.name);
		}
	}
	return names;
}

/* ------------------------------------------------------------------ OpenAI Chat Completions -> pi */

interface OpenAIChatRequest {
	model?: string;
	messages?: Array<Record<string, unknown>>;
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
	max_completion_tokens?: number;
	tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: unknown } }>;
	tool_choice?: unknown;
	reasoning_effort?: string;
	stream_options?: { include_usage?: boolean };
}

function openaiChatToContext(body: OpenAIChatRequest, model: Model<Api>): PiContext {
	const system: string[] = [];
	const messages: Message[] = [];
	const now = Date.now();

	for (const raw of body.messages ?? []) {
		const role = typeof raw.role === "string" ? raw.role : "";
		switch (role) {
			case "system":
			case "developer": {
				const text = textOf(raw.content);
				if (text) system.push(text);
				break;
			}
			case "user": {
				messages.push({ role: "user", content: userContent(raw.content), timestamp: now } satisfies UserMessage);
				break;
			}
			case "assistant": {
				const content: (TextContent | ToolCall)[] = [];
				const text = textOf(raw.content);
				if (text) content.push({ type: "text", text });
				for (const call of (raw.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
					const fn = (call.function as { name?: string; arguments?: unknown } | undefined) ?? {};
					content.push({
						type: "toolCall",
						id: typeof call.id === "string" ? call.id : `call_${Math.random().toString(36).slice(2, 12)}`,
						name: fn.name ?? "unknown",
						arguments: parseArguments(fn.arguments),
					});
				}
				if (content.length === 0) content.push({ type: "text", text: "" });
				messages.push(
					assistantMessage(model, content, content.some((block) => block.type === "toolCall") ? "toolUse" : "stop"),
				);
				break;
			}
			case "tool": {
				const names = toolNames(messages);
				const id = typeof raw.tool_call_id === "string" ? raw.tool_call_id : "call_unknown";
				messages.push({
					role: "toolResult",
					toolCallId: id,
					toolName: (typeof raw.name === "string" ? raw.name : undefined) ?? names.get(id) ?? "unknown",
					content: [{ type: "text", text: textOf(raw.content) }],
					isError: false,
					timestamp: now,
				} satisfies ToolResultMessage);
				break;
			}
			default:
				break;
		}
	}

	return { systemPrompt: system.length ? system.join("\n\n") : undefined, messages, tools: openaiTools(body.tools) };
}

function openaiTools(tools: OpenAIChatRequest["tools"]): Tool[] {
	const out: Tool[] = [];
	for (const tool of tools ?? []) {
		const fn = tool?.function;
		if (!fn?.name) continue;
		out.push({
			name: fn.name,
			description: fn.description ?? "",
			parameters: (fn.parameters ?? { type: "object", properties: {} }) as Tool["parameters"],
		});
	}
	return out;
}

/* ------------------------------------------------------------------ OpenAI Responses -> pi */

interface OpenAIResponsesRequest {
	model?: string;
	input?: unknown;
	instructions?: string;
	tools?: Array<{ type?: string; name?: string; description?: string; parameters?: unknown }>;
	temperature?: number;
	max_output_tokens?: number;
	stream?: boolean;
	reasoning?: { effort?: string; summary?: string };
	tool_choice?: unknown;
}

function openaiResponsesToContext(body: OpenAIResponsesRequest, model: Model<Api>): PiContext {
	const messages: Message[] = [];
	const now = Date.now();
	const items =
		typeof body.input === "string"
			? [{ role: "user", content: body.input }]
			: ((body.input as Array<Record<string, unknown>>) ?? []);

	for (const item of items) {
		const type = typeof item.type === "string" ? item.type : "message";
		if (type === "function_call") {
			messages.push(
				assistantMessage(
					model,
					[
						{
							type: "toolCall",
							id: String(item.call_id ?? item.id ?? `call_${Math.random().toString(36).slice(2, 12)}`),
							name: String(item.name ?? "unknown"),
							arguments: parseArguments(item.arguments),
						},
					],
					"toolUse",
				),
			);
			continue;
		}
		if (type === "function_call_output") {
			const names = toolNames(messages);
			const id = String(item.call_id ?? item.id ?? "call_unknown");
			messages.push({
				role: "toolResult",
				toolCallId: id,
				toolName: names.get(id) ?? "unknown",
				content: [{ type: "text", text: textOf(item.output ?? item.content) }],
				isError: false,
				timestamp: now,
			} satisfies ToolResultMessage);
			continue;
		}
		const role = typeof item.role === "string" ? item.role : "user";
		if (role === "system" || role === "developer") continue; // folded into instructions
		if (role === "assistant") {
			messages.push(assistantMessage(model, [{ type: "text", text: textOf(item.content) }], "stop"));
			continue;
		}
		messages.push({ role: "user", content: userContent(item.content), timestamp: now } satisfies UserMessage);
	}

	const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
	const tools: Tool[] = [];
	for (const tool of body.tools ?? []) {
		if (tool?.type && tool.type !== "function") continue;
		if (!tool?.name) continue;
		tools.push({
			name: tool.name,
			description: tool.description ?? "",
			parameters: (tool.parameters ?? { type: "object", properties: {} }) as Tool["parameters"],
		});
	}

	return { systemPrompt: instructions || undefined, messages, tools };
}

/* ------------------------------------------------------------------ Anthropic Messages -> pi */

interface AnthropicRequest {
	model?: string;
	system?: unknown;
	messages?: Array<{ role?: string; content?: unknown }>;
	tools?: Array<{ name?: string; description?: string; input_schema?: unknown }>;
	temperature?: number;
	max_tokens?: number;
	stream?: boolean;
	thinking?: { type?: string; budget_tokens?: number };
	tool_choice?: unknown;
}

function anthropicToContext(body: AnthropicRequest, model: Model<Api>): PiContext {
	const messages: Message[] = [];
	const now = Date.now();

	for (const message of body.messages ?? []) {
		const role = message.role ?? "user";
		const blocks = Array.isArray(message.content)
			? (message.content as Array<Record<string, unknown>>)
			: [{ type: "text", text: textOf(message.content) }];

		if (role === "assistant") {
			const content: (TextContent | ThinkingContent | ToolCall)[] = [];
			for (const block of blocks) {
				if (block.type === "text" && typeof block.text === "string") {
					content.push({ type: "text", text: block.text });
				} else if (block.type === "thinking" && typeof block.thinking === "string") {
					content.push({
						type: "thinking",
						thinking: block.thinking,
						...(typeof block.signature === "string" ? { thinkingSignature: block.signature } : {}),
					});
				} else if (block.type === "tool_use") {
					content.push({
						type: "toolCall",
						id: String(block.id ?? `call_${Math.random().toString(36).slice(2, 12)}`),
						name: String(block.name ?? "unknown"),
						arguments: parseArguments(block.input),
					});
				}
			}
			if (content.length === 0) content.push({ type: "text", text: "" });
			messages.push(
				assistantMessage(model, content, content.some((block) => block.type === "toolCall") ? "toolUse" : "stop"),
			);
			continue;
		}

		// user turn: tool_result blocks become pi toolResult messages, everything else a user message.
		const pending: (TextContent | ImageContent)[] = [];
		const flush = () => {
			if (!pending.length) return;
			messages.push({
				role: "user",
				content: pending.length === 1 && pending[0].type === "text" ? pending[0].text : [...pending],
				timestamp: now,
			} satisfies UserMessage);
			pending.length = 0;
		};

		for (const block of blocks) {
			if (block.type === "tool_result") {
				flush();
				const names = toolNames(messages);
				const id = String(block.tool_use_id ?? "call_unknown");
				messages.push({
					role: "toolResult",
					toolCallId: id,
					toolName: names.get(id) ?? "unknown",
					content: [{ type: "text", text: textOf(block.content) }],
					isError: block.is_error === true,
					timestamp: now,
				} satisfies ToolResultMessage);
				continue;
			}
			const converted = userContent([block]);
			if (typeof converted === "string") {
				if (converted) pending.push({ type: "text", text: converted });
			} else {
				pending.push(...converted);
			}
		}
		flush();
	}

	const tools: Tool[] = [];
	for (const tool of body.tools ?? []) {
		if (!tool?.name) continue;
		tools.push({
			name: tool.name,
			description: tool.description ?? "",
			parameters: (tool.input_schema ?? { type: "object", properties: {} }) as Tool["parameters"],
		});
	}

	const system = typeof body.system === "string" ? body.system : textOf(body.system);
	return { systemPrompt: system.trim() || undefined, messages, tools };
}

/** Anthropic thinking budget -> pi thinking level. */
function thinkingLevelFromBudget(budget: number | undefined): ThinkingLevel | undefined {
	if (!budget || budget <= 0) return undefined;
	if (budget < 2_048) return "minimal";
	if (budget < 8_192) return "low";
	if (budget < 16_384) return "medium";
	if (budget < 32_768) return "high";
	return "xhigh";
}

/* ------------------------------------------------------------------ usage mapping */

function openaiUsage(usage: AssistantMessage["usage"]) {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	const completion = usage.output;
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: usage.totalTokens || prompt + completion,
		prompt_tokens_details: { cached_tokens: usage.cacheRead },
		completion_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
	};
}

function anthropicUsage(usage: AssistantMessage["usage"]) {
	return {
		input_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
		output_tokens: usage.output,
		...(usage.cacheRead ? { cache_read_input_tokens: usage.cacheRead } : {}),
		...(usage.cacheWrite ? { cache_creation_input_tokens: usage.cacheWrite } : {}),
	};
}

function finishReason(message: AssistantMessage): "stop" | "length" | "tool_calls" {
	if (message.stopReason === "toolUse") return "tool_calls";
	if (message.stopReason === "length") return "length";
	return "stop";
}

function anthropicStopReason(message: AssistantMessage): string {
	if (message.stopReason === "toolUse") return "tool_use";
	if (message.stopReason === "length") return "max_tokens";
	if (message.stopReason === "aborted") return "stop_sequence";
	return "end_turn";
}

const textOfMessage = (message: AssistantMessage): string =>
	message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");

/**
 * The log shape of a finished exchange, shared by every protocol and both transports, so a
 * streamed transcript row carries exactly the same fields as a non-streamed one.
 *
 * A missing terminal message counts as a failure: the stream ended without pi producing one.
 */
function outcomeOf(
	message: AssistantMessage | undefined,
): Pick<GatewayLogRecord, "level" | "error" | "response" | "usage"> {
	if (!message || message.stopReason === "error" || message.stopReason === "aborted") {
		return { level: "error", error: message?.errorMessage ?? "Provider returned no result" };
	}
	return {
		level: "info",
		response: clipForLog({ finish_reason: finishReason(message), content: textOfMessage(message) }),
		usage: {
			input: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
			output: message.usage.output,
			total: message.usage.totalTokens,
		},
	};
}

/* ------------------------------------------------------------------ SSE plumbing */

function sseInit(res: ServerResponse): void {
	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	res.flushHeaders?.();
}

function sseSend(res: ServerResponse, payload: unknown, event?: string): void {
	if (res.writableEnded) return;
	const data = typeof payload === "string" ? payload : JSON.stringify(payload);
	res.write(`${event ? `event: ${event}\n` : ""}data: ${data}\n\n`);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
	if (res.writableEnded) return;
	const body = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
	res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string, type = "invalid_request_error"): void {
	sendJson(res, status, { error: { message, type, param: null, code: null } });
}

/* ------------------------------------------------------------------ stream sinks */

/**
 * One consumer of pi's normalized assistant events, specialized per wire protocol.
 * `pump()` drives it so the event walk exists once for all three APIs.
 */
interface Sink {
	start(message: AssistantMessage): void;
	textStart(index: number): void;
	textDelta(index: number, delta: string): void;
	textEnd(index: number, text: string): void;
	thinkingStart(index: number): void;
	thinkingDelta(index: number, delta: string): void;
	thinkingEnd(index: number, text: string): void;
	toolStart(index: number, call: ToolCall): void;
	toolArgs(index: number, delta: string): void;
	toolEnd(index: number, call: ToolCall): void;
	done(message: AssistantMessage): void;
	error(message: AssistantMessage, text: string): void;
}

/**
 * Drives one sink over pi's normalized event stream.
 *
 * Returns the terminal message (or the error message) so callers can log what a *streamed*
 * request actually produced. Without it, streaming exchanges would only ever be logged as
 * "200, no usage" - exactly the case a gateway operator wants to inspect.
 */
async function pump(stream: AsyncIterable<unknown>, sink: Sink): Promise<AssistantMessage | undefined> {
	let terminal: AssistantMessage | undefined;
	for await (const raw of stream) {
		const event = raw as { type: string } & Record<string, unknown>;
		switch (event.type) {
			case "start":
				sink.start(event.partial as AssistantMessage);
				break;
			case "text_start":
				sink.textStart(event.contentIndex as number);
				break;
			case "text_delta":
				sink.textDelta(event.contentIndex as number, event.delta as string);
				break;
			case "text_end":
				sink.textEnd(event.contentIndex as number, event.content as string);
				break;
			case "thinking_start":
				sink.thinkingStart(event.contentIndex as number);
				break;
			case "thinking_delta":
				sink.thinkingDelta(event.contentIndex as number, event.delta as string);
				break;
			case "thinking_end":
				sink.thinkingEnd(event.contentIndex as number, event.content as string);
				break;
			case "toolcall_start":
				sink.toolStart(event.contentIndex as number, toolAt(event.partial as AssistantMessage, event.contentIndex as number));
				break;
			case "toolcall_delta":
				sink.toolArgs(event.contentIndex as number, event.delta as string);
				break;
			case "toolcall_end":
				sink.toolEnd(event.contentIndex as number, event.toolCall as ToolCall);
				break;
			case "done":
				terminal = event.message as AssistantMessage;
				sink.done(terminal);
				break;
			case "error":
				terminal = event.error as AssistantMessage;
				sink.error(terminal, terminal.errorMessage ?? "Provider error");
				break;
			default:
				break;
		}
	}
	return terminal;
}

function toolAt(message: AssistantMessage, index: number): ToolCall {
	const block = message?.content?.[index];
	if (block && block.type === "toolCall") return block;
	return { type: "toolCall", id: `call_${Math.random().toString(36).slice(2, 12)}`, name: "unknown", arguments: {} };
}

/** OpenAI Chat Completions streaming. */
class ChatSink implements Sink {
	private readonly toolIndices = new Map<number, number>();
	private nextToolIndex = 0;

	constructor(
		private readonly res: ServerResponse,
		private readonly id: string,
		private readonly model: string,
		private readonly created: number,
		private readonly includeUsage: boolean,
	) {}

	private chunk(delta: Record<string, unknown>, finish: string | null = null, usage?: unknown): void {
		const payload: Record<string, unknown> = {
			id: this.id,
			object: "chat.completion.chunk",
			created: this.created,
			model: this.model,
			choices: [{ index: 0, delta, finish_reason: finish }],
		};
		if (usage) payload.usage = usage;
		sseSend(this.res, payload);
	}

	start(): void {
		this.chunk({ role: "assistant", content: "" });
	}
	textStart(): void {}
	textDelta(_index: number, delta: string): void {
		this.chunk({ content: delta });
	}
	textEnd(): void {}
	thinkingStart(): void {}
	thinkingDelta(_index: number, delta: string): void {
		this.chunk({ reasoning_content: delta });
	}
	thinkingEnd(): void {}
	toolStart(index: number, call: ToolCall): void {
		const toolIndex = this.nextToolIndex++;
		this.toolIndices.set(index, toolIndex);
		this.chunk({
			tool_calls: [{ index: toolIndex, id: call.id, type: "function", function: { name: call.name, arguments: "" } }],
		});
	}
	toolArgs(index: number, delta: string): void {
		const toolIndex = this.toolIndices.get(index) ?? 0;
		this.chunk({ tool_calls: [{ index: toolIndex, function: { arguments: delta } }] });
	}
	toolEnd(): void {}
	done(message: AssistantMessage): void {
		this.chunk({}, finishReason(message));
		if (this.includeUsage) this.chunk({}, null, openaiUsage(message.usage));
		sseSend(this.res, "[DONE]");
		this.res.end();
	}
	error(_message: AssistantMessage, text: string): void {
		sseSend(this.res, { error: { message: text, type: "server_error" } });
		this.res.end();
	}
}

/** OpenAI Responses API streaming events. */
class ResponsesSink implements Sink {
	private sequence = 0;
	private readonly items = new Map<number, { id: string; kind: "text" | "tool" }>();

	constructor(
		private readonly res: ServerResponse,
		private readonly id: string,
		private readonly model: string,
		private readonly createdAt: number,
	) {}

	private emit(type: string, payload: Record<string, unknown>): void {
		sseSend(this.res, { type, sequence_number: this.sequence++, ...payload }, type);
	}

	private response(status: string, extra: Record<string, unknown> = {}) {
		return {
			id: this.id,
			object: "response",
			created_at: this.createdAt,
			status,
			model: this.model,
			output: [],
			parallel_tool_calls: true,
			tool_choice: "auto",
			tools: [],
			...extra,
		};
	}

	start(): void {
		this.emit("response.created", { response: this.response("in_progress") });
		this.emit("response.in_progress", { response: this.response("in_progress") });
	}

	private openItem(index: number, kind: "text" | "tool", item: Record<string, unknown>): void {
		this.items.set(index, { id: String(item.id), kind });
		this.emit("response.output_item.added", { output_index: index, item });
	}

	textStart(index: number): void {
		this.openItem(index, "text", {
			type: "message",
			id: `msg_${this.id}_${index}`,
			status: "in_progress",
			role: "assistant",
			content: [],
		});
		this.emit("response.content_part.added", {
			item_id: `msg_${this.id}_${index}`,
			output_index: index,
			content_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		});
	}
	textDelta(index: number, delta: string): void {
		if (!this.items.has(index)) this.textStart(index);
		this.emit("response.output_text.delta", {
			item_id: `msg_${this.id}_${index}`,
			output_index: index,
			content_index: 0,
			delta,
		});
	}
	textEnd(index: number, text: string): void {
		this.emit("response.output_text.done", {
			item_id: `msg_${this.id}_${index}`,
			output_index: index,
			content_index: 0,
			text,
		});
		this.emit("response.content_part.done", {
			item_id: `msg_${this.id}_${index}`,
			output_index: index,
			content_index: 0,
			part: { type: "output_text", text, annotations: [] },
		});
	}
	thinkingStart(): void {}
	thinkingDelta(): void {}
	thinkingEnd(): void {}
	toolStart(index: number, call: ToolCall): void {
		this.openItem(index, "tool", {
			type: "function_call",
			id: `fc_${call.id}`,
			call_id: call.id,
			name: call.name,
			arguments: "",
			status: "in_progress",
		});
	}
	toolArgs(index: number, delta: string): void {
		this.emit("response.function_call_arguments.delta", {
			item_id: this.items.get(index)?.id,
			output_index: index,
			delta,
		});
	}
	toolEnd(index: number, call: ToolCall): void {
		this.emit("response.function_call_arguments.done", {
			item_id: this.items.get(index)?.id,
			output_index: index,
			arguments: JSON.stringify(call.arguments ?? {}),
		});
	}

	private closeItem(index: number, message: AssistantMessage): Record<string, unknown> | undefined {
		const entry = this.items.get(index);
		if (!entry) return undefined;
		const block = message.content[index];
		let item: Record<string, unknown> | undefined;
		if (entry.kind === "tool" && block?.type === "toolCall") {
			item = {
				type: "function_call",
				id: entry.id,
				call_id: block.id,
				name: block.name,
				arguments: JSON.stringify(block.arguments ?? {}),
				status: "completed",
			};
		} else if (entry.kind === "text") {
			item = {
				type: "message",
				id: entry.id,
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: textOfMessage(message), annotations: [] }],
			};
		} else {
			return undefined;
		}
		this.emit("response.output_item.done", { output_index: index, item });
		return item;
	}

	done(message: AssistantMessage): void {
		const output = [...this.items.keys()]
			.sort((a, b) => a - b)
			.map((index) => this.closeItem(index, message))
			.filter((item): item is Record<string, unknown> => Boolean(item));
		this.emit("response.completed", {
			response: this.response("completed", {
				output,
				output_text: textOfMessage(message),
				usage: {
					input_tokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
					input_tokens_details: { cached_tokens: message.usage.cacheRead },
					output_tokens: message.usage.output,
					output_tokens_details: { reasoning_tokens: message.usage.reasoning ?? 0 },
					total_tokens: message.usage.totalTokens,
				},
			}),
		});
		this.res.end();
	}
	error(_message: AssistantMessage, text: string): void {
		this.emit("response.failed", {
			response: this.response("failed", { error: { code: "server_error", message: text } }),
		});
		this.res.end();
	}
}

/** Anthropic Messages streaming. */
class AnthropicSink implements Sink {
	private readonly open = new Set<number>();

	constructor(
		private readonly res: ServerResponse,
		private readonly id: string,
		private readonly model: string,
	) {}

	start(): void {
		sseSend(this.res, {
			type: "message_start",
			message: {
				id: this.id,
				type: "message",
				role: "assistant",
				model: this.model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 0, output_tokens: 0 },
			},
		});
	}

	private openBlock(index: number, block: Record<string, unknown>): void {
		this.open.add(index);
		sseSend(this.res, { type: "content_block_start", index, content_block: block });
	}
	private closeBlock(index: number): void {
		if (!this.open.delete(index)) return;
		sseSend(this.res, { type: "content_block_stop", index });
	}

	textStart(index: number): void {
		this.openBlock(index, { type: "text", text: "" });
	}
	textDelta(index: number, delta: string): void {
		if (!this.open.has(index)) this.textStart(index);
		sseSend(this.res, { type: "content_block_delta", index, delta: { type: "text_delta", text: delta } });
	}
	textEnd(index: number): void {
		this.closeBlock(index);
	}
	thinkingStart(index: number): void {
		this.openBlock(index, { type: "thinking", thinking: "" });
	}
	thinkingDelta(index: number, delta: string): void {
		if (!this.open.has(index)) this.thinkingStart(index);
		sseSend(this.res, { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: delta } });
	}
	thinkingEnd(index: number): void {
		this.closeBlock(index);
	}
	toolStart(index: number, call: ToolCall): void {
		this.openBlock(index, { type: "tool_use", id: call.id, name: call.name, input: {} });
	}
	toolArgs(index: number, delta: string): void {
		sseSend(this.res, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: delta } });
	}
	toolEnd(index: number): void {
		this.closeBlock(index);
	}
	done(message: AssistantMessage): void {
		for (const index of [...this.open].sort((a, b) => a - b)) this.closeBlock(index);
		sseSend(this.res, {
			type: "message_delta",
			delta: { stop_reason: anthropicStopReason(message), stop_sequence: null },
			usage: anthropicUsage(message.usage),
		});
		sseSend(this.res, { type: "message_stop" });
		this.res.end();
	}
	error(_message: AssistantMessage, text: string): void {
		sseSend(this.res, { type: "error", error: { type: "api_error", message: text } });
		this.res.end();
	}
}

/* ------------------------------------------------------------------ non-streaming bodies */

function chatCompletionBody(id: string, model: string, created: number, message: AssistantMessage) {
	const toolCalls = message.content.filter((block): block is ToolCall => block.type === "toolCall");
	return {
		id,
		object: "chat.completion",
		created,
		model,
		choices: [
			{
				index: 0,
				message: {
					role: "assistant",
					content: textOfMessage(message) || null,
					...(toolCalls.length
						? {
								tool_calls: toolCalls.map((call) => ({
									id: call.id,
									type: "function",
									function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
								})),
							}
						: {}),
				},
				finish_reason: finishReason(message),
			},
		],
		usage: openaiUsage(message.usage),
	};
}

function responsesBody(id: string, model: string, createdAt: number, message: AssistantMessage) {
	const output: Record<string, unknown>[] = [];
	let text = "";
	for (const block of message.content) {
		if (block.type === "text") {
			text += block.text;
			continue;
		}
		if (block.type === "toolCall") {
			output.push({
				type: "function_call",
				id: `fc_${block.id}`,
				call_id: block.id,
				name: block.name,
				arguments: JSON.stringify(block.arguments ?? {}),
				status: "completed",
			});
		}
	}
	if (text) {
		output.unshift({
			type: "message",
			id: `msg_${id}`,
			status: "completed",
			role: "assistant",
			content: [{ type: "output_text", text, annotations: [] }],
		});
	}

	return {
		id,
		object: "response",
		created_at: createdAt,
		status: "completed",
		model,
		output,
		output_text: text,
		parallel_tool_calls: true,
		tool_choice: "auto",
		tools: [],
		usage: {
			input_tokens: message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
			input_tokens_details: { cached_tokens: message.usage.cacheRead },
			output_tokens: message.usage.output,
			output_tokens_details: { reasoning_tokens: message.usage.reasoning ?? 0 },
			total_tokens: message.usage.totalTokens,
		},
		error: null,
	};
}

function anthropicBody(id: string, model: string, message: AssistantMessage) {
	const content: Record<string, unknown>[] = [];
	for (const block of message.content) {
		if (block.type === "text") content.push({ type: "text", text: block.text });
		else if (block.type === "thinking") {
			content.push({ type: "thinking", thinking: block.thinking, signature: block.thinkingSignature ?? "" });
		} else if (block.type === "toolCall") {
			content.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments ?? {} });
		}
	}
	return {
		id,
		type: "message",
		role: "assistant",
		model,
		content,
		stop_reason: anthropicStopReason(message),
		stop_sequence: null,
		usage: anthropicUsage(message.usage),
	};
}

/* ------------------------------------------------------------------ HTTP helpers */

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("Request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/* ------------------------------------------------------------------ extension */

export default function (pi: ExtensionAPI) {
	let server: Server | undefined;
	let registry: Registry | undefined;
	let ctxRef: ExtensionContext | undefined;
	let lastError: string | undefined;
	let seq = 0;
	let requestCount = 0;
	let errorCount = 0;
	// Mutable at runtime: /gateway log LEVEL retunes it without a restart.
	let logLevel: LogLevel = LOG_LEVEL;
	// Scoped by default: only the session's selected models are exposed, so a client cannot
	// silently reach a provider this session was never configured for. `all` is opt-in.
	let scopeMode: ScopeMode = process.env.PI_REVERSE_GATEWAY_SCOPE === "all" ? "all" : "scoped";
	const ring: GatewayLogRecord[] = [];
	const notify = (message: string) => ctxRef?.ui?.notify(message, "info");

	/**
	 * Record one exchange into all sinks:
	 *   - the transcript (custom entry + renderer below): durable, expandable, zero LLM context;
	 *   - the NDJSON file: survives restarts and is greppable;
	 *   - the in-memory ring: what /gateway log reads.
	 * `logLevel` gates all three. This is the only place the counters move, so the footer and
	 * /gateway status always agree with what the transcript shows.
	 */
	const record = (entry: Omit<GatewayLogRecord, "seq" | "ts">): void => {
		if (logLevel === "off") return;
		if (logLevel === "error" && entry.level !== "error") return;
		const full: GatewayLogRecord = { seq: ++seq, ts: Date.now(), ...entry };
		requestCount++;
		if (full.level === "error") errorCount++;
		ring.push(full);
		if (ring.length > LOG_RETENTION) ring.shift();
		appendLogFile(full);
		// Not every mode has a transcript (print/rpc); a failed append must never fail the HTTP
		// request that produced it.
		try {
			pi.appendEntry<GatewayLogRecord>(LOG_ENTRY_TYPE, full);
		} catch {
			// no transcript available in this mode
		}
		syncStatus();
	};

	// Registered once, at load: the renderer itself is stateless, so transcript rows keep
	// rendering on session reload without the gateway running.
	pi.registerEntryRenderer<GatewayLogRecord>(LOG_ENTRY_TYPE, renderGatewayEntry);

	const chatModels = (): Model<Api>[] => {
		if (!registry) return [];
		// Available = auth actually configured; falls back to every registered chat model so
		// /v1/models is never misleadingly empty right after startup.
		const available = registry.getAvailable().filter((model) => (model.type ?? "chat") === "chat");
		return available.length ? available : registry.getAll().filter((model) => (model.type ?? "chat") === "chat");
	};

	const allModelIds = (): string[] => chatModels().map((model) => `${model.provider}/${model.id}`);

	const exposedModelIds = (): string[] => {
		if (scopeMode === "scoped") {
			const scoped = (ctxRef?.scopedModels ?? []).map((entry) => `${entry.model.provider}/${entry.model.id}`);
			if (scoped.length) return scoped;
		}
		return allModelIds();
	};

	const exposedModels = (): Model<Api>[] => {
		const ids = new Set(exposedModelIds());
		return chatModels().filter((model) => ids.has(`${model.provider}/${model.id}`));
	};

	/** `provider/model`, then bare id, then case-insensitive id - the order /v1/models advertises. */
	const resolveModel = (spec: string): { model?: Model<Api>; error?: string } => {
		const wanted = (spec ?? "").trim();
		if (!wanted) return { error: "No model specified." };
		const all = chatModels();
		const exact = all.find((model) => `${model.provider}/${model.id}` === wanted);
		if (exact) return { model: exact };
		const byId = all.filter((model) => model.id === wanted);
		if (byId.length === 1) return { model: byId[0] };
		if (byId.length > 1) {
			return {
				error: `Ambiguous model "${wanted}". Use one of: ${byId.map((m) => `${m.provider}/${m.id}`).join(", ")}`,
			};
		}
		const lower = wanted.toLowerCase();
		const loose = all.filter((model) => model.id.toLowerCase() === lower);
		if (loose.length === 1) return { model: loose[0] };
		if (loose.length > 1) {
			return {
				error: `Ambiguous model "${wanted}". Use one of: ${loose.map((m) => `${m.provider}/${m.id}`).join(", ")}`,
			};
		}
		return { error: `Unknown model "${wanted}". GET /v1/models lists everything pi can serve.` };
	};

	const openAiModel = (model: Model<Api>) => ({
		id: `${model.provider}/${model.id}`,
		object: "model",
		created: 0,
		owned_by: model.provider,
		// Extra fields: harmless for strict clients, useful for humans (and for VS Code pickers).
		pi_model: model.id,
		pi_provider: model.provider,
		context_window: model.contextWindow,
		max_tokens: model.maxTokens,
		reasoning: model.reasoning,
	});

	/**
	 * pi's own request pipeline: the provider hook set for this model plus the protocol's knobs.
	 * `providerHooks` is what makes credential pools and payload transforms apply.
	 */
	const buildOptions = (ctx: ExtensionContext, model: Model<Api>, extra: Record<string, unknown>) =>
		({ ...providerHooks(ctx, model, notify), ...extra }) as Record<string, unknown>;

	const runStream = async (
		ctx: ExtensionContext,
		model: Model<Api>,
		context: PiContext,
		options: Record<string, unknown>,
		signal: AbortSignal,
	) => {
		const active = registry ?? ctx.modelRegistry;
		// Auth/route resolution, retries, transforms and stream normalization all happen inside.
		return active.streamSimple(model, context, { ...options, signal } as never);
	};

	const authorized = (req: IncomingMessage): boolean => {
		if (!AUTH_TOKEN) return true;
		const header = req.headers.authorization;
		const key = req.headers["x-api-key"];
		const presented =
			typeof header === "string" && header.toLowerCase().startsWith("bearer ")
				? header.slice(7).trim()
				: typeof key === "string"
					? key.trim()
					: "";
		return presented === AUTH_TOKEN;
	};

	/* ---------------- endpoint handlers */

	/**
	 * One log call for every protocol and transport: request envelope + outcome + counters.
	 * Keeping this in one place is what makes transcript rows comparable across APIs.
	 */
	const logExchange = (
		path: string,
		model: Model<Api>,
		stream: boolean,
		body: unknown,
		started: number,
		status: number,
		outcome: Pick<GatewayLogRecord, "level" | "error" | "response" | "usage">,
	): void => {
		record({
			method: "POST",
			path,
			status,
			durationMs: Date.now() - started,
			model: `${model.provider}/${model.id}`,
			provider: model.provider,
			stream,
			request: clipForLog(body),
			...outcome,
		});
	};

	const handleChatCompletions = async (req: IncomingMessage, res: ServerResponse, started: number): Promise<void> => {
		const body = JSON.parse(await readBody(req)) as OpenAIChatRequest;
		const resolved = resolveModel(body.model ?? "");
		if (!resolved.model || !ctxRef) {
			sendError(res, 404, resolved.error ?? "Unknown model", "not_found_error");
			return;
		}
		const model = resolved.model;
		const publicModel = `${model.provider}/${model.id}`;
		const context = openaiChatToContext(body, model);

		const options: Record<string, unknown> = {};
		if (typeof body.temperature === "number") options.temperature = body.temperature;
		const maxTokens = body.max_completion_tokens ?? body.max_tokens;
		if (typeof maxTokens === "number") options.maxTokens = maxTokens;
		const effort = body.reasoning_effort?.toLowerCase();
		if (effort && effort in REASONING_LEVELS) options.reasoning = REASONING_LEVELS[effort];
		if (body.tool_choice === "none") options.toolChoice = "none";
		else if (body.tool_choice === "auto" || body.tool_choice === "required") options.toolChoice = "auto";

		const id = `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		const created = Math.floor(Date.now() / 1000);
		const controller = new AbortController();
		req.on("close", () => controller.abort());

		try {
			const stream = await runStream(ctxRef, model, context, buildOptions(ctxRef, model, options), controller.signal);
			if (body.stream) {
				sseInit(res);
				const sink = new ChatSink(res, id, publicModel, created, body.stream_options?.include_usage === true);
				const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
				let final: AssistantMessage | undefined;
				try {
					final = await pump(stream, sink);
				} finally {
					clearInterval(keepalive);
				}
				// Headers already went out as 200; the row still reports the outcome.
				logExchange("/v1/chat/completions", model, true, body, started, 200, outcomeOf(final));
				return;
			}

			const message = await stream.result();
			const outcome = outcomeOf(message);
			if (outcome.level === "error") {
				sendError(res, 502, outcome.error ?? "Provider error", "server_error");
				logExchange("/v1/chat/completions", model, false, body, started, 502, outcome);
				return;
			}
			sendJson(res, 200, chatCompletionBody(id, publicModel, created, message));
			logExchange("/v1/chat/completions", model, false, body, started, 200, outcome);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			if (!res.headersSent) sendError(res, 401, text, "authentication_error");
			else res.end();
			logExchange("/v1/chat/completions", model, body.stream === true, body, started, 401, { level: "error", error: text });
		}
	};

	const handleResponses = async (req: IncomingMessage, res: ServerResponse, started: number): Promise<void> => {
		const body = JSON.parse(await readBody(req)) as OpenAIResponsesRequest;
		const resolved = resolveModel(body.model ?? "");
		if (!resolved.model || !ctxRef) {
			sendError(res, 404, resolved.error ?? "Unknown model", "not_found_error");
			return;
		}
		const model = resolved.model;
		const publicModel = `${model.provider}/${model.id}`;
		const context = openaiResponsesToContext(body, model);

		const options: Record<string, unknown> = {};
		if (typeof body.temperature === "number") options.temperature = body.temperature;
		if (typeof body.max_output_tokens === "number") options.maxTokens = body.max_output_tokens;
		const effort = body.reasoning?.effort?.toLowerCase();
		if (effort && effort in REASONING_LEVELS) options.reasoning = REASONING_LEVELS[effort];
		if (body.tool_choice === "none") options.toolChoice = "none";
		else if (body.tool_choice === "auto" || body.tool_choice === "required") options.toolChoice = "auto";

		const id = `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
		const createdAt = Math.floor(Date.now() / 1000);
		const controller = new AbortController();
		req.on("close", () => controller.abort());

		try {
			const stream = await runStream(ctxRef, model, context, buildOptions(ctxRef, model, options), controller.signal);
			if (body.stream) {
				sseInit(res);
				const sink = new ResponsesSink(res, id, publicModel, createdAt);
				const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
				let final: AssistantMessage | undefined;
				try {
					final = await pump(stream, sink);
				} finally {
					clearInterval(keepalive);
				}
				logExchange("/v1/responses", model, true, body, started, 200, outcomeOf(final));
				return;
			}
			const message = await stream.result();
			const outcome = outcomeOf(message);
			if (outcome.level === "error") {
				sendError(res, 502, outcome.error ?? "Provider error", "server_error");
				logExchange("/v1/responses", model, false, body, started, 502, outcome);
				return;
			}
			sendJson(res, 200, responsesBody(id, publicModel, createdAt, message));
			logExchange("/v1/responses", model, false, body, started, 200, outcome);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			if (!res.headersSent) sendError(res, 401, text, "authentication_error");
			else res.end();
			logExchange("/v1/responses", model, body.stream === true, body, started, 401, { level: "error", error: text });
		}
	};

	const handleMessages = async (req: IncomingMessage, res: ServerResponse, started: number): Promise<void> => {
		const body = JSON.parse(await readBody(req)) as AnthropicRequest;
		const resolved = resolveModel(body.model ?? "");
		if (!resolved.model || !ctxRef) {
			sendError(res, 404, resolved.error ?? "Unknown model", "not_found_error");
			return;
		}
		const model = resolved.model;
		const publicModel = `${model.provider}/${model.id}`;
		const context = anthropicToContext(body, model);

		const options: Record<string, unknown> = {};
		if (typeof body.temperature === "number") options.temperature = body.temperature;
		if (typeof body.max_tokens === "number") options.maxTokens = body.max_tokens;
		const reasoning = thinkingLevelFromBudget(body.thinking?.budget_tokens);
		if (reasoning) options.reasoning = reasoning;
		const toolChoice = body.tool_choice as { type?: string } | undefined;
		if (toolChoice?.type === "none") options.toolChoice = "none";

		const id = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
		const controller = new AbortController();
		req.on("close", () => controller.abort());

		try {
			const stream = await runStream(ctxRef, model, context, buildOptions(ctxRef, model, options), controller.signal);
			if (body.stream) {
				sseInit(res);
				const sink = new AnthropicSink(res, id, publicModel);
				const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
				let final: AssistantMessage | undefined;
				try {
					final = await pump(stream, sink);
				} finally {
					clearInterval(keepalive);
				}
				logExchange("/v1/messages", model, true, body, started, 200, outcomeOf(final));
				return;
			}
			const message = await stream.result();
			const outcome = outcomeOf(message);
			if (outcome.level === "error") {
				sendError(res, 502, outcome.error ?? "Provider error", "server_error");
				logExchange("/v1/messages", model, false, body, started, 502, outcome);
				return;
			}
			sendJson(res, 200, anthropicBody(id, publicModel, message));
			logExchange("/v1/messages", model, false, body, started, 200, outcome);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			if (!res.headersSent) sendError(res, 401, text, "authentication_error");
			else res.end();
			logExchange("/v1/messages", model, body.stream === true, body, started, 401, { level: "error", error: text });
		}
	};

	const handleCountTokens = async (req: IncomingMessage, res: ServerResponse, started: number): Promise<void> => {
		const body = JSON.parse(await readBody(req)) as AnthropicRequest;
		const resolved = resolveModel(body.model ?? "");
		if (!resolved.model) {
			sendError(res, 404, resolved.error ?? "Unknown model", "not_found_error");
			return;
		}
		const context = anthropicToContext(body, resolved.model);
		// Reuse pi's own estimator over the converted transcript instead of a second heuristic.
		const input_tokens = context.messages.reduce((total, message) => total + estimateTokens(message as never), 0);
		sendJson(res, 200, { input_tokens });
		record({ method: "POST", path: "/v1/messages/count_tokens", status: 200, durationMs: Date.now() - started, level: "info", model: `${resolved.model.provider}/${resolved.model.id}` });
	};

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const started = Date.now();
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
		const path = url.pathname.replace(/\/+$/, "") || "/";

		res.setHeader("access-control-allow-origin", "*");
		res.setHeader("access-control-allow-headers", "*");
		res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
		if (req.method === "OPTIONS") {
			res.writeHead(204).end();
			return;
		}

		if (path === "/health") {
			sendJson(res, 200, {
				status: "ok",
				models: exposedModelIds().length,
				total: allModelIds().length,
				scope: scopeMode,
				hooks: Boolean((ctxRef as unknown as { providerHooks?: unknown } | undefined)?.providerHooks),
				requests: requestCount,
				errors: errorCount,
				lastError,
			});
			return;
		}

		if (!authorized(req)) {
			sendError(res, 401, "Invalid or missing API key", "authentication_error");
			return;
		}
		requestCount++;

		try {
			if (req.method === "GET" && path === "/v1/models") {
				sendJson(res, 200, { object: "list", data: exposedModels().map(openAiModel) });
				record({ method: "GET", path, status: 200, durationMs: Date.now() - started, level: "info" });
				return;
			}
			if (req.method === "GET" && path.startsWith("/v1/models/")) {
				const resolved = resolveModel(decodeURIComponent(path.slice("/v1/models/".length)));
				if (!resolved.model) {
					sendError(res, 404, resolved.error ?? "Unknown model", "not_found_error");
					return;
				}
				sendJson(res, 200, openAiModel(resolved.model));
				return;
			}
			if (req.method === "POST" && path === "/v1/chat/completions") {
				await handleChatCompletions(req, res, started);
				return;
			}
			if (req.method === "POST" && path === "/v1/responses") {
				await handleResponses(req, res, started);
				return;
			}
			if (req.method === "POST" && path === "/v1/messages") {
				await handleMessages(req, res, started);
				return;
			}
			if (req.method === "POST" && path === "/v1/messages/count_tokens") {
				await handleCountTokens(req, res, started);
				return;
			}

			sendError(res, 404, `No route for ${req.method} ${path}`, "not_found_error");
			record({ method: req.method ?? "GET", path, status: 404, durationMs: Date.now() - started, level: "warning" });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			lastError = message;
			if (!res.headersSent) sendError(res, 500, message, "server_error");
			else res.end();
			record({ method: req.method ?? "POST", path, status: 500, durationMs: Date.now() - started, level: "error", error: message });
		}
	};

	const url = (): string => `http://${HOST}:${PORT}`;

	/** One place owns the footer status, so every entry point (flag, /gateway, scoped) agrees. */
	const syncStatus = (): void => {
		// The footer doubles as a live readout: model count, then request/error counters.
		const counts = `${requestCount} req${errorCount ? ` · ${errorCount} err` : ""}`;
		ctxRef?.ui?.setStatus(
			"pi-reverse-gateway",
			server ? `⇄ ${exposedModelIds().length} models · ${counts} · :${PORT}` : undefined,
		);
	};

	const start = async (): Promise<void> => {
		if (server) return;
		server = createServer((req, res) => {
			void handle(req, res);
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server?.once("error", reject);
				server?.listen(PORT, HOST, () => {
					server?.removeListener("error", reject);
					resolve();
				});
			});
			lastError = undefined;
			console.log(`pi-reverse-gateway: listening on ${url()} (${exposedModelIds().length} models)`);
			syncStatus();
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			server = undefined;
			console.log(`pi-reverse-gateway: failed to start on ${url()} - ${lastError}`);
			syncStatus();
		}
	};

	const stop = async (): Promise<void> => {
		const current = server;
		server = undefined;
		syncStatus();
		if (!current) return;
		await new Promise<void>((resolve) => current.close(() => resolve()));
		console.log("pi-reverse-gateway: stopped");
	};

	pi.on("session_start", async (_event, ctx) => {
		registry = ctx.modelRegistry;
		ctxRef = ctx;
		// Off unless asked for: `pi --gateway`, or the env override.
		const startOnOpen = AUTO_START_ENV || pi.getFlag(FLAG_NAME) === true;
		if (startOnOpen) await start();
	});

	pi.on("session_shutdown", async () => {
		await stop();
	});

	// `pi --gateway`: opt in for every session from the command line. Registering the flag
	// makes pi accept and document it; without it nothing starts until /gateway start.
	pi.registerFlag(FLAG_NAME, {
		type: "boolean",
		default: false,
		description: "Start the reverse gateway (OpenAI + Anthropic compatible endpoints) on launch",
	});

	// Subcommand table: single source for the handler's usage text and for tab completion.
	const SUBCOMMANDS: { name: string; description: string }[] = [
		{ name: "status", description: "Show gateway status" },
		{ name: "start", description: "Start listening" },
		{ name: "stop", description: "Stop listening" },
		{ name: "restart", description: "Stop then start" },
		{ name: "models", description: "List the models being served" },
		{ name: "scoped", description: "Toggle between every model and this session's scoped models" },
		{ name: "log", description: "Show recent requests" },
	];

	/**
	 * Tab completion. pi hands us the whole argument text and replaces it wholesale with a
	 * returned `value`, so second-word completions must return the full argument.
	 */
	const completeArguments = (argumentPrefix: string): AutocompleteItem[] | null => {
		const text = argumentPrefix ?? "";
		const words = text.trim().split(/\s+/).filter(Boolean);
		const typedTrailingSpace = /\s$/.test(text);

		// Second argument: only `log` takes one.
		if (words.length >= 2 || (words.length === 1 && typedTrailingSpace)) {
			const head = (words[0] ?? "").toLowerCase();
			const rest = words[1]?.toLowerCase() ?? "";
			if (head === "log") {
				// Levels first (they change behaviour), then counts for paging the ring.
				const levels: AutocompleteItem[] = LOG_LEVELS.filter((level) => level.startsWith(rest)).map((level) => ({
					value: `log ${level}`,
					label: level,
					description: level === "off" ? "Pause transcript, ring and NDJSON" : `Log ${level} exchanges`,
				}));
				const counts: AutocompleteItem[] = ["20", "50", "100"]
					.filter((count) => count.startsWith(rest))
					.map((count) => ({ value: `log ${count}`, label: count, description: `Last ${count} requests` }));
				const items = [...levels, ...counts];
				return items.length ? items : null;
			}
			return null;
		}

		const partial = (words[0] ?? "").toLowerCase();
		const items = SUBCOMMANDS.filter((command) => command.name.startsWith(partial)).map((command) => ({
			value: command.name,
			label: command.name,
			description: command.description,
		}));
		return items.length ? items : null;
	};

	pi.registerCommand("gateway", {
		description: "Control the reverse gateway (OpenAI + Anthropic compatible endpoints)",
		getArgumentCompletions: completeArguments,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			ctxRef = ctx;
			registry = ctx.modelRegistry;
			const parts = (args ?? "").trim().split(/\s+/);
			const sub = (parts[0] ?? "").toLowerCase();

			switch (sub) {
				case "start":
					await start();
					ctx.ui.notify(server ? `gateway started on ${url()}` : `gateway failed: ${lastError ?? "unknown error"}`, server ? "info" : "error");
					return;
				case "stop":
					await stop();
					ctx.ui.notify("gateway stopped", "info");
					return;
				case "restart":
					await stop();
					await start();
					ctx.ui.notify(server ? `gateway restarted on ${url()}` : `gateway failed: ${lastError ?? "unknown error"}`, server ? "info" : "error");
					return;
				case "scoped": {
					// Toggle: the default is scoped, so one command flips both ways with no argument.
					scopeMode = scopeMode === "scoped" ? "all" : "scoped";
					syncStatus();
					const count = exposedModelIds().length;
					console.log(
						scopeMode === "scoped"
							? `pi-reverse-gateway: scoped - serving ${count} of ${allModelIds().length} models`
							: `pi-reverse-gateway: all - serving every model (${count})`,
					);
					return;
				}
				case "models": {
					const ids = exposedModelIds();
					console.log(`${ids.length} models exposed (scope: ${scopeMode}), ${allModelIds().length} registered:`);
					for (const id of ids) console.log(`  ${id}`);
					return;
				}
				case "log": {
					const arg = (parts[1] ?? "").toLowerCase();
					// Overload: a level retunes logging, a number pages the ring, nothing shows the tail.
					if (arg && (LOG_LEVELS as readonly string[]).includes(arg)) {
						logLevel = arg as LogLevel;
						console.log(`pi-reverse-gateway: logging ${logLevel} - transcript, ring and NDJSON`);
						return;
					}
					if (arg && !/^\d+$/.test(arg)) {
						console.log(`Usage: /gateway log [${LOG_LEVELS.join("|")}] or /gateway log [count]`);
						return;
					}
					const limit = parts[1] ? Number(parts[1]) : 20;
					const lines = ring.slice(-(Number.isFinite(limit) && limit > 0 ? limit : 20));
					if (!lines.length) {
						console.log("pi-reverse-gateway: no requests logged yet");
						return;
					}
					console.log(`pi-reverse-gateway: last ${lines.length} request(s)`);
					for (const line of lines) {
						const when = new Date(line.ts).toLocaleTimeString();
						const flag = line.level === "error" ? "✗" : line.level === "warning" ? "!" : "·";
						console.log(
							`  ${flag} ${when} ${line.method} ${line.path} → ${line.status} ${line.durationMs}ms` +
								`${line.model ? ` · ${line.model}` : ""}${line.error ? ` · ${line.error}` : ""}`,
						);
					}
					return;
				}
				case "status":
				default: {
					if (sub && sub !== "status") {
						console.log(`Unknown subcommand "${sub}". Try: ${SUBCOMMANDS.map((c) => c.name).join(" | ")}`);
						return;
					}
					const hooksAvailable = Boolean((ctx as unknown as { providerHooks?: unknown }).providerHooks);
					const launchFlag = pi.getFlag(FLAG_NAME) === true;
					const autostart = launchFlag
						? "on (pi --gateway)"
						: AUTO_START_ENV
							? "on (PI_REVERSE_GATEWAY_AUTO_START=1)"
							: "off - use /gateway start, or relaunch with pi --gateway";
					console.log(
						`pi-reverse-gateway: ${server ? `running on ${url()}` : "stopped"}${lastError ? ` (last error: ${lastError})` : ""}\n` +
							`  models: ${exposedModelIds().length} exposed (scope: ${scopeMode}) · ${allModelIds().length} registered\n` +
							`  provider hooks: ${hooksAvailable ? "active (key pools + transforms apply)" : "MISSING - run the hook-stream patch"}\n` +
							`  endpoints: GET /v1/models · POST /v1/chat/completions · POST /v1/responses · POST /v1/messages\n` +
							`  autostart: ${autostart}\n` +
							`  auth: ${AUTH_TOKEN ? "bearer token required" : "none (loopback only)"}\n` +
							`  log: ${logLevel} · ${LOG_FILE}\n` +
							`  requests: ${requestCount} (${errorCount} errors)\n` +
							`  commands: ${SUBCOMMANDS.map((command) => command.name).join(" | ")}`,
					);
				}
			}
		},
	});
}
