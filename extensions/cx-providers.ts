/**
 * cx-providers - custom providers with curated model catalogs for pi.
 *
 * A single-file extension that registers custom model providers under
 * plain slug ids (collisions are warned about, never silent) with:
 *
 * - A per-provider model list endpoint (default: smart /v1/models resolution
 *   against the base URL, never producing /v1/v1/models).
 * - Smart prefilling of model metadata from pi's own catalog and the endpoint
 *   response, overridable per model and per provider.
 * - A curation UI: enabled models, disabled models, then discovered-but-not
 *   added models, with search and the same hotkeys as /scoped-models.
 * - Layered config: model overrides > provider defaults > pi catalog and
 *   endpoint data > inferred guesses. Empty values inherit.
 * - A models.json projection using the SAME id pi sees, tracked in our own
 *   config file so pi works without the extension and stays inspectable.
 *
 * Model serving is never reimplemented: streaming, tool calling, usage
 * accounting, thinking levels, prompt caching, retries, compaction overflow,
 * abort, /login, /model, /scoped-models, --list-models, and Ctrl+P cycling
 * are all handled by pi and its built-in API implementations. This extension
 * only decides which models exist under which provider and with which
 * metadata.
 *
 * Commands:
 *   /providers        hub: add provider, refresh, list, exit
 *   /providers id     provider view: add model, curator, per-model settings,
 *                     provider settings, model defaults, exit
 *
 * Model states:
 *   enabled    in the provider, offered to the model (shows in /model)
 *   disabled   in the provider with its per-model config, but not offered
 *   unadded    discovered upstream, not in the provider
 *
 * Files:
 *   ~/.pi/agent/cx/providers.json   authoring source (written by this UI)
 *   ~/.pi/agent/models.json         projection of provider fields + enabled
 *                                   models, keyed by the same ids pi sees
 */

import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";

import {
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	getAgentDir,
	getSettingsListTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
	type Api,
	type Model,
	type Provider,
	type ProviderStreams,
	isModelType,
} from "@earendil-works/pi-ai";
import {
	anthropicMessagesApi,
	azureOpenAIResponsesApi,
	bedrockConverseStreamApi,
	googleGenerativeAIApi,
	googleVertexApi,
	mistralConversationsApi,
	openAICompletionsApi,
	openAICodexResponsesApi,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { builtinProviders, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import {
	Input,
	Key,
	Keybindings,
	type SettingItem,
	SettingsList,
	fuzzyFilter,
	getKeybindings,
	matchesKey,
	truncateToWidth,
} from "@earendil-works/pi-tui";

const CONFIG_DIR = "extensions";
const CONFIG_FILE = "cx-providers.json";
const DISCOVERY_TIMEOUT_MS = 15_000;
const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
const DEFAULT_MODEL_MAX_TOKENS = 65_536;
const MAX_VISIBLE_ROWS = 8;
const MAX_SETTINGS_ROWS = 18;

const KNOWN_APIS = [
	"auto",
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"google-generative-ai",
	"google-vertex",
	"mistral-conversations",
	"bedrock-converse-stream",
] as const;

const API_IMPLS: Record<string, () => ProviderStreams> = {
	"openai-completions": openAICompletionsApi,
	"openai-responses": openAIResponsesApi,
	"openai-codex-responses": openAICodexResponsesApi,
	"azure-openai-responses": azureOpenAIResponsesApi,
	"anthropic-messages": anthropicMessagesApi,
	"google-generative-ai": googleGenerativeAIApi,
	"google-vertex": googleVertexApi,
	"mistral-conversations": mistralConversationsApi,
	"bedrock-converse-stream": bedrockConverseStreamApi,
};

interface RawModel {
	id: string;
	name?: string;
	ownedBy?: string;
	created?: number;
	contextLength?: number;
	outputLimit?: number;
}

/** Sparse per-model configuration. Unset fields inherit down the ladder. */
interface ModelEntry {
	id: string;
	enabled: boolean;
	name?: string;
	tags?: string[];
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	promptCache?: { short?: number; long?: number };
	thinkingLevelMap?: Record<string, string | null>;
	api?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	inputLimits?: Record<string, unknown>;
	samplingParams?: Record<string, unknown>;
}

interface ProviderConfig {
	id: string;
	name?: string;
	baseUrl: string;
	api?: string;
	apiKey?: string;
	authHeader?: boolean;
	/**
	 * Reuse a builtin provider's auth verbatim (e.g. "anthropic", "openai-codex").
	 * pi then owns everything about credentials: /login, OAuth (browser, device
	 * code, manual paste), refresh under its store lock, auth.json, and the
	 * request auth derived from it. We only own models and endpoints.
	 */
	authFrom?: string;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	modelsEndpoint?: string;
	defaults?: ModelLike;
	models: ModelEntry[];
	discovered?: { fetchedAt?: number; models: RawModel[] };
}

interface Config {
	version: 1;
	providers: Record<string, ProviderConfig>;
	/** ids last written to models.json; lets us remove our own keys and only ours. */
	projected: string[];
}

type ModelLike = Omit<ModelEntry, "id" | "enabled">;

type Layer = "model" | "provider" | "catalog" | "upstream" | "inferred";
interface Provenance { layer: Layer; confidence?: number }
type ProvMap = Record<string, Provenance>;
interface ResolvedEntry { model: Model<Api>; provenance: ProvMap }

interface ViewState {
	id: string;
	work: ProviderConfig;
	snapshot: ProviderConfig;
	dirty: boolean;
}

interface Screen {
	render(width: number): string[];
	handleInput(data: string): void;
	focus?(): void;
	invalidate?(): void;
}
// ============================== small utilities ==============================

let piApi: ExtensionAPI | undefined;

function clone<T>(value: T): T {
	return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatTokens(count: number): string {
	if (count >= 1_000_000) return (count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1) + "M";
	if (count >= 1000) return (count / 1000).toFixed(count % 1000 === 0 ? 0 : 1) + "k";
	return String(count);
}

function slugify(name: string): string {
	const slug = name.toLowerCase().trim().replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
	return slug || "provider";
}

/** Model ids must never contain ":" — pi parses model patterns on the last colon. */
function normalizeModelId(id: string): string {
	return id.toLowerCase()
		.replace(/^[^/]+\//, "")
		.replace(/:[a-z]+.*$/, "")
		.replace(/-20\d{6}/g, "")
		.replace(/-(latest|preview|experimental|exp)$/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function looksLikeReasoner(id: string): boolean {
	return /(^|[-._])(o[1345](-|$)|r1|qwq)|think|reason/i.test(id);
}

function looksLikeVision(id: string): boolean {
	return /vision|vlm|-vl|omni|multimodal|image/i.test(id);
}
// ============================== configuration store ==============================

let config: Config = { version: 1, providers: {}, projected: [] };
let configRaw = "";

function configPath(): string {
	return join(getAgentDir(), CONFIG_DIR, CONFIG_FILE);
}

function modelsJsonPath(): string {
	return join(getAgentDir(), "models.json");
}

function loadConfig(): void {
	let raw: string;
	try {
		raw = fs.readFileSync(configPath(), "utf8");
	} catch {
		configRaw = "";
		config = { version: 1, providers: {}, projected: [] };
		return;
	}
	configRaw = raw;
	config = parseConfig(raw);
}

/** Forgiving parse: a broken config file disables entries instead of breaking pi. */
function parseConfig(raw: string): Config {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { version: 1, providers: {}, projected: [] };
	}
	const root = isRecord(parsed) ? parsed : {};
	const listed = isRecord(root.providers) ? root.providers : {};
	const providers: Record<string, ProviderConfig> = {};
	for (const [key, value] of Object.entries(listed)) {
		if (!isRecord(value)) continue;
		const id = str(value.id) ?? key;
		if (!id || id.includes(":")) continue;
		providers[id] = normalizeProviderConfig(id, value);
	}
	const projected = Array.isArray(root.projected)
		? root.projected.filter((key): key is string => typeof key === "string")
		: [];
	return { version: 1, providers, projected };
}

function normalizeProviderConfig(id: string, value: Record<string, unknown>): ProviderConfig {
	const models: ModelEntry[] = [];
	const listed = Array.isArray(value.models) ? value.models : [];
	for (const entry of listed) {
		if (!isRecord(entry) || !str(entry.id)) continue;
		models.push(normalizeModelEntry(entry));
	}
	const discovered = isRecord(value.discovered) && Array.isArray(value.discovered.models)
		? {
			fetchedAt: num(value.discovered.fetchedAt),
			models: (value.discovered.models as Record<string, unknown>[])
				.map((m) => (isRecord(m) ? pickRawModel(m) : undefined))
				.filter((m): m is RawModel => m !== undefined),
		}
		: undefined;
	return {
		id,
		name: str(value.name),
		baseUrl: (str(value.baseUrl) ?? "").replace(/\/+$/, ""),
		api: str(value.api),
		apiKey: str(value.apiKey),
		authHeader: value.authHeader !== false,
		headers: isRecord(value.headers) ? value.headers as Record<string, string> : undefined,
		compat: isRecord(value.compat) ? value.compat : undefined,
		modelsEndpoint: str(value.modelsEndpoint),
		authFrom: str(value.authFrom),
		defaults: isRecord(value.defaults) ? normalizeModelLike(value.defaults) : undefined,
		models,
		discovered,
	};
}

function normalizeModalities(value: unknown): ("text" | "image")[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: ("text" | "image")[] = [];
	for (const item of value) {
		if (item === "text" || item === "image") out.push(item);
	}
	return out.length > 0 ? out : undefined;
}

function normalizeModelEntry(entry: Record<string, unknown>, fallbackId = ""): ModelEntry {
	return {
		id: str(entry.id) ?? fallbackId,
		enabled: entry.enabled !== false,
		name: (str(entry.name) ?? fallbackId).startsWith("models/") ? undefined : str(entry.name),
		tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
		input: normalizeModalities(entry.input),
		contextWindow: num(entry.contextWindow),
		maxTokens: num(entry.maxTokens),
		reasoning: typeof entry.reasoning === "boolean" ? entry.reasoning : undefined,
		cost: isRecord(entry.cost) ? {
			input: num(entry.cost.input),
			output: num(entry.cost.output),
			cacheRead: num(entry.cost.cacheRead),
			cacheWrite: num(entry.cost.cacheWrite),
		} : undefined,
		promptCache: isRecord(entry.promptCache) ? {
			short: num(entry.promptCache.short),
			long: num(entry.promptCache.long),
		} : undefined,
		thinkingLevelMap: isRecord(entry.thinkingLevelMap)
			? Object.fromEntries(Object.entries(entry.thinkingLevelMap).map(([key, value]) => [key, typeof value === "string" ? value : null]))
			: undefined,
		api: str(entry.api),
		baseUrl: str(entry.baseUrl),
		headers: isRecord(entry.headers) ? entry.headers as Record<string, string> : undefined,
		compat: isRecord(entry.compat) ? entry.compat : undefined,
		inputLimits: isRecord(entry.inputLimits) ? entry.inputLimits : undefined,
		samplingParams: isRecord(entry.samplingParams) ? entry.samplingParams : undefined,
	};
}

function normalizeModelLike(value: Record<string, unknown>): ModelLike {
	const entry = normalizeModelEntry(value);
	return {
		name: entry.name,
		tags: entry.tags,
		input: entry.input,
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		reasoning: entry.reasoning,
		cost: entry.cost,
		promptCache: entry.promptCache,
		thinkingLevelMap: entry.thinkingLevelMap,
		api: entry.api,
		baseUrl: entry.baseUrl,
		headers: entry.headers,
		compat: entry.compat,
		inputLimits: entry.inputLimits,
		samplingParams: entry.samplingParams,
	};
}

async function saveConfig(): Promise<void> {
	const stale = config.projected.filter((key) => !config.providers[key]);
	config.projected = Object.keys(config.providers);
	const raw = JSON.stringify(config, null, 2) + "\n";
	configRaw = raw;
	const path = configPath();
	await withFileMutationQueue(path, async () => {
		fs.mkdirSync(dirname(path), { recursive: true });
		fs.writeFileSync(path, raw, "utf8");
	});
	await projectToModelsJson(stale);
}

/** Project provider fields and enabled models into models.json, keyed by pi's id. */
async function projectToModelsJson(staleKeys: string[]): Promise<void> {
	const path = modelsJsonPath();
	let json: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
		if (isRecord(parsed)) json = parsed;
	} catch {
		// new file
	}
	const providers = isRecord(json.providers) ? json.providers as Record<string, unknown> : {};
	const ours = new Set<string>([...Object.keys(config.providers), ...staleKeys]);
	for (const key of Object.keys(providers)) {
		// Only keys we own: ids we projected that no longer have a provider.
		if (!ours.has(key) || config.providers[key]) continue;
		delete providers[key];
	}
	for (const p of Object.values(config.providers)) {
		providers[p.id] = projectProvider(p);
	}
	json.providers = providers;
	const raw = JSON.stringify(json, null, 2) + "\n";
	await withFileMutationQueue(path, async () => {
		fs.mkdirSync(dirname(path), { recursive: true });
		fs.writeFileSync(path, raw, "utf8");
	});
}

function projectProvider(p: ProviderConfig): Record<string, unknown> {
	const out: Record<string, unknown> = {
		name: p.name ?? p.id,
		baseUrl: p.baseUrl,
		api: p.api ?? detectApi(p.baseUrl),
		models: p.models.filter((m) => m.enabled).map((m) => toModelsJsonModel(resolveOne(p, m).model)),
	};
	// With borrowed auth, pi resolves credentials its own way; a projected key
	// would silently take priority over auth.json, oauth, or env.
	if (!p.authFrom) {
		out.authHeader = p.authHeader !== false;
		if (p.apiKey) out.apiKey = p.apiKey;
	}
	if (p.headers) out.headers = p.headers;
	if (p.compat) out.compat = p.compat;
	return out;
}

function toModelsJsonModel(model: Model<Api>): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: model.id,
		name: model.name,
		api: model.api,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
	if (model.thinkingLevelMap) out.thinkingLevelMap = model.thinkingLevelMap;
	if (model.promptCache) out.promptCache = model.promptCache;
	if (model.headers) out.headers = model.headers;
	if (model.compat) out.compat = model.compat;
	if (model.inputLimits) out.inputLimits = model.inputLimits;
	if (model.samplingParams) out.samplingParams = model.samplingParams;
	return out;
}
// ============================== config watcher ==============================

let watcher: fs.FSWatcher | undefined;
let watchDebounce: ReturnType<typeof setTimeout> | undefined;

function startWatcher(): void {
	if (watcher) return;
	const dir = dirname(configPath());
	const file = basename(configPath());
	try {
		fs.mkdirSync(dir, { recursive: true });
		watcher = fs.watch(dir, (_event, filename) => {
			if (filename && filename !== file) return;
			if (watchDebounce) clearTimeout(watchDebounce);
			watchDebounce = setTimeout(() => {
				watchDebounce = undefined;
				let raw: string | undefined;
				try {
					raw = fs.readFileSync(configPath(), "utf8");
				} catch {
					return;
				}
				if (raw === configRaw) return;
				loadConfig();
				registerAll();
			}, 300);
		});
	} catch {
		watcher = undefined;
	}
}

function stopWatcher(): void {
	if (watchDebounce) {
		clearTimeout(watchDebounce);
		watchDebounce = undefined;
	}
	watcher?.close();
	watcher = undefined;
}
// ============================== authentication ==============================

const commandCache = new Map<string, string>();

/** pi's models.json/auth.json value syntax: $ENV, ${ENV}, !command, $$, $!, literal. */
async function resolveConfigValue(value: string): Promise<string | undefined> {
	if (value === "$$") return "$";
	if (value === "$!") return "!";
	if (value.startsWith("!")) {
		const command = value.slice(1);
		const cached = commandCache.get(command);
		if (cached !== undefined) return cached;
		try {
			const result = await piApi!.exec(command, [], { timeout: 10_000 });
			const output = result.stdout.trim();
			if (result.code === 0 && output) {
				commandCache.set(command, output);
				return output;
			}
		} catch {
			// unresolved
		}
		return undefined;
	}
	const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value);
	if (match) return process.env[match[1]!];
	return value;
}

function configSourceLabel(value: string | undefined): string {
	if (!value) return "config";
	if (value.startsWith("!")) return "command";
	const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(value);
	return match ? match[1]! : "config";
}

function maskKey(value: string | undefined): string {
	if (!value) return "not set";
	if (value.startsWith("$") || value.startsWith("!")) return value;
	return value.length > 8 ? "••••" + value.slice(-4) : "••••";
}
// ============================== api detection ==============================

function detectApi(baseUrl: string): string {
	const url = baseUrl.toLowerCase();
	if (url.includes("aiplatform.googleapis.com")) return "google-vertex";
	if (url.includes("generativelanguage.googleapis.com")) return "google-generative-ai";
	if (url.includes("anthropic")) return "anthropic-messages";
	if (url.includes("azure") || url.includes("cognitiveservices") || url.includes("openai.azure.com")) return "azure-openai-responses";
	if (url.includes("api.mistral.ai")) return "mistral-conversations";
	if (url.includes("bedrock")) return "bedrock-converse-stream";
	if (url.includes("/v1/responses") || url.endsWith("/responses")) return "openai-responses";
	return "openai-completions";
}
// ============================== model list discovery ==============================

function resolveModelsEndpoint(p: ProviderConfig): string {
	const base = p.baseUrl.replace(/\/+$/, "");
	const endpoint = p.modelsEndpoint?.trim();
	if (endpoint) {
		const resolved = endpoint.includes("{baseUrl}") ? endpoint.split("{baseUrl}").join(base) : endpoint;
		if (/^https?:\/\//i.test(resolved)) return resolved;
		return base + (resolved.startsWith("/") ? resolved : "/" + resolved);
	}
	// base ending in /vN -> {base}/models; bare base -> {base}/v1/models; never /v1/v1/models
	return /\/v\d+$/.test(base) ? base + "/models" : base + "/v1/models";
}

/** Pick a model list out of the shapes providers actually return. */
function rawList(json: unknown): Record<string, unknown>[] | undefined {
	if (Array.isArray(json)) return json as Record<string, unknown>[];
	if (!isRecord(json)) return undefined;
	for (const key of ["data", "models", "result", "items"]) {
		if (Array.isArray(json[key])) return json[key] as Record<string, unknown>[];
	}
	return undefined;
}

/**
 * One catalog entry from any provider list shape. OpenAI-compatible servers use
 * id plus optional display_name/context_length; Google uses a resource name
 * (models/<id>), displayName, and input/outputTokenLimit. Entries that cannot
 * answer a chat request (embeddings, TTS, image-only) are skipped.
 */
function pickRawModel(item: Record<string, unknown>): RawModel | undefined {
	const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : undefined;
	if (methods && !methods.includes("generateContent")) return undefined;
	const resource = str(item.name);
	const rawId = str(item.id) ?? str(item.model_id) ?? str(item.modelId) ?? resource;
	if (!rawId) return undefined;
	return {
		id: rawId,
		name: str(item.displayName) ?? str(item.display_name)
			?? (resource && resource !== rawId ? resource : undefined),
		ownedBy: str(item.owned_by) ?? str(item.ownedBy),
		created: num(item.created),
		contextLength: num(item.context_length) ?? num(item.context_window) ?? num(item.max_context_length) ?? num(item.max_model_len) ?? num(item.inputTokenLimit),
		outputLimit: num(item.outputTokenLimit),
	};
}

function parseModelsResponse(json: unknown): RawModel[] {
	const list = rawList(json);
	if (!list) return [];
	return dedupeModels(list.map((item) => (isRecord(item) ? pickRawModel(item) : undefined)).filter((m): m is RawModel => m !== undefined));
}

function dedupeModels(models: RawModel[]): RawModel[] {
	const seen = new Set<string>();
	return models.filter((model) => !seen.has(model.id) && (seen.add(model.id), true));
}

function nextPageToken(json: unknown): string | undefined {
	return isRecord(json) ? str(json.nextPageToken) ?? str(json.next_page_token) : undefined;
}

async function fetchDiscovery(p: ProviderConfig, signal: AbortSignal | undefined, apiKey: string | undefined): Promise<{ models: RawModel[]; error?: string }> {
	const headers: Record<string, string> = { ...(p.headers ?? {}) };
	if (apiKey && p.authHeader !== false) headers.Authorization = "Bearer " + apiKey;
	const base = resolveModelsEndpoint(p);
	const models: RawModel[] = [];
	let token: string | undefined;
	// Google-style page tokens, capped so a server replaying one cannot spin us forever.
	for (let page = 0; page < 10; page++) {
		const url = token ? base + (base.includes("?") ? "&" : "?") + "pageToken=" + encodeURIComponent(token) : base;
		let response: Response;
		try {
			response = await fetch(url, { headers, signal });
		} catch (error) {
			return { models: [], error: error instanceof Error ? error.message : String(error) };
		}
		if (!response.ok) return { models: [], error: "HTTP " + response.status };
		let json: unknown;
		try {
			json = await response.json();
		} catch {
			return { models: [], error: "invalid JSON response" };
		}
		models.push(...parseModelsResponse(json));
		token = nextPageToken(json);
		if (!token) break;
	}
	return { models: dedupeModels(models) };
}
// ============================== pi catalog matching ==============================

let catalogById = new Map<string, Model<Api>>();
let catalogByNorm = new Map<string, Model<Api>>();

function rebuildCatalog(models: readonly Model<Api>[]): void {
	catalogById = new Map();
	catalogByNorm = new Map();
	for (const model of models) {
		if (!catalogById.has(model.id)) catalogById.set(model.id, model);
		const norm = normalizeModelId(model.id);
		if (norm && !catalogByNorm.has(norm)) catalogByNorm.set(norm, model);
	}
}

/** The bundled catalog: metadata oracle for prefilling, no network needed. */
function rebuildCatalogFromBuiltin(): void {
	const models: Model<Api>[] = [];
	for (const provider of getBuiltinProviders()) {
		models.push(...getBuiltinModels(provider));
	}
	rebuildCatalog(models);
}

function matchCatalog(id: string): { model: Model<Api>; confidence: number } | undefined {
	const exact = catalogById.get(id) ?? catalogById.get(id.toLowerCase());
	if (exact) return { model: exact, confidence: 1 };
	const norm = normalizeModelId(id);
	const match = norm ? catalogByNorm.get(norm) : undefined;
	return match ? { model: match, confidence: 0.75 } : undefined;
}

// ============================== layered resolution ==============================

function resolveOne(p: ProviderConfig, entry: ModelEntry): ResolvedEntry {
	const raw = p.discovered?.models.find((m) => m.id === entry.id);
	const match = matchCatalog(entry.id);
	const cat = match?.model;
	const d = p.defaults;
	const prov: ProvMap = {};
	const mark = (key: string, layer: Layer, confidence?: number): void => {
		prov[key] = { layer, confidence };
	};

	let name: string;
	if (entry.name !== undefined) { name = entry.name; mark("name", "model"); }
	else if (cat?.name) { name = cat.name; mark("name", "catalog", match!.confidence); }
	else if (raw?.name) { name = raw.name; mark("name", "upstream"); }
	else { name = entry.id; mark("name", "inferred"); }

	let api: string;
	if (entry.api !== undefined) { api = entry.api; mark("api", "model"); }
	else if (p.api !== undefined) { api = p.api; mark("api", "provider"); }
	else { api = detectApi(p.baseUrl); mark("api", "inferred"); }

	let contextWindow: number;
	if (entry.contextWindow !== undefined) { contextWindow = entry.contextWindow; mark("contextWindow", "model"); }
	else if (d?.contextWindow !== undefined) { contextWindow = d.contextWindow; mark("contextWindow", "provider"); }
	else if (cat?.contextWindow) { contextWindow = cat.contextWindow; mark("contextWindow", "catalog", match!.confidence); }
	else if (raw?.contextLength) { contextWindow = raw.contextLength; mark("contextWindow", "upstream"); }
	else { contextWindow = DEFAULT_MODEL_CONTEXT_WINDOW; mark("contextWindow", "inferred"); }

	let maxTokens: number;
	if (entry.maxTokens !== undefined) { maxTokens = entry.maxTokens; mark("maxTokens", "model"); }
	else if (d?.maxTokens !== undefined) { maxTokens = d.maxTokens; mark("maxTokens", "provider"); }
	else if (cat?.maxTokens) { maxTokens = cat.maxTokens; mark("maxTokens", "catalog", match!.confidence); }
	else { maxTokens = DEFAULT_MODEL_MAX_TOKENS; mark("maxTokens", "inferred"); }

	let reasoning: boolean;
	if (entry.reasoning !== undefined) { reasoning = entry.reasoning; mark("reasoning", "model"); }
	else if (d?.reasoning !== undefined) { reasoning = d.reasoning; mark("reasoning", "provider"); }
	else if (cat?.reasoning !== undefined) { reasoning = cat.reasoning; mark("reasoning", "catalog", match!.confidence); }
	else { reasoning = looksLikeReasoner(entry.id); mark("reasoning", "inferred"); }

	let input: ("text" | "image")[];
	if (entry.input !== undefined) { input = entry.input; mark("input", "model"); }
	else if (d?.input !== undefined) { input = d.input; mark("input", "provider"); }
	else if (cat?.input) { input = cat.input; mark("input", "catalog", match!.confidence); }
	else { input = looksLikeVision(entry.id) ? ["text", "image"] : ["text"]; mark("input", "inferred"); }

	const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const fromModel = entry.cost?.[field];
		const fromProvider = d?.cost?.[field];
		const fromCatalog = cat?.cost[field];
		cost[field] = fromModel ?? fromProvider ?? fromCatalog ?? 0;
		if (fromModel !== undefined) mark("cost." + field, "model");
		else if (fromProvider !== undefined) mark("cost." + field, "provider");
		else if (fromCatalog !== undefined) mark("cost." + field, "catalog", match!.confidence);
		else mark("cost." + field, "inferred");
	}

	const promptCache: { short?: number; long?: number } = {};
	for (const tier of ["short", "long"] as const) {
		const fromModel = entry.promptCache?.[tier];
		const fromProvider = d?.promptCache?.[tier];
		const fromCatalog = cat?.promptCache?.[tier];
		const value = fromModel ?? fromProvider ?? fromCatalog;
		if (value !== undefined) {
			promptCache[tier] = value;
			if (fromModel !== undefined) mark("promptCache." + tier, "model");
			else if (fromProvider !== undefined) mark("promptCache." + tier, "provider");
			else mark("promptCache." + tier, "catalog", match!.confidence);
		} else {
			mark("promptCache." + tier, "inferred");
		}
	}

	const thinkingLevelMap = entry.thinkingLevelMap ?? d?.thinkingLevelMap ?? cat?.thinkingLevelMap;
	const compat = entry.compat ?? d?.compat ?? (cat as unknown as { compat?: Record<string, unknown> } | undefined)?.compat;
	const inputLimits = entry.inputLimits ?? d?.inputLimits ?? cat?.inputLimits;
	const samplingParams = entry.samplingParams ?? d?.samplingParams ?? cat?.samplingParams;
	mark("thinkingLevelMap", entry.thinkingLevelMap !== undefined ? "model" : d?.thinkingLevelMap !== undefined ? "provider" : cat?.thinkingLevelMap !== undefined ? "catalog" : "inferred", match?.confidence);
	mark("compat", entry.compat !== undefined ? "model" : d?.compat !== undefined ? "provider" : compat !== undefined ? "catalog" : "inferred", match?.confidence);
	mark("inputLimits", entry.inputLimits !== undefined ? "model" : d?.inputLimits !== undefined ? "provider" : inputLimits !== undefined ? "catalog" : "inferred", match?.confidence);
	mark("samplingParams", entry.samplingParams !== undefined ? "model" : d?.samplingParams !== undefined ? "provider" : samplingParams !== undefined ? "catalog" : "inferred", match?.confidence);

	const headers: Record<string, string> = { ...(p.headers ?? {}), ...(entry.headers ?? {}) };
	mark("baseUrl", entry.baseUrl !== undefined ? "model" : "provider");

	const model: Model<Api> = {
		id: entry.id,
		name,
		api,
		provider: p.id,
		baseUrl: entry.baseUrl ?? p.baseUrl,
		input,
		cost,
		reasoning,
		contextWindow,
		maxTokens,
	};
	if (Object.keys(headers).length > 0) model.headers = headers;
	if (Object.keys(promptCache).length > 0) model.promptCache = promptCache as Model<Api>["promptCache"];
	if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap as Model<Api>["thinkingLevelMap"];
	if (compat) model.compat = compat as Model<Api>["compat"];
	if (inputLimits) model.inputLimits = inputLimits as Model<Api>["inputLimits"];
	if (samplingParams) model.samplingParams = samplingParams;

	return { model, provenance: prov };
}
// ============================== provider factory ==============================

const registered = new Map<string, Provider<Api>>();

/**
 * Auth for one of our providers. authFrom hands pi's own builtin auth object
 * back to pi, so credentials, login, oauth, refresh and storage are never ours
 * to implement. Falls back to the local api-key flow if the id is unknown.
 */
function authFor(p: ProviderConfig): Provider<Api>["auth"] {
	if (p.authFrom) {
		const borrowed = borrowedAuth(p.authFrom);
		if (borrowed) return borrowed;
	}
	return ownApiKeyAuth(p);
}

function ownApiKeyAuth(p: ProviderConfig): Provider<Api>["auth"] {
	return {
		apiKey: {
			name: (p.name ?? p.id) + " API key",
			login: async (interaction) => {
				const key = await interaction.prompt({
					type: "secret",
					message: "API key for " + (p.name ?? p.id),
					placeholder: "$ENV_VAR, !command, or literal - empty to skip",
				});
				return { type: "api_key", key: key.trim() || undefined };
			},
			resolve: async ({ credential }) => {
				// oauth credentials become request auth inside pi; never claim one here.
				const stored = credential?.type === "api_key" ? credential.key : undefined;
				const key = await resolveConfigValue(stored ?? p.apiKey ?? "");
				if (!key) return undefined;
				return {
					auth: { apiKey: key, headers: p.headers },
					source: credential ? "stored credential" : configSourceLabel(p.apiKey),
				};
			},
		},
	};
}

let borrowedAuthCache: Map<string, Provider<Api>["auth"]> | undefined;
function builtinAuthMap(): Map<string, Provider<Api>["auth"]> {
	if (!borrowedAuthCache) {
		borrowedAuthCache = new Map();
		try {
			for (const provider of builtinProviders()) borrowedAuthCache.set(provider.id, provider.auth);
		} catch {
			borrowedAuthCache = new Map();
		}
	}
	return borrowedAuthCache;
}

function borrowedAuth(id: string): Provider<Api>["auth"] | undefined {
	return builtinAuthMap().get(id);
}

/** Only builtins that actually have an OAuth flow are worth borrowing. */
function authSourceIds(): string[] {
	return [...builtinAuthMap().entries()].filter(([, auth]) => auth.oauth).map(([id]) => id).sort();
}

function buildProvider(p: ProviderConfig): Provider<Api> {
	const models = p.models.map((entry) => resolveOne(p, entry).model);
	const enabledIds = new Set(p.models.filter((m) => m.enabled).map((m) => m.id));

	const implFor = (model: Model<Api>): ProviderStreams => {
		const factory = API_IMPLS[model.api] ?? API_IMPLS["openai-completions"];
		return factory();
	};

	return {
		id: p.id,
		name: p.name ?? p.id,
		baseUrl: p.baseUrl,
		headers: p.headers,
		auth: authFor(p),
		getModels: () => models,
		filterModels: (list) => list.filter((m) => enabledIds.has(m.id)),
		refreshModels: async (context) => {
			if (!context.allowNetwork) return;
			const credential = context.credential;
			const fromCredential = credential?.type === "api_key" ? credential.key : credential?.type === "oauth" ? credential.access : undefined;
			const result = await fetchDiscovery(p, context.signal, fromCredential ?? (p.apiKey ? await resolveConfigValue(p.apiKey) : undefined));
			if (context.signal.aborted || result.error) return;
			p.discovered = { fetchedAt: Date.now(), models: result.models };
			await saveConfig();
			const fresh = p.models.map((entry) => resolveOne(p, entry).model);
			await context.publish({ update: () => {
				models.length = 0;
				models.push(...fresh);
			} });
		},
		stream: (model, context, options) => implFor(model).stream(model, context, options),
		streamSimple: (model, context, options) => implFor(model).streamSimple(model, context, options),
	};
}

function registerProvider(id: string): void {
	const p = config.providers[id];
	if (!p) {
		if (registered.has(id)) {
			piApi!.unregisterProvider(id);
			registered.delete(id);
		}
		return;
	}
	const provider = buildProvider(p);
	registered.set(id, provider);
	piApi!.registerProvider(provider);
}

function registerAll(): void {
	for (const id of [...registered.keys()]) {
		if (!config.providers[id]) {
			piApi!.unregisterProvider(id);
			registered.delete(id);
		}
	}
	for (const id of Object.keys(config.providers)) registerProvider(id);
}
// ============================== ui helpers ==============================

/** Provider ids pi ships with; a bare id of ours may shadow one by explicit choice. */
let builtinIdsCache: Set<string> | undefined;
function builtinProviderIds(): Set<string> {
	if (!builtinIdsCache) {
		try {
			builtinIdsCache = new Set<string>(getBuiltinProviders());
		} catch {
			builtinIdsCache = new Set<string>();
		}
	}
	return builtinIdsCache;
}
function isBuiltinProviderId(id: string): boolean {
	return builtinProviderIds().has(id);
}
function rule(theme: Theme, width: number): string {
	return theme.fg("border", "─".repeat(Math.max(1, width)));
}

function formatKeys(keys: readonly string[], capitalize: boolean): string {
	return keys.join("/").split("/").map((key) => key.split("+").map((part) => {
		const display = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
		return capitalize ? display.charAt(0).toUpperCase() + display.slice(1) : display;
	}).join("+")).join("/");
}

function keyDisplay(keybindingId: keyof Keybindings): string {
	return formatKeys(getKeybindings().getKeys(keybindingId), true);
}

function keyHints(theme: Theme, entries: Array<[string, string?]>): string {
	return entries.map(([key, label]) => theme.fg("dim", key) + (label ? theme.fg("muted", " " + label) : "")).join("  ");
}
/* Menu hint row: [keybinding id or literal key, label] pairs. */
function menuFooter(theme: Theme, cancelLabel: string, extra?: Array<[string, string?]>): string {
	return keyHints(theme, [
		...extra ?? [],
		["↑↓", "navigate"],
		[keyDisplay("tui.select.confirm"), "select"],
		[keyDisplay("tui.select.cancel"), cancelLabel],
	]);
}

function visibleRange(total: number, cursor: number, maxVisible: number): { start: number; end: number } {
	const start = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), total - maxVisible));
	return { start, end: Math.min(start + maxVisible, total) };
}

function modelDisplayName(p: ProviderConfig, id: string): string {
	const entry = p.models.find((m) => m.id === id);
	return entry ? resolveOne(p, entry).model.name : id;
}

function rowSearchText(p: ProviderConfig, row: { id: string; known: boolean }): string {
	const name = row.known ? modelDisplayName(p, row.id) : undefined;
	const suffix = name && name !== row.id ? " " + name : "";
	return row.id + " " + p.id + " " + p.id + "/" + row.id + " " + row.id + suffix;
}

function modelSummaryLine(p: ProviderConfig, id: string): string {
	const entry = p.models.find((m) => m.id === id);
	if (!entry) return "";
	const resolved = resolveOne(p, entry);
	return `${formatTokens(resolved.model.contextWindow)}/${formatTokens(resolved.model.maxTokens)} ctx · ${resolved.model.input.join("/")}${resolved.model.reasoning ? " · think" : ""} · $${resolved.model.cost.input}/$${resolved.model.cost.output}`;
}

function providerSummaryLine(p: ProviderConfig): string {
	const enabled = p.models.filter((m) => m.enabled).length;
	const disabled = p.models.length - enabled;
	const knownIds = new Set(p.models.map((m) => m.id));
	const unadded = (p.discovered?.models ?? []).filter((m) => !knownIds.has(m.id)).length;
	const parts: string[] = [enabled + " enabled"];
	if (disabled > 0) parts.push(disabled + " disabled");
	if (unadded > 0) parts.push(unadded + " not added");
	if (isBuiltinProviderId(p.id)) parts.push("shadows builtin");
	parts.push(p.authFrom ? "auth via pi/" + p.authFrom : maskKey(p.apiKey));
	return parts.join(" · ");
}

function layerLabel(layer: Layer, confidence?: number): string {
	if (layer === "catalog") {
		return "pi catalog" + (confidence !== undefined && confidence < 1 ? " (" + Math.round(confidence * 100) + "%)" : "");
	}
	if (layer === "model") return "your override";
	if (layer === "provider") return "provider default";
	if (layer === "upstream") return "endpoint";
	return "inferred";
}

// ============================== screens ==============================

interface MenuItem { label: string; hint?: string; onSelect: () => void; danger?: boolean }
interface MenuModel { title: string; subtitle?: string; groups: MenuItem[][]; footer: string }

class MenuScreen implements Screen {
	private cursor = 0;
	private search: Input;
	private query = "";
	private theme: Theme;
	private build: () => MenuModel;
	private cancel: () => void;
	private refresh: () => void;

	constructor(theme: Theme, build: () => MenuModel, cancel: () => void, refresh: () => void) {
		this.theme = theme;
		this.build = build;
		this.cancel = cancel;
		this.refresh = refresh;
		this.search = new Input({ placeholder: "Search" });
		this.search.focused = true;
	}

	focus(): void {
		this.search.focused = true;
	}

	/** All rows, or the fuzzy-filtered subset while a query is active. */
	private entries(): MenuItem[] {
		const all = this.build().groups.flat();
		const query = this.query.trim();
		return query ? fuzzyFilter(all, query, (item) => item.label + " " + (item.hint ?? "")) : all;
	}

	render(width: number): string[] {
		const model = this.build();
		const query = this.query.trim();
		const entries = this.entries();
		const lines: string[] = [rule(this.theme, width), ""];
		lines.push("  " + this.theme.fg("accent", this.theme.bold(model.title)));
		if (model.subtitle) lines.push("  " + this.theme.fg("muted", model.subtitle));
		lines.push("");
		for (const line of this.search.render(width)) lines.push("  " + line);
		lines.push("");
		if (entries.length === 0) {
			lines.push("  " + this.theme.fg("muted", "No matching entries"));
		} else if (query) {
			// A filter flattens groups: positions would no longer mean anything.
			for (let index = 0; index < Math.min(entries.length, 12); index++) {
				lines.push(this.row(entries[index]!, index === this.cursor, width));
			}
			if (entries.length > 12) lines.push("  " + this.theme.fg("muted", "... " + (entries.length - 12) + " more"));
		} else {
			let cursor = 0;
			model.groups.forEach((group, groupIndex) => {
				if (groupIndex > 0) lines.push(this.theme.fg("muted", "  —————————————————"));
				for (const item of group) {
					lines.push(this.row(item, cursor === this.cursor, width));
					cursor++;
				}
			});
		}
		const count = query ? "  " + this.theme.fg("muted", "(" + (this.cursor + 1) + "/" + entries.length + ")") : "";
		lines.push("", "  " + model.footer + count + "  " + this.theme.fg("dim", "\u00b7 type to search"), "", rule(this.theme, width));
		return lines;
	}

	private row(item: MenuItem, selected: boolean, width: number): string {
		const prefix = selected ? this.theme.fg("accent", "\u2192 ") : "  ";
		const color = item.danger ? "error" : selected ? "accent" : "text";
		const hint = item.hint ? "  " + this.theme.fg("muted", item.hint) : "";
		return truncateToWidth(prefix + this.theme.fg(color, item.label) + hint, width);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const total = this.entries().length;
		if (kb.matches(data, "tui.select.up")) {
			if (total > 0) this.cursor = this.cursor === 0 ? total - 1 : this.cursor - 1;
		} else if (kb.matches(data, "tui.select.down")) {
			if (total > 0) this.cursor = this.cursor === total - 1 ? 0 : this.cursor + 1;
		} else if (kb.matches(data, "tui.select.confirm") || (data === " " && !this.query)) {
			const item = this.entries()[this.cursor];
			if (item) item.onSelect();
		} else if (matchesKey(data, Key.ctrl("c"))) {
			// Ctrl+C clears the query first, then exits - same as pi's pickers.
			if (this.query) this.setQuery("");
			else this.cancel();
			this.refresh();
			return;
		} else if (kb.matches(data, "tui.select.cancel") && !this.query) {
			this.cancel();
			this.refresh();
			return;
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.setQuery("");
		} else {
			this.search.handleInput(data);
			this.setQuery(this.search.getValue());
		}
		this.refresh();
	}

	private setQuery(query: string): void {
		this.query = query;
		this.search.setValue(query);
		this.cursor = 0;
	}
}
function promptView(theme: Theme, title: string | undefined, label: string, input: Input, getError: () => string | undefined, hints: Array<[string, string?]>) {
	return {
		render(width: number): string[] {
			const lines: string[] = [rule(theme, width), ""];
			if (title) lines.push("  " + theme.fg("accent", theme.bold(title)));
			lines.push("  " + theme.fg("text", label));
			lines.push("");
			for (const line of input.render(width)) lines.push(line);
			const error = getError();
			if (error) lines.push("  " + theme.fg("error", error));
			lines.push("", "  " + keyHints(theme, hints), "", rule(theme, width));
			return lines;
		},
		handleInput(data: string): void {
			input.handleInput(data);
		},
		invalidate(): void {
			input.invalidate();
		},
	};
}

type SubmenuDone = (selectedValue?: string, options?: { navigateTo?: string }) => void;

function miniInput(theme: Theme, label: string, initial: string, placeholder: string | undefined, done: SubmenuDone, refresh: () => void, validate?: (value: string) => string | undefined) {
	const input = new Input({ placeholder });
	input.setValue(initial);
	input.focused = true;
	const errorRef = { current: undefined as string | undefined };
	input.onSubmit = (value) => {
		const problem = validate?.(value);
		if (problem) {
			errorRef.current = problem;
			refresh();
			return;
		}
		done(value);
	};
	input.onEscape = () => done(undefined);
	const view = promptView(theme, undefined, label, input, () => errorRef.current, [
		[keyDisplay("tui.input.submit"), "save"],
		[keyDisplay("tui.select.cancel"), "cancel"],
	]);
	return {
		render: (width: number) => view.render(width),
		handleInput: (data: string) => {
			errorRef.current = undefined;
			view.handleInput(data);
		},
		invalidate: () => view.invalidate(),
	};
}

function miniNumberInput(theme: Theme, label: string, current: number | undefined, done: SubmenuDone, refresh: () => void) {
	const input = new Input({ placeholder: "number — empty to inherit" });
	if (current !== undefined) input.setValue(String(current));
	input.focused = true;
	const errorRef = { current: undefined as string | undefined };
	input.onSubmit = (value) => {
		const trimmed = value.trim();
		if (!trimmed) {
			done("");
			return;
		}
		const parsed = Number(trimmed);
		if (!Number.isFinite(parsed) || parsed < 0) {
			errorRef.current = "Enter a non-negative number";
			refresh();
			return;
		}
		done(trimmed);
	};
	input.onEscape = () => done(undefined);
	const view = promptView(theme, undefined, label, input, () => errorRef.current, [
		[keyDisplay("tui.input.submit"), "save"],
		[keyDisplay("tui.select.cancel"), "cancel"],
	]);
	return {
		render: (width: number) => view.render(width),
		handleInput: (data: string) => {
			errorRef.current = undefined;
			view.handleInput(data);
		},
		invalidate: () => view.invalidate(),
	};
}

function miniJsonInput(theme: Theme, label: string, initial: string, done: SubmenuDone, refresh: () => void) {
	const input = new Input({ placeholder: '{"key": "value"} — empty to inherit' });
	input.setValue(initial);
	input.focused = true;
	const errorRef = { current: undefined as string | undefined };
	input.onSubmit = (value) => {
		const trimmed = value.trim();
		if (!trimmed) {
			done("");
			return;
		}
		try {
			JSON.parse(trimmed);
			done(trimmed);
		} catch (error) {
			errorRef.current = error instanceof Error ? error.message : "invalid JSON";
			refresh();
		}
	};
	input.onEscape = () => done(undefined);
	const view = promptView(theme, undefined, label, input, () => errorRef.current, [
		[keyDisplay("tui.input.submit"), "save"],
		[keyDisplay("tui.select.cancel"), "cancel"],
	]);
	return {
		render: (width: number) => view.render(width),
		handleInput: (data: string) => {
			errorRef.current = undefined;
			view.handleInput(data);
		},
		invalidate: () => view.invalidate(),
	};
}

function miniConfirm(theme: Theme, title: string, message: string, onConfirm: () => void, onCancel: () => void) {
	return {
		render(width: number): string[] {
			const lines: string[] = [rule(theme, width), ""];
			lines.push("  " + theme.fg("error", theme.bold(title)));
			for (const line of message.split("\n")) lines.push("  " + theme.fg("text", line));
			lines.push("", "  " + keyHints(theme, [[keyDisplay("tui.select.confirm"), "confirm"], [keyDisplay("tui.select.cancel"), "cancel"]]), "", rule(theme, width));
			return lines;
		},
		handleInput(data: string): void {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.confirm")) onConfirm();
			else if (kb.matches(data, "tui.select.cancel")) onCancel();
		},
		invalidate(): void {},
	};
}

class PromptScreen implements Screen {
	private input: Input;
	private error?: string;

	private theme: Theme;
	private title: string;
	private label: string;
	private submit: (value: string) => void;
	private cancel: () => void;
	private refresh: () => void;
	private validate: ((value: string) => string | undefined) | undefined;

	constructor(
		theme: Theme,
		title: string,
		label: string,
		placeholder: string | undefined,
		initial: string,
		submit: (value: string) => void,
		cancel: () => void,
		refresh: () => void,
		validate?: (value: string) => string | undefined,
	) {
		this.theme = theme;
		this.title = title;
		this.label = label;
		this.submit = submit;
		this.cancel = cancel;
		this.refresh = refresh;
		this.validate = validate;
		this.input = new Input({ placeholder });
		this.input.setValue(initial);
		this.input.focused = true;
		this.input.onSubmit = (value) => {
			const problem = this.validate?.(value);
			if (problem) {
				this.error = problem;
				this.refresh();
				return;
			}
			this.submit(value);
		};
		this.input.onEscape = () => this.cancel();
	}

	focus(): void {
		this.input.focused = true;
	}

	render(width: number): string[] {
		return promptView(this.theme, this.title, this.label, this.input, () => this.error, [
			[keyDisplay("tui.input.submit"), "continue"],
			[keyDisplay("tui.select.cancel"), "cancel"],
		]).render(width);
	}

	handleInput(data: string): void {
		this.error = undefined;
		this.input.handleInput(data);
	}

	invalidate(): void {
		this.input.invalidate();
	}
}
class SettingsScreen implements Screen {
	private list: SettingsList;

	private theme: Theme;
	private title: string;
	private subtitle: string | undefined;
	private buildItems: () => SettingItem[];
	private apply: (id: string, value: string) => void;
	private onCancel: () => void;
	private refresh: () => void;

	constructor(
		theme: Theme,
		title: string,
		subtitle: string | undefined,
		buildItems: () => SettingItem[],
		apply: (id: string, value: string) => void,
		onCancel: () => void,
		refresh: () => void,
	) {
		this.theme = theme;
		this.title = title;
		this.subtitle = subtitle;
		this.buildItems = buildItems;
		this.apply = apply;
		this.onCancel = onCancel;
		this.refresh = refresh;
		this.list = this.makeList();
	}

	private makeList(): SettingsList {
		const items = this.buildItems();
		return new SettingsList(items, Math.min(items.length + 2, MAX_SETTINGS_ROWS), getSettingsListTheme(), (id, value) => {
			this.apply(id, value);
			this.list = this.makeList();
			this.list.selectItem(id);
			this.refresh();
		}, () => this.onCancel(), { enableSearch: true });
	}

	render(width: number): string[] {
		const lines: string[] = [rule(this.theme, width), ""];
		lines.push("  " + this.theme.fg("accent", this.theme.bold(this.title)));
		if (this.subtitle) lines.push("  " + this.theme.fg("muted", this.subtitle));
		lines.push("");
		for (const line of this.list.render(width)) lines.push(line);
		lines.push("", "  " + keyHints(this.theme, [["↑↓", "navigate"], [keyDisplay("tui.select.confirm"), "change"], [keyDisplay("tui.select.cancel"), "back"]]), "", rule(this.theme, width));
		return lines;
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}
}
class ScreenStack {
	private stack: Screen[] = [];

	public requestRender: () => void;
	private onEmpty: () => void;

	constructor(requestRender: () => void, onEmpty: () => void) {
		this.requestRender = requestRender;
		this.onEmpty = onEmpty;
	}

	push(screen: Screen): void {
		this.stack.push(screen);
		screen.focus?.();
		this.requestRender();
	}

	pop(count = 1): void {
		for (let index = 0; index < count && this.stack.length > 0; index++) this.stack.pop();
		if (this.stack.length === 0) {
			this.onEmpty();
		} else {
			this.stack[this.stack.length - 1]!.focus?.();
		}
		this.requestRender();
	}

	popTo(depth: number): void {
		while (this.stack.length > depth) this.stack.pop();
		if (this.stack.length === 0) this.onEmpty();
		else this.stack[this.stack.length - 1]!.focus?.();
		this.requestRender();
	}

	close(): void {
		this.stack = [];
		this.onEmpty();
		this.requestRender();
	}

	render(width: number): string[] {
		return this.stack[this.stack.length - 1]?.render(width) ?? [];
	}

	handleInput(data: string): void {
		this.stack[this.stack.length - 1]?.handleInput(data);
	}
}

// ============================== curator ==============================

type CuratorState = "enabled" | "disabled" | "unadded";
interface CuratorRow { id: string; state: CuratorState; known: boolean; available: boolean }

class CuratorScreen implements Screen {
	private cursor = 0;
	private rows: CuratorRow[] = [];
	private filtered: CuratorRow[] = [];
	private search: Input;
	private confirmId: string | undefined;
	private status: { text: string; kind: "muted" | "success" | "warning" | "error" } | undefined;

	private theme: Theme;
	private view: ViewState;
	private ctx: ExtensionContext;
	private stack: ScreenStack;
	private refresh: () => void;

	constructor(
		theme: Theme,
		view: ViewState,
		ctx: ExtensionContext,
		stack: ScreenStack,
		refresh: () => void,
	) {
		this.theme = theme;
		this.view = view;
		this.ctx = ctx;
		this.stack = stack;
		this.refresh = refresh;
		this.search = new Input({ placeholder: "Search models" });
		this.search.focused = true;
		this.rebuild();
		this.kickRefresh();
	}

	private get work(): ProviderConfig {
		return this.view.work;
	}

	private isAvailable(id: string): boolean {
		const discovered = this.work.discovered;
		if (!discovered) return true;
		return discovered.models.some((m) => m.id === id);
	}

	private rebuild(preserveId?: string): void {
		const knownIds = new Set(this.work.models.map((m) => m.id));
		const unadded = (this.work.discovered?.models ?? []).filter((m) => !knownIds.has(m.id));
		this.rows = [
			...this.work.models.filter((m) => m.enabled).map((m) => ({ id: m.id, state: "enabled" as const, known: true, available: this.isAvailable(m.id) })),
			...this.work.models.filter((m) => !m.enabled).map((m) => ({ id: m.id, state: "disabled" as const, known: true, available: this.isAvailable(m.id) })),
			...unadded.map((m) => ({ id: m.id, state: "unadded" as const, known: false, available: true })),
		];
		this.applyFilter();
		if (preserveId) {
			const index = this.filtered.findIndex((row) => row.id === preserveId);
			if (index >= 0) this.cursor = index;
		}
	}

	private applyFilter(): void {
		const query = this.search.getValue();
		this.filtered = query ? fuzzyFilter(this.rows, query, (row) => rowSearchText(this.work, row)) : [...this.rows];
		this.cursor = Math.min(this.cursor, Math.max(0, this.filtered.length - 1));
	}

	private counts(): { enabled: number; disabled: number; unadded: number } {
		const enabled = this.work.models.filter((m) => m.enabled).length;
		const knownIds = new Set(this.work.models.map((m) => m.id));
		return {
			enabled,
			disabled: this.work.models.length - enabled,
			unadded: (this.work.discovered?.models ?? []).filter((m) => !knownIds.has(m.id)).length,
		};
	}

	private footerLine(): string {
		const counts = this.counts();
		return keyHints(this.theme, [
			[keyDisplay("tui.select.confirm"), "toggle"],
			[keyDisplay("app.models.enableAll"), "add all"],
			[keyDisplay("app.models.clearAll"), "disable all"],
			[keyDisplay("app.models.reorderUp") + "/" + keyDisplay("app.models.reorderDown"), "reorder"],
			[keyDisplay("app.models.save"), "save"],
			[counts.enabled + " enabled · " + counts.disabled + " disabled · " + counts.unadded + " not added"],
		]) + (this.view.dirty ? this.theme.fg("warning", " (unsaved)") : "");
	}

	private rowLine(row: CuratorRow, selected: boolean, width: number): string {
		const prefix = selected ? this.theme.fg("accent", "→ ") : "  ";
		const tick = row.state === "enabled" ? this.theme.fg("accent", "✓ ") : row.state === "disabled" ? this.theme.fg("dim", "✓ ") : "  ";
		const styledId = row.available ? row.id : this.theme.strikethrough(row.id);
		const idText = selected ? this.theme.fg("accent", styledId) : row.available ? this.theme.fg("text", styledId) : this.theme.fg("dim", styledId);
		const badge = !row.available
			? this.theme.fg("warning", " [unavailable]")
			: row.known ? this.theme.fg("muted", " [" + this.work.id + "]") : this.theme.fg("muted", " [not added]");
		const summary = row.known ? "  " + this.theme.fg("dim", modelSummaryLine(this.work, row.id)) : "";
		return truncateToWidth(prefix + tick + idText + badge + summary, width);
	}

	render(width: number): string[] {
		const lines: string[] = [rule(this.theme, width), ""];
		lines.push("  " + this.theme.fg("accent", this.theme.bold("Model Configuration — " + this.work.id)));
		lines.push("  " + this.theme.fg("muted", "Edits apply in this view. " + keyDisplay("app.models.save") + " to save and refresh."));
		lines.push("");
		for (const line of this.search.render(width)) lines.push(line);
		lines.push("");
		if (this.confirmId) {
			lines.push("  " + this.theme.fg("warning", "Delete " + this.confirmId + "? This removes its model-specific configuration."));
			lines.push("  " + keyHints(this.theme, [[keyDisplay("tui.select.confirm"), "confirm"], [keyDisplay("tui.select.cancel"), "cancel"]]));
		} else {
			const range = visibleRange(this.filtered.length, this.cursor, MAX_VISIBLE_ROWS);
			let lastState: CuratorState | undefined;
			for (let index = range.start; index < range.end; index++) {
				const row = this.filtered[index]!;
				if (row.state !== lastState) {
					if (lastState !== undefined) lines.push("  " + this.theme.fg("dim", "───"));
					lastState = row.state;
				}
				lines.push(this.rowLine(row, index === this.cursor, width));
			}
			if (this.filtered.length === 0) lines.push("  " + this.theme.fg("muted", "No matching models"));
			if (range.start > 0 || range.end < this.filtered.length) {
				lines.push("  " + this.theme.fg("muted", "  (" + (this.cursor + 1) + "/" + this.filtered.length + ")"));
			}
			const selected = this.filtered[this.cursor];
			if (selected) {
				lines.push("");
				if (selected.known) {
					const entry = this.work.models.find((m) => m.id === selected.id);
					if (entry) {
						const resolved = resolveOne(this.work, entry);
						lines.push("  " + this.theme.fg("muted", "Model Name: " + resolved.model.name));
						lines.push("  " + this.theme.fg("muted", `${formatTokens(resolved.model.contextWindow)}/${formatTokens(resolved.model.maxTokens)} ctx · ${resolved.model.input.join("|")} · $${resolved.model.cost.input}/$${resolved.model.cost.output} · ${resolved.model.api}`));
					}
				} else {
					const raw = this.work.discovered?.models.find((m) => m.id === selected.id);
					const parts: string[] = [];
					if (raw?.contextLength) parts.push(formatTokens(raw.contextLength) + " ctx");
					if (raw?.ownedBy) parts.push(raw.ownedBy);
					lines.push("  " + this.theme.fg("muted", "Model Name: " + (raw?.name ?? selected.id) + (parts.length ? "  " + parts.join(" · ") : "")));
				}
			}
		}
		lines.push("");
		if (this.status) lines.push("  " + this.theme.fg(this.status.kind, this.status.text));
		lines.push("  " + this.footerLine());
		lines.push("", rule(this.theme, width));
		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.confirmId) {
			if (kb.matches(data, "tui.select.confirm")) {
				const id = this.confirmId;
				this.confirmId = undefined;
				this.deleteModel(id);
			} else if (kb.matches(data, "tui.select.cancel")) {
				this.confirmId = undefined;
			}
			this.refresh();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.move(-1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.move(1);
		} else if (kb.matches(data, "app.models.reorderUp")) {
			this.reorder(-1);
		} else if (kb.matches(data, "app.models.reorderDown")) {
			this.reorder(1);
		} else if (kb.matches(data, "tui.select.confirm") || (data === " " && !this.search.getValue())) {
			this.toggle();
		} else if (kb.matches(data, "app.models.enableAll")) {
			this.setAll(true);
		} else if (kb.matches(data, "app.models.clearAll")) {
			this.setAll(false);
		} else if (kb.matches(data, "app.models.save")) {
			this.save();
		} else if (matchesKey(data, Key.ctrl("d"))) {
			this.requestDelete();
		} else if (matchesKey(data, Key.ctrl("c"))) {
			if (this.search.getValue()) {
				this.search.setValue("");
				this.applyFilter();
			} else {
				exitProviderView(this.stack, this.view, this.ctx, this.theme);
				return;
			}
		} else if (matchesKey(data, Key.escape) || kb.matches(data, "tui.select.cancel")) {
			exitProviderView(this.stack, this.view, this.ctx, this.theme);
			return;
		} else {
			this.search.handleInput(data);
			this.applyFilter();
		}
		this.refresh();
	}

	private move(delta: -1 | 1): void {
		if (this.filtered.length === 0) return;
		this.cursor = delta === -1
			? this.cursor === 0 ? this.filtered.length - 1 : this.cursor - 1
			: this.cursor === this.filtered.length - 1 ? 0 : this.cursor + 1;
	}

	private toggle(): void {
		const row = this.filtered[this.cursor];
		if (!row) return;
		if (row.state === "unadded") {
			this.work.models.push({ id: row.id, enabled: true });
		} else {
			const entry = this.work.models.find((m) => m.id === row.id);
			if (entry) entry.enabled = row.state !== "enabled";
		}
		this.canonicalize();
		this.view.dirty = true;
		this.rebuild(row.id);
	}

	private setAll(enabled: boolean): void {
		const targets = this.search.getValue() ? this.filtered : this.rows;
		for (const row of targets) {
			const entry = this.work.models.find((m) => m.id === row.id);
			if (entry) {
				entry.enabled = enabled;
			} else if (enabled && row.state === "unadded") {
				this.work.models.push({ id: row.id, enabled: true });
			}
		}
		this.canonicalize();
		this.view.dirty = true;
		this.rebuild();
	}

	private reorder(delta: -1 | 1): void {
		const row = this.filtered[this.cursor];
		if (!row || row.state !== "enabled") return;
		const list = this.work.models;
		const from = list.findIndex((m) => m.id === row.id);
		const to = from + delta;
		if (from < 0 || to < 0 || to >= list.length) return;
		if (!list[to]!.enabled) return;
		const swapped = list[to]!;
		list[to] = list[from]!;
		list[from] = swapped;
		this.view.dirty = true;
		this.rebuild(row.id);
	}

	private requestDelete(): void {
		const row = this.filtered[this.cursor];
		if (!row || !row.known) return;
		this.confirmId = row.id;
	}

	private deleteModel(id: string): void {
		this.work.models = this.work.models.filter((m) => m.id !== id);
		this.view.dirty = true;
		this.rebuild();
	}

	private canonicalize(): void {
		this.work.models = [...this.work.models.filter((m) => m.enabled), ...this.work.models.filter((m) => !m.enabled)];
	}

	private save(): void {
		void saveProviderView(this.view, this.ctx);
		this.view.dirty = false;
	}

	private kickRefresh(): void {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
		this.status = { text: "Refreshing model list…", kind: "muted" };
		this.refresh();
		void (async () => {
			try {
				const apiKey = await this.resolveApiKey();
				const result = await fetchDiscovery(this.work, controller.signal, apiKey);
				clearTimeout(timeout);
				if (controller.signal.aborted) {
					this.status = { text: "Model list refresh timed out", kind: "warning" };
				} else if (result.error) {
					this.status = { text: "Model list: " + result.error, kind: "error" };
				} else {
					this.work.discovered = { fetchedAt: Date.now(), models: result.models };
					this.rebuild();
					this.status = { text: "Fetched " + result.models.length + " models", kind: "success" };
				}
			} catch (error) {
				clearTimeout(timeout);
				this.status = { text: error instanceof Error ? error.message : String(error), kind: "error" };
			}
			this.refresh();
		})();
	}

	private async resolveApiKey(): Promise<string | undefined> {
		try {
			const auth = await this.ctx.modelRegistry.getProviderAuth(this.work.id);
			if (auth?.auth.apiKey) return auth.auth.apiKey;
		} catch {
			// fall through to the configured value
		}
		return this.work.apiKey ? resolveConfigValue(this.work.apiKey) : undefined;
	}
}

// ============================== flows ==============================

async function openCustom(ctx: ExtensionContext, build: (stack: ScreenStack, theme: Theme) => Screen): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const stack = new ScreenStack(() => tui.requestRender(), done);
		stack.push(build(stack, theme));
		return {
			render: (width: number) => stack.render(width),
			handleInput: (data: string) => stack.handleInput(data),
			invalidate: () => {},
		};
	});
}

function hubScreen(stack: ScreenStack, ctx: ExtensionContext, theme: Theme): MenuScreen {
	return new MenuScreen(theme, () => {
		const providers = Object.values(config.providers);
		return {
			title: "Custom Providers",
			subtitle: providers.length === 0
				? "No providers yet — add one to begin"
				: providers.length + " provider" + (providers.length === 1 ? "" : "s"),
			groups: [
				[
					{ label: "Add provider", onSelect: () => addProviderWizard(stack, ctx, theme) },
					{ label: "Refresh providers", onSelect: () => void refreshProviders(ctx).then(() => stack.requestRender()) },
				],
				providers.map((p) => ({
					label: p.name ?? p.id,
					hint: providerSummaryLine(p),
					onSelect: () => stack.push(providerMenuScreen(stack, ctx, theme, p.id)),
				})),
				[{ label: "Exit", onSelect: () => stack.close() }],
			],
			footer: keyHints(theme, [["↑↓", "navigate"], [keyDisplay("tui.select.confirm"), "select"], [keyDisplay("tui.select.cancel"), "exit"]]),
		};
	}, () => stack.close(), () => stack.requestRender());
}

function providerMenuScreen(stack: ScreenStack, ctx: ExtensionContext, theme: Theme, id: string): MenuScreen {
	const saved = config.providers[id];
	if (!saved) throw new Error("Unknown provider: " + id);
	const view: ViewState = { id, work: clone(saved), snapshot: clone(saved), dirty: false };
	return new MenuScreen(theme, () => {
		const work = view.work;
		const enabled = work.models.filter((m) => m.enabled).length;
		return {
			title: work.name ?? id,
			subtitle: enabled + " enabled · " + (work.models.length - enabled) + " disabled · " + work.models.length + " configured",
			groups: [
				[
					{ label: "Add model", onSelect: () => stack.push(addModelPrompt(stack, view, theme, ctx)) },
					{ label: "Models curator", onSelect: () => stack.push(new CuratorScreen(theme, view, ctx, stack, () => stack.requestRender())) },
				],
				work.models.map((entry) => ({
					label: (entry.enabled ? "✓ " : "○ ") + entry.id,
					hint: modelSummaryLine(work, entry.id),
					onSelect: () => stack.push(modelSettingsScreen(stack, view, theme, ctx, entry.id)),
				})),
				[
					{ label: "Provider settings", onSelect: () => stack.push(providerSettingsScreen(stack, view, theme, ctx)) },
					{ label: "Model defaults", onSelect: () => stack.push(modelDefaultsScreen(stack, view, theme, ctx)) },
					{ label: "Exit", onSelect: () => exitProviderView(stack, view, ctx, theme) },
				],
			],
			footer: keyHints(theme, [["↑↓", "navigate"], [keyDisplay("tui.select.confirm"), "select"], [keyDisplay("tui.select.cancel"), "exit"]]),
		};
	}, () => exitProviderView(stack, view, ctx, theme), () => stack.requestRender());
}

function exitProviderView(stack: ScreenStack, view: ViewState, ctx: ExtensionContext, theme: Theme): void {
	if (!view.dirty) {
		stack.pop();
		return;
	}
	stack.push(new MenuScreen(theme, () => ({
		title: view.id,
		subtitle: "Unsaved changes",
		groups: [[
			{ label: "Save and exit", onSelect: () => {
				void saveProviderView(view, ctx);
				stack.pop(2);
			} },
			{ label: "Discard changes", onSelect: () => {
				view.work = clone(view.snapshot);
				view.dirty = false;
				stack.pop(2);
			} },
			{ label: "Cancel", onSelect: () => stack.pop() },
		]],
		footer: keyHints(theme, [["↑↓", "navigate"], [keyDisplay("tui.select.confirm"), "select"], [keyDisplay("tui.select.cancel"), "cancel"]]),
	}), () => stack.pop(), () => stack.requestRender()));
}

async function saveProviderView(view: ViewState, ctx: ExtensionContext): Promise<void> {
	config.providers[view.id] = view.work;
	view.snapshot = clone(view.work);
	await saveConfig();
	registerProvider(view.id);
	void ctx.modelRegistry.refresh({ providers: [view.id], force: true, allowNetwork: true });
}

async function deleteProvider(view: ViewState, ctx: ExtensionContext, stack: ScreenStack): Promise<void> {
	delete config.providers[view.id];
	await saveConfig();
	if (registered.has(view.id)) {
		piApi!.unregisterProvider(view.id);
		registered.delete(view.id);
	}
	stack.pop(2);
}

async function refreshProviders(ctx: ExtensionContext): Promise<void> {
	loadConfig();
	registerAll();
	const ids = Object.keys(config.providers);
	if (ids.length === 0) return;
	const result = await ctx.modelRegistry.refresh({ providers: ids, force: true, allowNetwork: true });
	if (result.aborted) return;
	const errors = [...result.errors.entries()];
	if (errors.length > 0) {
		ctx.ui.notify("Refreshed with " + errors.length + " error" + (errors.length === 1 ? "" : "s") + ": " + errors.map(([, error]) => error.message).join("; "), "warning");
	} else {
		ctx.ui.notify("Refreshed " + ids.length + " provider" + (ids.length === 1 ? "" : "s"), "info");
	}
}
function providerSettingsScreen(stack: ScreenStack, view: ViewState, theme: Theme, ctx: ExtensionContext): Screen {
	return new SettingsScreen(theme, "Provider settings — " + view.id, "Empty values inherit from pi. Delete provider is at the bottom.",
		() => providerSettingsItems(view, theme, stack, ctx, () => stack.requestRender()),
		(id, value) => applyProviderSetting(view, id, value),
		() => stack.pop(),
		() => stack.requestRender());
}

function providerSettingsItems(view: ViewState, theme: Theme, stack: ScreenStack, ctx: ExtensionContext, refresh: () => void): SettingItem[] {
	const p = view.work;
	const text = (id: string, label: string, current: string | undefined, placeholder?: string, validate?: (value: string) => string | undefined): SettingItem => ({
		id,
		label,
		currentValue: id === "apiKey" ? maskKey(current) : current ?? "inherit",
		submenu: (_current, done) => miniInput(theme, label, current ?? "", placeholder, done, refresh, validate),
	});
	const json = (id: string, label: string, current: Record<string, unknown> | undefined): SettingItem => ({
		id,
		label,
		currentValue: current ? truncateToWidth(JSON.stringify(current), 48) : "inherit",
		submenu: (_current, done) => miniJsonInput(theme, label, current ? JSON.stringify(current) : "", done, refresh),
	});
	const items: SettingItem[] = [
		text("name", "Name", p.name, "e.g. Acme AI"),
		text("baseUrl", "Base URL", p.baseUrl, "https://api.example.com/v1", (value) => /^https?:\/\//i.test(value.trim()) ? undefined : "Enter an http(s) URL"),
		{ id: "api", label: "API", currentValue: p.api ?? "auto", values: [...KNOWN_APIS], description: p.api ? undefined : "auto-detected from the base URL" },
		{
			id: "authFrom",
			label: "Auth source",
			currentValue: p.authFrom ?? "own API key",
			values: ["own API key", ...authSourceIds()],
			description: p.authFrom
				? "pi owns it: /login " + p.authFrom + ", oauth, refresh, auth.json"
				: "uses this provider's own API key field",
		},
		text("apiKey", "API key", p.apiKey, "$ENV_VAR, !command, or literal"),
		{ id: "authHeader", label: "Auth header", currentValue: p.authHeader !== false ? "on" : "off", values: ["on", "off"], description: "Send Authorization: Bearer with the resolved key" },
		json("headers", "Headers", p.headers),
		json("compat", "Compatibility", p.compat),
		text("modelsEndpoint", "Models endpoint", p.modelsEndpoint, "empty = auto (" + resolveModelsEndpoint(p) + ")"),
	];
	items.push({
		id: "__save",
		label: "Save changes",
		currentValue: "",
		description: "Persist the config, re-register, and refresh the model list",
		submenu: (_current, done) => miniConfirm(theme, "Save changes?", "Persists the configuration, re-registers the provider, and refreshes its model list.", () => {
			done();
			void saveProviderView(view, ctx);
			stack.pop();
		}, () => done()),
	});
	items.push({
		id: "__delete",
		label: "Delete provider",
		currentValue: "",
		description: "Removes the provider, its models, and the models.json projection",
		submenu: (_current, done) => miniConfirm(theme, "Delete " + view.id + "?", "Removes the provider, its models, and the models.json projection.", () => {
			done();
			void deleteProvider(view, ctx, stack);
		}, () => done()),
	});
	return items;
}

function applyProviderSetting(view: ViewState, id: string, value: string): void {
	const p = view.work;
	switch (id) {
		case "name": p.name = value || undefined; break;
		case "baseUrl": p.baseUrl = value.replace(/\/+$/, ""); break;
		case "api": p.api = !value || value === "auto" ? undefined : value; break;
		case "apiKey": p.apiKey = value || undefined; break;
		case "authHeader": p.authHeader = value === "on"; break;
		// "own API key" is the sentinel for no borrowed auth; empty clears it too.
		case "authFrom": p.authFrom = !value || value === "own API key" ? undefined : value; break;
		case "headers": p.headers = parseJsonObject(value) as Record<string, string> | undefined; break;
		case "compat": p.compat = parseJsonObject(value); break;
		case "modelsEndpoint": p.modelsEndpoint = value || undefined; break;
	}
	view.dirty = true;
}

function modelDefaultsScreen(stack: ScreenStack, view: ViewState, theme: Theme, ctx: ExtensionContext): Screen {
	return new SettingsScreen(theme, "Model defaults — " + view.id, "Applies to every model. Empty values inherit from pi.",
		() => modelDefaultsItems(view, theme, () => stack.requestRender()),
		(id, value) => applyModelDefault(view, id, value),
		() => stack.pop(),
		() => stack.requestRender());
}

function modelDefaultsItems(view: ViewState, theme: Theme, refresh: () => void): SettingItem[] {
	const d = view.work.defaults ?? {};
	const numberItem = (id: string, label: string, current: number | undefined): SettingItem => ({
		id,
		label,
		currentValue: current !== undefined ? String(current) : "inherit",
		submenu: (_current, done) => miniNumberInput(theme, label, current, done, refresh),
	});
	const json = (id: string, label: string, current: Record<string, unknown> | undefined): SettingItem => ({
		id,
		label,
		currentValue: current ? truncateToWidth(JSON.stringify(current), 48) : "inherit",
		submenu: (_current, done) => miniJsonInput(theme, label, current ? JSON.stringify(current) : "", done, refresh),
	});
	return [
		numberItem("contextWindow", "Context window", d.contextWindow),
		numberItem("maxTokens", "Max output tokens", d.maxTokens),
		{ id: "input", label: "Input modalities", currentValue: d.input ? d.input.join("+") : "inherit", values: ["inherit", "text", "text+image"] },
		{ id: "reasoning", label: "Reasoning", currentValue: d.reasoning === undefined ? "inherit" : d.reasoning ? "on" : "off", values: ["inherit", "on", "off"] },
		numberItem("cost.input", "Input cost ($/M)", d.cost?.input),
		numberItem("cost.output", "Output cost ($/M)", d.cost?.output),
		numberItem("cost.cacheRead", "Cache read cost ($/M)", d.cost?.cacheRead),
		numberItem("cost.cacheWrite", "Cache write cost ($/M)", d.cost?.cacheWrite),
		numberItem("promptCache.short", "Prompt cache short (s)", d.promptCache?.short),
		numberItem("promptCache.long", "Prompt cache long (s)", d.promptCache?.long),
		json("thinkingLevelMap", "Thinking-level map", d.thinkingLevelMap),
		json("inputLimits", "Input limits", d.inputLimits),
		json("samplingParams", "Sampling params", d.samplingParams),
	];
}

function applyModelDefault(view: ViewState, id: string, value: string): void {
	let d = view.work.defaults;
	if (!d) {
		d = {};
		view.work.defaults = d;
	}
	applyModelLikeSetting(d, id, value);
	view.dirty = true;
}

function addModelPrompt(stack: ScreenStack, view: ViewState, theme: Theme, ctx: ExtensionContext): Screen {
	return new PromptScreen(theme, "Add model - " + view.id, "Model ID", "exactly as the endpoint lists it", "", (value) => {
		const id = value.trim();
		view.work.models.push({ id, enabled: true });
		view.dirty = true;
		stack.push(modelSettingsScreen(stack, view, theme, ctx, id));
	}, () => stack.pop(), () => stack.requestRender(), (value) => {
		const id = value.trim();
		if (!id) return "Model ID is required";
		if (view.work.models.some((m) => m.id === id)) return "Already configured: " + id;
		return undefined;
	});
}

function modelSettingsScreen(stack: ScreenStack, view: ViewState, theme: Theme, ctx: ExtensionContext, modelId: string): Screen {
	return new SettingsScreen(theme, "Model settings — " + modelId, "Empty values inherit: model defaults > pi catalog > endpoint > inferred.",
		() => modelSettingsItems(view, theme, modelId, ctx, stack, () => stack.requestRender()),
		(id, value) => applyModelSetting(view, modelId, id, value),
		() => stack.pop(),
		() => stack.requestRender());
}

function modelSettingsItems(view: ViewState, theme: Theme, modelId: string, ctx: ExtensionContext, stack: ScreenStack, refresh: () => void): SettingItem[] {
	const p = view.work;
	const entry = p.models.find((m) => m.id === modelId);
	if (!entry) return [];
	const resolved = resolveOne(p, entry);
	const prov = (key: string): string => {
		const source = resolved.provenance[key];
		return source ? layerLabel(source.layer, source.confidence) : "";
	};
	const text = (id: string, label: string, current: string | undefined, placeholder?: string): SettingItem => ({
		id,
		label,
		currentValue: current ?? "inherit",
		description: prov(id),
		submenu: (_current, done) => miniInput(theme, label, current ?? "", placeholder, done, refresh),
	});
	const numberItem = (id: string, label: string, current: number | undefined): SettingItem => ({
		id,
		label,
		currentValue: current !== undefined ? String(current) : "inherit",
		description: prov(id),
		submenu: (_current, done) => miniNumberInput(theme, label, current, done, refresh),
	});
	const json = (id: string, label: string, current: Record<string, unknown> | undefined): SettingItem => ({
		id,
		label,
		currentValue: current ? truncateToWidth(JSON.stringify(current), 48) : "inherit",
		description: prov(id),
		submenu: (_current, done) => miniJsonInput(theme, label, current ? JSON.stringify(current) : "", done, refresh),
	});
	const items: SettingItem[] = [
		{ id: "__id", label: "Model ID", currentValue: entry.id, description: "Immutable — anchors this model's configuration" },
		text("name", "Display name", entry.name, "e.g. Claude Sonnet 4.6"),
		{ id: "enabled", label: "Status", currentValue: entry.enabled ? "enabled" : "disabled", values: ["enabled", "disabled"] },
		text("tags", "Tags", entry.tags?.join(", "), "comma separated"),
		{ id: "input", label: "Input modalities", currentValue: entry.input ? entry.input.join("+") : "inherit", values: ["inherit", "text", "text+image"], description: prov("input") },
		numberItem("contextWindow", "Context window", entry.contextWindow),
		numberItem("maxTokens", "Max output tokens", entry.maxTokens),
		{ id: "reasoning", label: "Reasoning", currentValue: entry.reasoning === undefined ? "inherit" : entry.reasoning ? "on" : "off", values: ["inherit", "on", "off"], description: prov("reasoning") },
		numberItem("cost.input", "Input cost ($/M)", entry.cost?.input),
		numberItem("cost.output", "Output cost ($/M)", entry.cost?.output),
		numberItem("cost.cacheRead", "Cache read cost ($/M)", entry.cost?.cacheRead),
		numberItem("cost.cacheWrite", "Cache write cost ($/M)", entry.cost?.cacheWrite),
		numberItem("promptCache.short", "Prompt cache short (s)", entry.promptCache?.short),
		numberItem("promptCache.long", "Prompt cache long (s)", entry.promptCache?.long),
		json("thinkingLevelMap", "Thinking-level map", entry.thinkingLevelMap),
		{ id: "api", label: "API", currentValue: entry.api ?? "inherit", values: ["inherit", ...KNOWN_APIS.slice(1)], description: prov("api") },
		text("baseUrl", "Base URL", entry.baseUrl, "https://…"),
		json("headers", "Headers", entry.headers),
		json("compat", "Compatibility", entry.compat),
		json("inputLimits", "Input limits", entry.inputLimits),
		json("samplingParams", "Sampling params", entry.samplingParams),
	];
	items.push({
		id: "__save",
		label: "Save changes",
		currentValue: "",
		description: "Persist the config, re-register, and refresh the model list",
		submenu: (_current, done) => miniConfirm(theme, "Save changes?", "Persists the configuration, re-registers the provider, and refreshes its model list.", () => {
			done();
			void saveProviderView(view, ctx);
			stack.pop();
		}, () => done()),
	});
	items.push({
		id: "__delete",
		label: "Delete model",
		currentValue: "",
		description: "Removes the model and its model-specific configuration",
		submenu: (_current, done) => miniConfirm(theme, "Delete " + modelId + "?", "Removes the model and its model-specific configuration.", () => {
			done();
			view.work.models = view.work.models.filter((m) => m.id !== modelId);
			view.dirty = true;
			stack.pop();
		}, () => done()),
	});
	return items;
}

function applyModelSetting(view: ViewState, modelId: string, id: string, value: string): void {
	const entry = view.work.models.find((m) => m.id === modelId);
	if (!entry) return;
	applyModelLikeSetting(entry, id, value);
	view.dirty = true;
}

function applyModelLikeSetting(target: ModelLike, id: string, value: string): void {
	switch (id) {
		case "name": target.name = value || undefined; break;
		case "enabled": break;
		case "tags": target.tags = value ? value.split(",").map((tag) => tag.trim()).filter(Boolean) : undefined; break;
		case "input": target.input = !value || value === "inherit" ? undefined : value === "text+image" ? ["text", "image"] : ["text"]; break;
		case "contextWindow": setNumberField(target, "contextWindow", value); break;
		case "maxTokens": setNumberField(target, "maxTokens", value); break;
		case "reasoning": target.reasoning = !value || value === "inherit" ? undefined : value === "on"; break;
		case "cost.input": setSubNumberField(target, "cost", "input", value); break;
		case "cost.output": setSubNumberField(target, "cost", "output", value); break;
		case "cost.cacheRead": setSubNumberField(target, "cost", "cacheRead", value); break;
		case "cost.cacheWrite": setSubNumberField(target, "cost", "cacheWrite", value); break;
		case "promptCache.short": setSubNumberField(target, "promptCache", "short", value); break;
		case "promptCache.long": setSubNumberField(target, "promptCache", "long", value); break;
		case "thinkingLevelMap": target.thinkingLevelMap = parseJsonMap(value); break;
		case "api": target.api = !value || value === "inherit" ? undefined : value; break;
		case "baseUrl": target.baseUrl = value || undefined; break;
		case "headers": target.headers = parseJsonObject(value) as Record<string, string> | undefined; break;
		case "compat": target.compat = parseJsonObject(value); break;
		case "inputLimits": target.inputLimits = parseJsonObject(value); break;
		case "samplingParams": target.samplingParams = parseJsonObject(value); break;
	}
}

function setNumberField(target: ModelLike, key: "contextWindow" | "maxTokens", value: string): void {
	const trimmed = value.trim();
	const parsed = Number(trimmed);
	target[key] = trimmed !== "" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function setSubNumberField(target: ModelLike, key: "cost" | "promptCache", field: string, value: string): void {
	const trimmed = value.trim();
	const parsed = Number(trimmed);
	const valid = trimmed !== "" && Number.isFinite(parsed) && parsed >= 0;
	const bucket: Record<string, number | undefined> = { ...(target[key] as Record<string, number | undefined> | undefined) };
	if (valid) bucket[field] = parsed;
	else delete bucket[field];
	if (Object.keys(bucket).length === 0) delete target[key];
	else (target as Record<string, unknown>)[key] = bucket;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function parseJsonMap(value: string): Record<string, string | null> | undefined {
	const parsed = parseJsonObject(value);
	if (!parsed) return undefined;
	return Object.fromEntries(Object.entries(parsed).map(([key, entry]) => [key, typeof entry === "string" ? entry : null]));
}
// ============================== add provider wizard ==============================

function addProviderWizard(stack: ScreenStack, ctx: ExtensionContext, theme: Theme): void {
	stack.push(new PromptScreen(theme, "Add provider", "Provider name", "e.g. Acme AI", "", (name) => {
		const base = slugify(name).replace(/:/g, "");
		const conflict = providerIdConflict(base, ctx);
		if (!conflict) {
			wizardBaseUrl(stack, ctx, theme, base, name.trim());
			return;
		}
		const suggestion = suggestProviderId(base, ctx);
		stack.push(new MenuScreen(theme, () => ({
			title: "Id conflict - " + base,
			subtitle: "Already used by " + conflict + ".",
			groups: [[
				{ label: "Rename to " + suggestion, hint: "no conflict", onSelect: () => { stack.pop(); wizardBaseUrl(stack, ctx, theme, suggestion, name.trim()); } },
				{ label: "Use " + base + " anyway", hint: "replaces its model list", danger: true, onSelect: () => { stack.pop(); wizardBaseUrl(stack, ctx, theme, base, name.trim()); } },
				{ label: "Choose another name", onSelect: () => { stack.pop(); } },
			]],
			footer: menuFooter(theme, "select"),
		}), () => stack.pop(), () => stack.requestRender()));
	}, () => stack.pop(), () => stack.requestRender(), (value) => slugify(value) === "provider" ? "Enter a provider name" : undefined));
}

function wizardBaseUrl(stack: ScreenStack, ctx: ExtensionContext, theme: Theme, id: string, label: string): void {
	stack.push(new PromptScreen(theme, "Add provider - " + id, "Base URL", "https://api.example.com/v1", "", (baseUrl) => {
		const base = baseUrl.replace(/\/+$/, "");
		stack.push(apiChoiceScreen(stack, theme, id, detectApi(base), (api) => {
			stack.push(new PromptScreen(theme, "Add provider - " + id, "API key", "$ENV_VAR, !command, or literal - empty to skip", "", (apiKey) => {
				config.providers[id] = {
					id,
					name: label || id,
					baseUrl: base,
					api: api === "auto" ? undefined : api,
					apiKey: apiKey.trim() || undefined,
					authHeader: true,
					models: [],
				};
				void (async () => {
					await saveConfig();
					registerProvider(id);
				})();
				stack.popTo(1);
				stack.push(providerMenuScreen(stack, ctx, theme, id));
			}, () => stack.pop(), () => stack.requestRender()));
		}));
	}, () => stack.pop(), () => stack.requestRender(), (value) => /^https?:\/\//i.test(value.trim()) ? undefined : "Enter an http(s) URL"));
}

function apiChoiceScreen(stack: ScreenStack, theme: Theme, id: string, detected: string, onPick: (api: string) => void): MenuScreen {
	return new MenuScreen(theme, () => ({
		title: "Add provider — " + id,
		subtitle: "API type — detected: " + detected,
		groups: [KNOWN_APIS.map((api) => ({
			label: api === detected ? api + "  (detected)" : api,
			onSelect: () => onPick(api),
		}))],
		footer: keyHints(theme, [["↑↓", "navigate"], [keyDisplay("tui.select.confirm"), "select"], [keyDisplay("tui.select.cancel"), "cancel"]]),
	}), () => stack.pop(), () => stack.requestRender());
}

function modelsJsonProviderIds(): Set<string> {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(modelsJsonPath(), "utf8"));
		const providers = isRecord(parsed) && isRecord(parsed.providers) ? parsed.providers : {};
		return new Set<string>(Object.keys(providers));
	} catch {
		return new Set<string>();
	}
}

/**
 * What a bare id would collide with: our own config, another extension's
 * provider, pi's built-ins, or models.json. Never guessed around - the UI asks.
 */
function providerIdConflict(id: string, ctx: ExtensionContext): string | undefined {
	if (config.providers[id]) return "provider \"" + id + "\" you already added here";
	if (ctx.modelRegistry.getRegisteredProviderIds().includes(id)) return "a provider registered by another extension";
	if (builtinProviderIds().has(id)) return "pi's built-in provider \"" + id + "\" - yours would replace its model list";
	if (modelsJsonProviderIds().has(id)) return "provider \"" + id + "\" defined in models.json";
	return undefined;
}

function suggestProviderId(base: string, ctx: ExtensionContext): string {
	const taken = new Set<string>([
		...Object.keys(config.providers),
		...builtinProviderIds(),
		...modelsJsonProviderIds(),
		...ctx.modelRegistry.getRegisteredProviderIds(),
	]);
	let count = 2;
	while (taken.has(base + "-" + count)) count++;
	return base + "-" + count;
}
// ============================== extension ==============================

export default function cxProvidersExtension(pi: ExtensionAPI): void {
	piApi = pi;
	loadConfig();
	rebuildCatalogFromBuiltin();
	registerAll();

	pi.registerCommand("providers", {
		description: "Manage custom providers and their model catalogs",
		getArgumentCompletions: (prefix) => {
			const ids = Object.keys(config.providers).filter((id) => id.startsWith(prefix));
			return ids.length > 0 ? ids.map((id) => ({ value: id, label: config.providers[id]?.name ?? id })) : null;
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/providers requires interactive mode", "warning");
				return;
			}
			const id = args.trim();
			if (id) {
				if (!config.providers[id]) {
					ctx.ui.notify("Unknown provider: " + id + ". Run /providers to add one.", "warning");
					return;
				}
				await openCustom(ctx, (stack, theme) => providerMenuScreen(stack, ctx, theme, id));
				return;
			}
			await openCustom(ctx, (stack, theme) => hubScreen(stack, ctx, theme));
		},
	});

	pi.on("session_start", (event, ctx) => {
		rebuildCatalog(ctx.modelRegistry.getAll());
		registerAll();
		startWatcher();
	});

	pi.on("session_shutdown", () => {
		stopWatcher();
	});
}