// pi Providers - custom provider manager for pi.
//
//   /providers           hub: add provider, refresh, provider list, exit
//   /providers <id>      provider view: add model, models curator, configured
//                       models, provider settings, model defaults, exit
//
// Provider ids are namespaced (cx-<slug>) so they never collide with built-in
// providers, models.json entries, or other extensions. Models are curated: a new
// provider starts with zero models and only models you add get registered.
// Disabled models stay registered but are hidden from the model picker. The order
// of enabled models decides the startup default model.
//
// Authoring config:  <agent-dir>/cx/providers.json
// Projection:         <agent-dir>/models.json  (cx-* keys only, enabled models only)
//
// Streaming, tools, usage, cost, thinking levels, prompt caching, retries, auth
// storage, /model and /scoped-models all stay pi's. Nothing is reimplemented.

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import { execSync } from "node:child_process";

import { type AnyModel, type Api, type Model, type Provider, type ProviderStreams } from "@earendil-works/pi-ai";
// Lazy API implementations must be imported statically: pi resolves extension imports through
// its own module cache, while a dynamic import() inside the extension would resolve
// relative to this file and fail.
import {
	anthropicMessagesApi,
	azureOpenAIResponsesApi,
	bedrockConverseStreamApi,
	googleGenerativeAIApi,
	googleVertexApi,
	mistralConversationsApi,
	openAICodexResponsesApi,
	openAICompletionsApi,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { getAgentDir, withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, fuzzyFilter, getKeybindings, matchesKey, truncateToWidth, type Keybinding } from "@earendil-works/pi-tui";

// ============================================================================
// Constants
// ============================================================================

const CONFIG_DIR_NAME = "cx";
const CONFIG_FILE_NAME = "providers.json";
const MODELS_JSON_NAME = "models.json";
const ID_PREFIX = "cx-";
const REFRESH_TIMEOUT_MS = 15_000;
const UNSET = "Inherited";

const API_CHOICES = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"azure-openai-responses",
	"openai-codex-responses",
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

// ============================================================================
// Config shapes
// ============================================================================

interface CostFields {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** Model metadata a user may override. Sparse: absent means inherit. */
interface ModelFields {
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	cost?: CostFields;
	promptCache?: { short?: number; long?: number };
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
	inputLimits?: Record<string, unknown>;
	samplingParams?: Record<string, unknown>;
}

interface StoredModel {
	enabled?: boolean;
	tags?: string[];
	api?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	fields?: ModelFields;
}

interface Filters {
	hideDatedVariants?: boolean;
	hideBeta?: boolean;
	minContextWindow?: number;
	exclude?: string[];
}

interface ResponseMap {
	dataPath?: string;
	idKey?: string;
	nameKey?: string;
	ownedByKey?: string;
	contextLengthKeys?: string[];
}

interface DiscoveredModel {
	id: string;
	name?: string;
	ownedBy?: string;
	contextLength?: number;
}

interface Discovery {
	endpoint: string;
	fetchedAt: number;
	error?: string;
	models: DiscoveredModel[];
}

interface StoredProvider {
	name: string;
	baseUrl: string;
	api?: string;
	apiKey?: string;
	authHeader?: boolean;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	modelsEndpoint?: string;
	responseMap?: ResponseMap;
	filters?: Filters;
	defaults?: ModelFields;
	/** Keyed by model id. Insertion order is the enabled order. */
	models: Record<string, StoredModel>;
	discovery?: Discovery;
}

interface ConfigFile {
	version: 1;
	providers: Record<string, StoredProvider>;
}
// ============================================================================
// Utilities
// ============================================================================

function configPath(): string {
	return nodePath.join(getAgentDir(), CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

function modelsJsonPath(): string {
	return nodePath.join(getAgentDir(), MODELS_JSON_NAME);
}

async function writeFileAtomic(file: string, contents: string): Promise<void> {
	await withFileMutationQueue(file, async () => {
		await fsp.mkdir(nodePath.dirname(file), { recursive: true });
		const tmp = file + ".tmp";
		await fsp.writeFile(tmp, contents, "utf8");
		await fsp.rename(tmp, file);
	});
}

function readJson(file: string): any {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return undefined;
	}
}

function slugify(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Provider ids must never contain a colon: model patterns split on the last colon. */
function makeProviderId(seed: string, taken: ReadonlySet<string>): string {
	const base = slugify(seed) || "provider";
	let id = base.startsWith(ID_PREFIX) ? base : ID_PREFIX + base;
	let n = 2;
	while (taken.has(id)) id = base + "-" + n++;
	return id;
}

function prettify(id: string): string {
	const leaf = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
	return leaf.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return Math.round(n / 100_000) / 10 + "M";
	if (n >= 1000) return Math.round(n / 1000) + "k";
	return String(n);
}

const secretCache = new Map<string, string | undefined>();

/** pi secret syntax: dollar NAME, braces NAME, !command, $$ escapes, $! escapes. */
async function resolveSecret(spec: string): Promise<string | undefined> {
	const value = spec.trim();
	if (value.startsWith("!")) {
		if (secretCache.has(value)) return secretCache.get(value);
		let out: string | undefined;
		try {
			out = execSync(value.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
			if (!out) out = undefined;
		} catch {
			out = undefined;
		}
		secretCache.set(value, out);
		return out;
	}
	if (/\$\{|\$[A-Za-z_]/.test(value)) {
		return (
			value
				.replace(/\$\$([\s\S])/g, "$1")
				.replace(/\$!([\s\S])/g, "!$1")
				.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, n: string) => process.env[n] ?? "")
				.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, n: string) => process.env[n] ?? "")
		).trim() || undefined;
	}
	return value || undefined;
}

/** Smart /v1 handling: never produce /v1/v1/models. */
function resolveModelsEndpoint(baseUrl: string, explicit?: string): string {
	const base = baseUrl.trim().replace(/\/+$/, "");
	if (explicit) {
		if (explicit.includes("{baseUrl}")) return explicit.replace("{baseUrl}", base);
		if (/^https?:\/\//i.test(explicit)) return explicit;
		return base + "/" + explicit.replace(/^\/+/, "");
	}
	const hasVersion = /\/v\d+[a-z0-9]*(\/|$)/i.test(base);
	return hasVersion ? base + "/models" : base + "/v1/models";
}

function guessApi(baseUrl: string): string {
	const u = baseUrl.toLowerCase();
	if (u.includes("anthropic")) return "anthropic-messages";
	if (u.includes("openai.azure.com") || u.includes("cognitiveservices.azure.com")) return "azure-openai-responses";
	if (u.includes("generativelanguage.googleapis.com")) return "google-generative-ai";
	if (u.includes("aiplatform.googleapis.com") || u.includes("google-vertex")) return "google-vertex";
	if (u.includes("bedrock") || u.includes("amazonaws.com")) return "bedrock-converse-stream";
	if (u.includes("mistral")) return "mistral-conversations";
	return "openai-completions";
}

function normalizeModelId(id: string): string {
	return id
		.toLowerCase()
		.replace(/^[a-z0-9_-]+\//, "")
		.replace(/[-:]latest\b/g, "")
		.replace(/[-_]\d{4}[-_]?\d{2}[-_]?\d{2}\b/g, "")
		.replace(/[-_]\d{8}\b/g, "")
		.replace(/[-_.](preview|beta|rc\d+|alpha|v\d+(\.\d+)*)\b/g, "")
		.replace(/[:@].*$/, "")
		.replace(/[-_.]+$/, "")
		.trim();
}

const DATE_SUFFIX = /[-_](\d{4}[-_]?\d{2}[-_]?\d{2}|\d{8})\b/;
const BETA_LIKE = /[-_.](preview|beta|rc\d+|alpha|exp)\b/i;
// ============================================================================
// pi catalog oracle (metadata prefill source)
// ============================================================================

const catalogById = new Map<string, Model<Api>>();
const catalogByNormalized = new Map<string, Model<Api>>();

function indexCatalog(models: readonly AnyModel[]): void {
	for (const m of models) {
		const model = m as Model<Api>;
		if (!model || typeof model.id !== "string") continue;
		if (!catalogById.has(model.id)) catalogById.set(model.id, model);
		const n = normalizeModelId(model.id);
		if (n && !catalogByNormalized.has(n)) catalogByNormalized.set(n, model);
	}
}

interface CatalogMatch {
	model: Model<Api>;
	score: number;
}

function matchCatalog(id: string, ownedBy?: string): CatalogMatch | undefined {
	const exact = catalogById.get(id);
	if (exact) return { model: exact, score: 1 };

	const n = normalizeModelId(id);
	const norm = n ? catalogByNormalized.get(n) : undefined;
	if (norm) return { model: norm, score: 0.9 };

	let best: CatalogMatch | undefined;
	const lower = id.toLowerCase();
	for (const m of catalogByNormalized.values()) {
		const cand = m.id.toLowerCase();
		let score = 0;
		if (cand.startsWith(lower) || lower.startsWith(cand)) score = 0.7;
		else if (ownedBy && m.provider.toLowerCase() === ownedBy.toLowerCase() && cand.split("/").pop() === n) score = 0.6;
		if (score && (!best || score > best.score)) best = { model: m, score };
	}
	return best;
}

// ============================================================================
// Layered model resolution
// ============================================================================

const SOURCE_HEURISTIC = "heuristic";
const SOURCE_UPSTREAM = "upstream";
const SOURCE_CATALOG = "pi catalog";
const SOURCE_DEFAULT = "provider default";
const SOURCE_USER = "model override";

interface Resolved {
	model: Model<Api>;
	provenance: Record<string, string>;
}

const OPTIONAL_KEYS = ["promptCache", "thinkingLevelMap", "compat", "inputLimits", "samplingParams"] as const;

function resolveModel(providerId: string, p: StoredProvider, id: string, stored: StoredModel): Resolved {
	const prov: Record<string, string> = {};
	const discovered = p.discovery?.models.find((d) => d.id === id);
	const catalogMatch = matchCatalog(id, discovered?.ownedBy);
	const cm = catalogMatch?.model;
	const out: Record<string, any> = {};

	const take = (key: keyof ModelFields, heuristic: any, upstream: any, catalog: any): void => {
		const user = stored.fields?.[key];
		if (user !== undefined) {
			out[key] = user;
			prov[key] = SOURCE_USER;
			return;
		}
		const dflt = p.defaults?.[key];
		if (dflt !== undefined) {
			out[key] = dflt;
			prov[key] = SOURCE_DEFAULT;
			return;
		}
		if (catalog !== undefined) {
			out[key] = catalog;
			prov[key] = SOURCE_CATALOG;
			return;
		}
		if (upstream !== undefined) {
			out[key] = upstream;
			prov[key] = SOURCE_UPSTREAM;
			return;
		}
		out[key] = heuristic;
		prov[key] = SOURCE_HEURISTIC;
	};

	take("input", ["text"], undefined, cm?.input);
	take("contextWindow", 200000, discovered?.contextLength, cm?.contextWindow);
	take("maxTokens", 8192, undefined, cm?.maxTokens);
	take("reasoning", false, undefined, cm?.reasoning);
	take("cost", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, undefined, cm?.cost);
	take("promptCache", undefined, undefined, cm?.promptCache);
	take("thinkingLevelMap", undefined, undefined, cm?.thinkingLevelMap);
	take("compat", undefined, undefined, p.compat ?? cm?.compat);
	take("inputLimits", undefined, undefined, cm?.inputLimits);
	take("samplingParams", undefined, undefined, cm?.samplingParams);

	const model: Model<Api> = {
		id,
		name:
			(stored.fields as any)?.name !== undefined
				? String((stored.fields as any).name)
				: (cm?.name ?? discovered?.name ?? prettify(id)),
		api: stored.api ?? p.api ?? guessApi(p.baseUrl),
		provider: providerId,
		baseUrl: stored.baseUrl ?? p.baseUrl,
		input: out.input,
		cost: out.cost,
		reasoning: out.reasoning,
		contextWindow: out.contextWindow,
		maxTokens: out.maxTokens,
	};
	const headers = stored.headers ?? p.headers;
	if (headers) model.headers = headers;
	for (const k of OPTIONAL_KEYS) if (out[k] !== undefined) (model as any)[k] = out[k];
	return { model, provenance: prov };
}

function isEnabled(stored: StoredModel | undefined): boolean {
	return stored?.enabled !== false;
}

/** Enabled models first in configured order, then disabled models. */
function buildModels(providerId: string, p: StoredProvider): Model<Api>[] {
	const enabled: Model<Api>[] = [];
	const disabled: Model<Api>[] = [];
	for (const [id, stored] of Object.entries(p.models)) {
		const { model } = resolveModel(providerId, p, id, stored);
		(isEnabled(stored) ? enabled : disabled).push(model);
	}
	return [...enabled, ...disabled];
}

// ============================================================================
// Discovery
// ============================================================================

function extractArray(payload: any, map?: ResponseMap): any[] {
	const path = map?.dataPath;
	if (path !== undefined) return path === "" ? payload : (String(path).split(".").reduce((o, k) => o?.[k], payload) ?? []);
	if (Array.isArray(payload)) return payload;
	for (const key of ["data", "models", "result", "results", "items"]) {
		if (Array.isArray(payload?.[key])) return payload[key];
	}
	return [];
}

async function fetchDiscovery(
	ctx: ExtensionContext,
	providerId: string,
	p: StoredProvider,
	signal?: AbortSignal,
): Promise<Discovery> {
	const endpoint = resolveModelsEndpoint(p.baseUrl, p.modelsEndpoint);
	const base: Discovery = { endpoint, fetchedAt: Date.now(), models: [] };

	const headers: Record<string, string> = { accept: "application/json", ...(p.headers ?? {}) };
	let apiKey = p.apiKey ? await resolveSecret(p.apiKey) : undefined;
	try {
		const auth = await ctx.modelRegistry.getProviderAuth(providerId);
		if (auth) {
			apiKey = apiKey ?? auth.auth.apiKey;
			for (const [k, v] of Object.entries(auth.auth.headers ?? {})) if (v) headers[k] = v;
		}
	} catch {
		/* provider not registered yet or unconfigured */
	}
	if (apiKey && p.authHeader !== false) headers.authorization = "Bearer " + apiKey;

	try {
		const res = await fetch(endpoint, { headers, signal });
		if (!res.ok) return { ...base, error: "HTTP " + res.status + " " + res.statusText };
		const payload: any = await res.json();
		const models: DiscoveredModel[] = [];
		for (const entry of extractArray(payload, p.responseMap)) {
			if (typeof entry === "string") {
				models.push({ id: entry });
				continue;
			}
			if (!entry || typeof entry !== "object") continue;
			const idKey = p.responseMap?.idKey ?? "id";
			const id = entry[idKey] ?? entry.name ?? entry.model;
			if (typeof id !== "string" || !id) continue;
			const nameKey = p.responseMap?.nameKey ?? "name";
			const ownedKey = p.responseMap?.ownedByKey ?? "owned_by";
			let contextLength: number | undefined;
			for (const k of p.responseMap?.contextLengthKeys ?? ["context_length", "max_model_len", "context_window", "max_input_tokens"]) {
				const v = entry[k];
				if (typeof v === "number" && v > 0) {
					contextLength = v;
					break;
				}
			}
			models.push({
				id,
				name: typeof entry[nameKey] === "string" ? entry[nameKey] : undefined,
				ownedBy: typeof entry[ownedKey] === "string" ? entry[ownedKey] : undefined,
				contextLength,
			});
		}
		return { endpoint, fetchedAt: Date.now(), models };
	} catch (err) {
		if ((err as Error)?.name === "AbortError") return { ...base, error: "aborted" };
		return { ...base, error: err instanceof Error ? err.message : String(err) };
	}
}

function filterDiscovered(p: StoredProvider): DiscoveredModel[] {
	const f = p.filters ?? {};
	return (p.discovery?.models ?? []).filter((d) => {
		if (p.models[d.id]) return false;
		if (f.hideDatedVariants && DATE_SUFFIX.test(d.id)) return false;
		if (f.hideBeta && BETA_LIKE.test(d.id)) return false;
		if (f.exclude?.some((re) => new RegExp(re, "i").test(d.id))) return false;
		return true;
	});
}

// ============================================================================
// Provider registration
// ============================================================================

const streamCache = new Map<string, ProviderStreams>();

function requireStreams(apiId: string): ProviderStreams {
	let impl = streamCache.get(apiId);
	if (impl) return impl;
	const factory = API_IMPLS[apiId];
	if (!factory) throw new Error("unsupported api: " + apiId);
	impl = factory();
	streamCache.set(apiId, impl);
	return impl;
}

class ManagedProvider {
	provider: Provider;
	private modelCache: Model<Api>[] = [];

	constructor(
		readonly id: string,
		public cfg: StoredProvider,
	) {
		this.provider = this.build();
	}


	private build(): Provider {
		const self = this;
		const p = this.cfg;

		return {
			id: this.id,
			name: p.name,
			baseUrl: p.baseUrl,
			headers: p.headers,
			auth: {
				apiKey: {
					name: p.name + " API key",
					async login(interaction) {
						const key = await interaction.prompt({ type: "secret", message: "API key for " + p.name });
						return { type: "api_key", key };
					},
					async resolve({ credential }) {
						const key = credential?.key ?? (p.apiKey ? await resolveSecret(p.apiKey) : undefined);
						if (!key) return undefined;
						return {
							auth: { apiKey: key },
							env: credential?.env,
							source: credential?.key ? "auth.json" : "apiKey",
						};
					},
				},
			},
			getModels: () => self.modelCache,
			getAllModels: () => self.modelCache,
			// No refreshModels: discovery is driven by /providers, because pi's catalog
			// refresh skips unconfigured providers and we must work for keyless endpoints.
			filterModels: (models) => models.filter((m) => isEnabled(p.models[m.id])),
			stream: (model, context, options) => requireStreams(model.api).stream(model, context, options as any),
			streamSimple: (model, context, options) => requireStreams(model.api).streamSimple(model, context, options),
		};
	}

	rebuild(): void {
		this.modelCache = buildModels(this.id, this.cfg);
	}

	/** Re-create the provider object after its config object was replaced. */
	rebuildProvider(): void {
		this.provider = this.build();
	}
}

// ============================================================================
// Extension state
// ============================================================================

class Providers {
	config: ConfigFile = { version: 1, providers: {} };
	managed = new Map<string, ManagedProvider>();
	private ctx: ExtensionContext | undefined;
	private watcher: fs.FSWatcher | undefined;
	private reloadTimer: NodeJS.Timeout | undefined;

	constructor(private pi: ExtensionAPI) {}

	/** Register providers during extension load, before startup model selection. */
	boot(): void {
		this.load();
		this.sync();
	}
	start(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.load();
		indexCatalog(ctx.modelRegistry.getAll());
		for (const type of ["image", "classifier"] as const) {
			try {
				indexCatalog(ctx.modelRegistry.getModelsOfType(type));
			} catch {
				/* optional model types */
			}
		}
		this.sync();
		this.watch();
	}

	stop(): void {
		this.watcher?.close();
		this.watcher = undefined;
		if (this.reloadTimer) clearTimeout(this.reloadTimer);
		this.reloadTimer = undefined;
	}

	private watch(): void {
		const file = configPath();
		try {
			fs.mkdirSync(nodePath.dirname(file), { recursive: true });
			if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(this.config, null, 2));
			this.watcher?.close();
			this.watcher = fs.watch(file, () => {
				if (this.reloadTimer) clearTimeout(this.reloadTimer);
				this.reloadTimer = setTimeout(() => {
					if (this.ctx) {
						this.load();
						this.sync();
					}
				}, 250);
			});
		} catch {
			/* watching is a convenience */
		}
	}

	load(): void {
		const raw = readJson(configPath());
		if (raw && typeof raw === "object" && raw.providers) {
			this.config = { version: 1, providers: raw.providers as Record<string, StoredProvider> };
			for (const p of Object.values(this.config.providers)) {
				p.models ??= {};
				p.name ??= p.baseUrl ?? "provider";
			}
		}
	}

	async persist(): Promise<void> {
		await writeFileAtomic(configPath(), JSON.stringify(this.config, null, 2) + "\n");
		this.projectToModelsJson();
	}

	/** Write only our cx-* keys; every other models.json key is preserved. */
	projectToModelsJson(): void {
		const file = modelsJsonPath();
		const raw = readJson(file) ?? {};
		if (typeof raw !== "object" || Array.isArray(raw)) return;
		const providers = (raw.providers ?? {}) as Record<string, any>;
		for (const key of Object.keys(providers)) if (key.startsWith(ID_PREFIX)) delete providers[key];
		for (const [id, mp] of this.managed) {
			const p = mp.cfg;
			const entry: Record<string, any> = { baseUrl: p.baseUrl };
			if (p.name) entry.name = p.name;
			if (p.api) entry.api = p.api;
			if (p.apiKey) entry.apiKey = p.apiKey;
			if (p.authHeader !== undefined) entry.authHeader = p.authHeader;
			if (p.headers) entry.headers = p.headers;
			if (p.compat) entry.compat = p.compat;
			const models = buildModels(id, p).filter((m) => isEnabled(p.models[m.id]));
			if (models.length) {
				entry.models = models.map((m) => {
					const out: Record<string, any> = {
						id: m.id,
						name: m.name,
						input: m.input,
						cost: m.cost,
						reasoning: m.reasoning,
						contextWindow: m.contextWindow,
						maxTokens: m.maxTokens,
					};
					for (const k of ["api", "baseUrl", "promptCache", "thinkingLevelMap", "compat", "inputLimits", "samplingParams", "headers"] as const) {
						if ((m as any)[k] !== undefined) out[k] = (m as any)[k];
					}
					return out;
				});
			}
			providers[id] = entry;
		}
		raw.providers = providers;
		try {
			const tmp = file + ".tmp";
			fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + "\n", "utf8");
			fs.renameSync(tmp, file);
		} catch {
			/* projection is best effort */
		}
	}

	/** Register and unregister so the registry matches config exactly. */
	sync(): void {
		for (const [id, mp] of [...this.managed]) {
			if (!this.config.providers[id]) {
				this.pi.unregisterProvider(id);
				this.managed.delete(id);
			}
		}
		for (const [id, cfg] of Object.entries(this.config.providers)) {
			if (!cfg.baseUrl) continue;
			let mp = this.managed.get(id);
			if (!mp) {
				mp = new ManagedProvider(id, cfg);
				this.managed.set(id, mp);
			} else {
				mp.cfg = cfg;
				mp.rebuildProvider();
			}
			mp.rebuild();
			this.pi.unregisterProvider(id);
			this.pi.registerProvider(mp.provider);
		}
		this.projectToModelsJson();
	}

	/** Fetch each provider's model list, then rebuild and persist. */
	async refreshAll(ids?: string[]): Promise<Discovery[]> {
		const ctx = this.ctx;
		const results: Discovery[] = [];
		for (const id of ids ?? [...this.managed.keys()]) {
			const cfg = this.config.providers[id];
			if (!ctx || !cfg) {
				continue;
			}
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
			let discovery: Discovery;
			try {
				discovery = await fetchDiscovery(ctx, id, cfg, controller.signal);
			} catch (err) {
				discovery = {
					endpoint: resolveModelsEndpoint(cfg.baseUrl, cfg.modelsEndpoint),
					fetchedAt: Date.now(),
					error: err instanceof Error ? err.message : String(err),
					models: [],
				};
			} finally {
				clearTimeout(timer);
			}
			if (!discovery.error) {
				cfg.discovery = discovery;
				this.managed.get(id)?.rebuild();
			}
			else {
				cfg.discovery = { ...cfg.discovery, endpoint: discovery.endpoint, fetchedAt: discovery.fetchedAt, error: discovery.error };
			}
			results.push(discovery);
		}
		this.sync();
		await this.persist();
		return results;
	}

	takenIds(): Set<string> {
		const taken = new Set<string>(Object.keys(this.config.providers));
		if (this.ctx) {
			for (const m of this.ctx.modelRegistry.getAll()) taken.add(m.provider);
			for (const type of ["image", "classifier"] as const) {
				try {
					for (const m of this.ctx.modelRegistry.getModelsOfType(type)) taken.add(m.provider);
				} catch {
					/* optional model types */
				}
			}
			for (const id of this.ctx.modelRegistry.getRegisteredProviderIds()) taken.add(id);
		}
		return taken;
	}

	findProvider(arg: string): string | undefined {
		const keys = Object.keys(this.config.providers);
		const needle = arg.trim();
		if (this.config.providers[needle]) return needle;
		const lower = needle.toLowerCase();
		const exact = keys.find((k) => k.toLowerCase() === lower);
		if (exact) return exact;
		const starts = keys.find((k) => k.toLowerCase().startsWith(lower));
		if (starts) return starts;
		return keys.find((k) => k.toLowerCase().includes(lower));
	}

	modelCounts(id: string): { enabled: number; disabled: number; notAdded: number } {
		const p = this.config.providers[id];
		if (!p) return { enabled: 0, disabled: 0, notAdded: 0 };
		const entries = Object.values(p.models);
		return {
			enabled: entries.filter((m) => isEnabled(m)).length,
			disabled: entries.filter((m) => !isEnabled(m)).length,
			notAdded: filterDiscovered(p).length,
		};
	}
}

// ============================================================================
// UI: views
// ============================================================================

function keyText(id: Keybinding): string {
	return getKeybindings()
		.getKeys(id)
		.map((k) =>
			k
				.split("+")
				.map((part) => {
					const shown = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
					return shown.charAt(0).toUpperCase() + shown.slice(1);
				})
				.join("+"),
		)
		.join("/");
}

function hint(id: Keybinding, label: string): string {
	return keyText(id) + " " + label;
}

function modelSearchText(m: Model<Api>): string {
	const name = m.name ? " " + m.name : "";
	return m.id + " " + m.provider + " " + m.provider + "/" + m.id + " " + m.provider + " " + m.id + name;
}

type Status = { text: string; kind: "muted" | "success" | "warning" };

interface View {
	title: string;
	subtitle?: string;
	body(width: number): string[];
	handleInput?(data: string): void;
	setFocused?(focused: boolean): void;
	hints?(): string;
	/** Rendered above the body, like the scoped-models search field. */
	searchInput?: Input;
	/** Rendered below the body, above the hints. */
	status?(): Status | undefined;
}

type MenuRow = { kind: "spacer" } | { kind: "hint"; text: string } | { kind: "action"; label: string; detail?: string; action: string };

class MenuView implements View {
	index = 0;

	constructor(
		public title: string,
		public subtitle: string | undefined,
		public rows: MenuRow[],
		private theme: any,
		private onSelect: (action: string) => void,
		private onExit: () => void,
	) {
		this.move(1);
	}

	private selectable(): number[] {
		return this.rows.map((r, i) => (r.kind === "action" ? i : -1)).filter((i) => i >= 0);
	}

	private move(dir: number): void {
		const sel = this.selectable();
		if (!sel.length) return;
		let pos = sel.indexOf(this.index);
		if (pos < 0) {
			this.index = dir > 0 ? sel[0] : sel[sel.length - 1];
			return;
		}
		this.index = sel[(pos + dir + sel.length) % sel.length];
	}

	body(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		for (let i = 0; i < this.rows.length; i++) {
			const row = this.rows[i];
			if (row.kind === "spacer") {
				lines.push("");
				continue;
			}
			if (row.kind === "hint") {
				lines.push(th.fg("muted", "  " + row.text));
				continue;
			}
			const selected = i === this.index;
			const cursor = selected ? th.fg("accent", "→ ") : "  ";
			const label = th.fg(selected ? "accent" : "text", row.label);
			const detail = row.detail ? " " + th.fg("muted", row.detail) : "";
			lines.push(truncateToWidth(cursor + label + detail, width));
		}
		return lines;
	}

	hints(): string {
		return [hint("tui.select.confirm", "select"), hint("tui.select.cancel", "exit")].join("  ·  ");
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) { this.move(-1); return; }
		if (kb.matches(data, "tui.select.down")) { this.move(1); return; }
		if (kb.matches(data, "tui.select.confirm")) {
			const row = this.rows[this.index];
			if (row && row.kind === "action") this.onSelect(row.action);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) this.onExit();
	}
}

// ---- field editor ----------------------------------------------------------

type FieldKind = "text" | "number" | "bool" | "enum" | "json" | "tags";

interface Field {
	id: string;
	label: string;
	kind: FieldKind;
	options?: readonly string[];
	/** True when an empty value means inherit rather than unset-means-nothing. */
	optional?: boolean;
	/** Shown instead of the inherited label when the value is empty and not optional. */
	placeholder?: string;
	hint?: string;
}

class FieldView implements View {
	index = 0;
	dirty = false;
	private maxVisible = 14;

	constructor(
		public title: string,
		public subtitle: string | undefined,
		public fields: Field[],
		public values: Record<string, any>,
		public actions: string[],
		private theme: any,
		private edit: (field: Field) => Promise<void>,
		private onAction: (action: string) => void,
		private onSave: () => Promise<void>,
		private onExit: () => void,
	) {}

	private display(f: Field): string {
		const v = this.values[f.id];
		if (f.kind === "bool") return v === undefined ? (f.placeholder ?? UNSET) : v ? "yes" : "no";
		if (v === undefined || v === "") return f.placeholder ?? UNSET;
		if (f.kind === "json" || Array.isArray(v)) {
			const text = JSON.stringify(v);
			return text.length > 40 ? text.slice(0, 39) + "…" : text;
		}
		return String(v);
	}

	body(width: number): string[] {
		const th = this.theme;
		const n = this.fields.length;
		const total = n + 2 + this.actions.length;
		const size = Math.min(this.maxVisible, Math.max(4, total));
		const start = Math.max(0, Math.min(this.index - Math.floor(size / 2), total - size));
		const end = Math.min(start + size, total);
		const lines: string[] = [];

		const row = (cursor: string, label: string, value: string) => {
			const gap = Math.max(1, width - 2 - label.length - value.length - 2);
			lines.push(truncateToWidth(cursor + label + " ".repeat(gap) + value, width));
		};

		for (let i = start; i < end; i++) {
			const selected = i === this.index;
			const cursor = selected ? th.fg("accent", "→ ") : "  ";
			if (i < n) {
				const f = this.fields[i];
				const value = this.display(f);
				row(cursor, th.fg(selected ? "accent" : "text", f.label), value === UNSET ? th.fg("dim", value) : th.fg("muted", value));
				if (selected && f.hint) lines.push(truncateToWidth("    " + th.fg("dim", f.hint), width));
				continue;
			}
			if (i === n) {
				row(cursor, th.fg(this.dirty ? "warning" : "text", this.dirty ? "● Save" : "○ Save"), this.dirty ? th.fg("warning", "unsaved") : "");
				continue;
			}
			if (i === n + 1 + this.actions.length) {
				row(cursor, th.fg(selected ? "accent" : "text", "Cancel"), "");
				continue;
			}
			row(cursor, th.fg(selected ? "error" : "text", this.actions[i - n - 1]), "");
		}
		if (start > 0 || end < total) lines.push(th.fg("muted", "  (" + (this.index + 1) + "/" + total + ")"));
		return lines;
	}

	hints(): string {
		return [
			hint("tui.select.confirm", "edit"),
			hint("app.models.save", "save"),
			hint("tui.select.cancel", "cancel"),
		].join("  ·  ");
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const n = this.fields.length;
		const total = n + 2 + this.actions.length;
		if (kb.matches(data, "tui.select.up")) { this.index = (this.index - 1 + total) % total; return; }
		if (kb.matches(data, "tui.select.down")) { this.index = (this.index + 1) % total; return; }
		if (kb.matches(data, "app.models.save")) { void this.onSave(); return; }
		if (kb.matches(data, "tui.select.cancel")) { this.onExit(); return; }
		if (!kb.matches(data, "tui.select.confirm")) return;
		if (this.index === n) {
			void this.onSave();
			return;
		}
		if (this.index === n + 1 + this.actions.length) {
			this.onExit();
			return;
		}
		if (this.index > n) {
			this.onAction(this.actions[this.index - n - 1]);
			return;
		}
		const field = this.fields[this.index];
		if (field.kind === "bool") {
			const v = this.values[field.id];
			this.values[field.id] = v === undefined ? true : v === true ? false : undefined;
			this.dirty = true;
			return;
		}
		if (field.kind === "enum") {
			const opts = [...(field.options ?? [])];
			if (field.optional) opts.unshift(UNSET);
			const current = this.values[field.id];
			const at = current === undefined ? (field.optional ? 0 : -1) : opts.indexOf(String(current));
			const next = opts[(at + 1) % opts.length];
			this.values[field.id] = next === UNSET ? undefined : next;
			this.dirty = true;
			return;
		}
		void this.edit(field);
	}
}

// ---- models curator (port of pi's scoped-models dialog) --------------------

type CuratorState = "enabled" | "disabled" | "unadded";

interface CuratorRow {
	id: string;
	state: CuratorState;
	summary?: string;
	available: boolean;
}

function summarizeUnadded(cfg: StoredProvider, id: string): string {
	const discovered = cfg.discovery?.models.find((m) => m.id === id);
	const { model, provenance } = resolveModel("", cfg, id, { enabled: false });
	const match = matchCatalog(id, discovered?.ownedBy);
	const parts: string[] = [];
	if (model.contextWindow) parts.push(fmtTokens(model.contextWindow));
	if (model.cost && (model.cost.input || model.cost.output)) parts.push(`$${model.cost.input}/$${model.cost.output}`);
	const inferred = Object.values(provenance).some((s) => s === SOURCE_CATALOG || s === SOURCE_UPSTREAM);
	parts.push(inferred ? "inferred " + (match?.score ?? 0.7).toFixed(2) : "assumed");
	return parts.join(" · ");
}

class CuratorView implements View {
	title = "Model Configuration";
	subtitle: string;
	searchInput = new Input();
	index = 0;
	dirty = false;
	private rows: CuratorRow[] = [];
	private visible: CuratorRow[] = [];
	private state = new Map<string, CuratorState>();
	private order: string[] = [];
	private modelFor = new Map<string, Model<Api>>();
	private maxVisible = 8;
	private statusLine: Status | undefined;

	constructor(
		private providers: Providers,
		private theme: any,
		private providerId: string,
		public cfg: StoredProvider,
		private confirm: (title: string, message: string) => Promise<boolean>,
		private rerender: () => void,
		private save: () => Promise<void>,
		private exit: (discard: boolean) => void,
	) {
		this.subtitle = providerId + " · changes apply on save";
		this.reloadRows();
	}

	setFocused(focused: boolean): void {
		this.searchInput.focused = focused;
	}

	reloadRows(): void {
		this.state.clear();
		this.order = [];
		this.modelFor.clear();
		for (const [id, stored] of Object.entries(this.cfg.models)) {
			this.state.set(id, isEnabled(stored) ? "enabled" : "disabled");
			this.order.push(id);
			this.modelFor.set(id, resolveModel(this.providerId, this.cfg, id, stored).model);
		}
		for (const d of filterDiscovered(this.cfg)) {
			if (!this.state.has(d.id)) {
				this.state.set(d.id, "unadded");
				this.order.push(d.id);
			}
		}
		const confirmed = new Set((this.cfg.discovery?.models ?? []).map((d) => d.id));
		const hasCatalog = confirmed.size > 0;
		this.rows = this.order.map((id) => {
			const state = this.state.get(id)!;
			return {
				id,
				state,
				available: state === "unadded" ? true : !hasCatalog || confirmed.has(id),
				summary: state === "unadded" ? summarizeUnadded(this.cfg, id) : undefined,
			};
		});
		this.applyFilter();
	}

	private applyFilter(): void {
		const query = this.searchInput.getValue();
		if (!query) {
			this.visible = [...this.rows];
			this.index = 0;
			return;
		}
		this.visible = fuzzyFilter(this.rows, query, (r) => {
			const m = this.modelFor.get(r.id);
			return m ? modelSearchText(m) : r.id + " " + this.providerId + " " + r.id;
		});
		this.index = Math.min(this.index, Math.max(0, this.visible.length - 1));
	}

	private current(): CuratorRow | undefined {
		return this.visible[this.index];
	}

	private counts(): [number, number, number] {
		let e = 0;
		let d = 0;
		let u = 0;
		for (const r of this.rows) {
			if (r.state === "enabled") e++;
			else if (r.state === "disabled") d++;
			else u++;
		}
		return [e, d, u];
	}

	body(width: number): string[] {
		const th = this.theme;
		const lines: string[] = [];
		const [e, d, u] = this.counts();
		const total = this.visible.length;
		const size = Math.min(this.maxVisible, Math.max(4, total));
		const start = Math.max(0, Math.min(this.index - Math.floor(size / 2), total - size));
		const end = Math.min(start + size, total);
		let lastSection: CuratorState | "" = "";

		for (let i = start; i < end; i++) {
			const row = this.visible[i];
			if (row.state !== lastSection) {
				if (lastSection !== "") lines.push("");
				const label = row.state === "enabled" ? e + " enabled" : row.state === "disabled" ? d + " disabled" : u + " not added";
				lines.push(th.fg("borderMuted", "─".repeat(3)) + " " + th.fg("muted", label));
				lastSection = row.state;
			}
			const selected = i === this.index;
			const cursor = selected ? th.fg("accent", "→ ") : "  ";
			const tick =
				row.state === "enabled" ? th.fg("accent", "✓ ") : row.state === "disabled" ? th.fg("dim", "✓ ") : "  ";
			const label = row.available ? row.id : th.strikethrough(row.id);
			const badge =
				row.state === "unadded"
					? ""
					: row.available
						? th.fg("muted", " [" + this.providerId + "]")
						: th.fg("dim", " [unavailable]");
			const text = selected ? th.fg("accent", label) : label;
			const summary = row.summary ? th.fg("dim", " · " + row.summary) : "";
			lines.push(truncateToWidth(cursor + tick + text + badge + summary, width));
		}
		if (total === 0) lines.push(th.fg("muted", "  No matching models"));
		if (start > 0 || end < total) lines.push(th.fg("muted", "  (" + (this.index + 1) + "/" + total + ")"));
		const sel = this.current();
		if (sel) {
			lines.push("");
			const m = this.modelFor.get(sel.id);
			lines.push(th.fg("muted", "  Model Name: " + (m?.name ?? "not added yet")));
			if (sel.summary) lines.push(th.fg("dim", "  " + sel.summary));
		}
		return lines;
	}

	hints(): string {
		const [e, d, u] = this.counts();
		return [
			hint("tui.select.confirm", "toggle"),
			hint("app.models.enableAll", "add all"),
			hint("app.models.clearAll", "clear"),
			keyText("app.models.reorderUp") + "/" + keyText("app.models.reorderDown") + " reorder",
			hint("app.models.save", "save"),
			(e + d + u) + " models · " + (e + d) + " in provider · " + u + " not added" + (this.dirty ? " · unsaved" : ""),
		].join("  ·  ");
	}

	status(): Status | undefined {
		return this.statusLine;
	}

	private markChanged(): void {
		this.dirty = true;
		for (const mp of this.providers.managed.values()) mp.rebuild();
		this.providers.sync();
		this.rerender();
	}

	private cycle(row: CuratorRow): void {
		const cfg = this.cfg;
		if (row.state === "unadded") {
			cfg.models[row.id] = { enabled: true };
		} else if (row.state === "enabled") {
			cfg.models[row.id]!.enabled = false;
		} else {
			cfg.models[row.id]!.enabled = true;
		}
		this.state.set(row.id, isEnabled(cfg.models[row.id]) ? "enabled" : "disabled");
		row.state = this.state.get(row.id)!;
		row.available = row.state === "unadded" ? true : row.available;
		this.markChanged();
	}

	private async removeRow(row: CuratorRow): Promise<void> {
		if (row.state === "unadded") {
			this.state.delete(row.id);
			this.rows = this.rows.filter((r) => r.id !== row.id);
			this.applyFilter();
			this.rerender();
			return;
		}
		const hasConfig = Object.keys(this.cfg.models[row.id]?.fields ?? {}).length > 0 || Boolean(this.cfg.models[row.id]?.tags?.length);
		const ok = await this.confirm("Remove model", "Remove " + row.id + " from " + this.providerId + "?" + (hasConfig ? "\n\nIts model-specific configuration will be deleted." : ""));
		if (!ok) return;
		delete this.cfg.models[row.id];
		this.state.delete(row.id);
		this.order = this.order.filter((id) => id !== row.id);
		this.markChanged();
		this.reloadRows();
	}

	private reorder(row: CuratorRow, delta: number): void {
		if (row.state !== "enabled") return;
		const cfg = this.cfg;
		const all = Object.keys(cfg.models);
		const enabled = all.filter((id) => isEnabled(cfg.models[id]));
		const disabled = all.filter((id) => !isEnabled(cfg.models[id]));
		const at = enabled.indexOf(row.id);
		const to = at + delta;
		if (at < 0 || to < 0 || to >= enabled.length) return;
		[enabled[at], enabled[to]] = [enabled[to], enabled[at]];
		const next: Record<string, StoredModel> = {};
		for (const id of [...enabled, ...disabled]) next[id] = cfg.models[id];
		cfg.models = next;
		this.markChanged();
		this.reloadRows();
		this.index = Math.max(0, this.visible.findIndex((r) => r.id === row.id));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const row = this.current();

		if (kb.matches(data, "tui.select.up")) {
			if (this.visible.length) this.index = (this.index - 1 + this.visible.length) % this.visible.length;
			this.rerender();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.visible.length) this.index = (this.index + 1) % this.visible.length;
			this.rerender();
			return;
		}

		if (kb.matches(data, "tui.select.confirm") || data === " ") {
			if (row) this.cycle(row);
			return;
		}

		if (kb.matches(data, "app.models.enableAll")) {
			const targets = this.searchInput.getValue() ? this.visible.map((r) => r.id) : this.rows.map((r) => r.id);
			for (const id of targets) this.cfg.models[id] = { ...(this.cfg.models[id] ?? {}), enabled: true };
			this.markChanged();
			this.reloadRows();
			return;
		}

		if (kb.matches(data, "app.models.clearAll")) {
			void this.clearAll();
			return;
		}

		if (kb.matches(data, "app.models.reorderUp") && row) { this.reorder(row, -1); return; }
		if (kb.matches(data, "app.models.reorderDown") && row) { this.reorder(row, 1); return; }
		if ((matchesKey(data, Key.ctrl("d")) || data === "\x7f") && row) {
			void this.removeRow(row);
			return;
		}

		if (kb.matches(data, "app.models.save")) {
			this.statusLine = { text: "Saving…", kind: "muted" };
			this.rerender();
			void this.save().then(() => {
				this.dirty = false;
				this.rerender();
			});
			return;
		}

		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.applyFilter();
			} else {
				this.exit(true);
			}
			this.rerender();
			return;
		}

		if (kb.matches(data, "tui.select.cancel")) {
			this.exit(true);
			return;
		}

		this.searchInput.handleInput(data);
		this.applyFilter();
		this.rerender();
	}

	private async clearAll(): Promise<void> {
		const targets = (this.searchInput.getValue() ? this.visible : this.rows)
			.filter((r) => r.state !== "unadded")
			.map((r) => r.id);
		if (!targets.length) return;
		const ok = await this.confirm("Clear models", "Remove " + targets.length + " model(s) from this provider? Their model-specific configuration will be deleted.");
		if (!ok) return;
		for (const id of targets) delete this.cfg.models[id];
		this.markChanged();
		this.reloadRows();
	}

	/** Fetch the model list, then re-render with fresh candidates. */
	async refresh(): Promise<void> {
		this.statusLine = { text: "Refreshing model list…", kind: "muted" };
		this.rerender();
		try {
			await this.providers.refreshAll([this.providerId]);
		} catch (err) {
			this.statusLine = { text: "Refresh failed: " + (err instanceof Error ? err.message : String(err)), kind: "warning" };
			this.rerender();
			return;
		}
		this.cfg = this.providers.config.providers[this.providerId] ?? this.cfg;
		const d = this.cfg.discovery;
		if (d?.error) {
			this.statusLine = { text: "Fetch failed: " + d.error, kind: "warning" };
		} else {
			const total = d?.models.length ?? 0;
			const configured = Object.keys(this.cfg.models).length;
			this.statusLine = configured
				? { text: "Fetched " + total + " models · " + configured + " in provider", kind: "success" }
				: { text: "Fetched " + total + " models · none added yet", kind: "warning" };
		}
		this.reloadRows();
		this.rerender();
	}
}

// ============================================================================
// Screen stack
// ============================================================================

class Screen {
	private views: View[] = [];

	constructor(
		public providers: Providers,
		public ctx: ExtensionContext,
		public theme: any,
		public tui: any,
		private done: () => void,
	) {
		this.views.push(hubView(this));
	}

	rerender(): void {
		this.tui.requestRender();
	}

	get top(): View | undefined {
		return this.views[this.views.length - 1];
	}

	push(view: View): void {
		this.views.push(view);
		this.rerender();
	}

	replace(view: View): void {
		if (this.views.length) this.views[this.views.length - 1] = view;
		else this.views.push(view);
		this.rerender();
	}

	pop(): void {
		if (this.views.length > 1) this.views.pop();
		this.rerender();
	}

	reset(): void {
		this.views = [hubView(this)];
		this.rerender();
	}

	exitOrBack(): void {
		if (this.views.length > 1) {
			this.views.pop();
			this.rerender();
		} else {
			this.done();
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const view = this.top;
		const bar = th.fg("border", "─".repeat(Math.max(1, width)));
		if (!view) return [bar, "", "  " + th.fg("dim", "no view"), "", bar];
		const inner = width - 2;
		const lines: string[] = [bar, ""];
		lines.push(truncateToWidth(" " + th.fg("accent", th.bold(view.title)), width));
		if (view.subtitle) lines.push(truncateToWidth(" " + th.fg("muted", view.subtitle), width));
		if (view.searchInput) {
			lines.push("");
			for (const l of view.searchInput.render(inner)) lines.push(" " + l);
		}
		lines.push("");
		for (const l of view.body(inner)) lines.push(" " + l);
		lines.push("");
		const status = view.status?.();
		if (status) lines.push(" " + th.fg(status.kind, status.text));
		if (view.hints?.()) lines.push(truncateToWidth(" " + th.fg("dim", view.hints()!), width));
		lines.push(bar);
		return lines;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		this.top?.handleInput?.(data);
		this.rerender();
	}

	setFocused(focused: boolean): void {
		this.top?.setFocused?.(focused);
	}
}

// ============================================================================
// Screens
// ============================================================================

function hubView(screen: Screen): MenuView {
	const providers = screen.providers;
	const rows: MenuRow[] = [
		{ kind: "action", label: "Add provider", action: "add" },
		{ kind: "action", label: "Refresh providers", action: "refresh" },
		{ kind: "spacer" },
	];
	for (const id of Object.keys(providers.config.providers)) {
		const p = providers.config.providers[id];
		const c = providers.modelCounts(id);
		const bits: string[] = [];
		bits.push(c.enabled + " enabled");
		if (c.disabled) bits.push(c.disabled + " disabled");
		if (c.notAdded) bits.push(c.notAdded + " not added");
		if (p.apiKey) bits.push(p.apiKey);
		else if (p.discovery) bits.push("no key");
		rows.push({
			kind: "action",
			label: p.name || id,
			detail: id + "  " + bits.join(" · "),
			action: "provider:" + id,
		});
	}
	if (Object.keys(providers.config.providers).length === 0) {
		rows.push({ kind: "hint", text: "no custom providers yet" });
	}
	rows.push({ kind: "spacer" });
	rows.push({ kind: "action", label: "Exit", action: "exit" });
	return new MenuView("Providers", "Add, curate and configure custom providers", rows, screen.theme, (action) => void onHubAction(screen, action), () => screen.exitOrBack());
}

async function onHubAction(screen: Screen, action: string): Promise<void> {
	const providers = screen.providers;
	if (action === "exit") {
		screen.exitOrBack();
		return;
	}
	if (action === "add") {
		await addProviderFlow(screen);
		return;
	}
	if (action === "refresh") {
		await providers.refreshAll();
		screen.replace(hubView(screen));
		return;
	}
	if (action.startsWith("provider:")) {
		screen.push(providerView(screen, action.slice("provider:".length)));
	}
}

async function addProviderFlow(screen: Screen): Promise<void> {
	const { ctx } = screen;
	const providers = screen.providers;
	const name = (await ctx.ui.input("Provider name", "Acme AI")).trim();
	if (!name) return;
	const baseUrlInput = (await ctx.ui.input("Base URL", "https://api.acme.dev/v1")).trim();
	if (!baseUrlInput) return;
	const baseUrl = /^https?:\/\//i.test(baseUrlInput) ? baseUrlInput : "https://" + baseUrlInput;
	const apiOptions = [...API_CHOICES, "auto-detect"];
	const apiChoice = await ctx.ui.select("API type", apiOptions);
	const apiKey = (await ctx.ui.input("API key (optional)", "$ACME_API_KEY — literal, $ENV, or !command")).trim();
	const id = makeProviderId(name, providers.takenIds());
	providers.config.providers[id] = {
		name,
		baseUrl,
		api: !apiChoice || apiChoice === "auto-detect" ? undefined : apiChoice,
		apiKey: apiKey || undefined,
		models: {},
	};
	providers.sync();
	await providers.refreshAll([id]);
	await providers.persist();
	screen.replace(hubView(screen));
	screen.push(providerView(screen, id));
}

function providerView(screen: Screen, id: string): MenuView {
	const p = screen.providers.config.providers[id];
	const rows: MenuRow[] = [
		{ kind: "action", label: "Add model", detail: "manually add a model id", action: "add-model" },
		{ kind: "action", label: "Models curator", detail: "pick models from the model list", action: "curator" },
		{ kind: "spacer" },
	];
	for (const [modelId, stored] of Object.entries(p.models)) {
		const state = isEnabled(stored) ? "enabled" : "disabled";
		const resolved = resolveModel(id, p, modelId, stored).model;
		const bits: string[] = [state, fmtTokens(resolved.contextWindow)];
		if (resolved.cost && (resolved.cost.input || resolved.cost.output)) bits.push(`$${resolved.cost.input}/$${resolved.cost.output}`);
		rows.push({
			kind: "action",
			label: modelId,
			detail: bits.join(" · "),
			action: "model:" + modelId,
		});
	}
	if (Object.keys(p.models).length === 0) rows.push({ kind: "hint", text: "no models configured yet" });
	rows.push({ kind: "spacer" });
	rows.push({ kind: "action", label: "Provider settings", action: "provider-settings" },
		{ kind: "action", label: "Model defaults", detail: "inherited by every model", action: "model-defaults" });
	rows.push({ kind: "spacer" });
	rows.push({ kind: "action", label: "Exit", action: "exit" });
	return new MenuView(
		p.name || id,
		id + "  ·  " + resolveModelsEndpoint(p.baseUrl, p.modelsEndpoint),
		rows,
		screen.theme,
		(action) => void onProviderAction(screen, id, action),
		() => screen.exitOrBack(),
	);
}

async function onProviderAction(screen: Screen, id: string, action: string): Promise<void> {
	if (action === "exit") {
		screen.exitOrBack();
		return;
	}
	if (action === "curator") {
		screen.push(curatorView(screen, id));
		return;
	}
	if (action === "add-model") {
		screen.push(modelEditView(screen, id, undefined));
		return;
	}
	if (action.startsWith("model:")) {
		screen.push(modelEditView(screen, id, action.slice("model:".length)));
		return;
	}
	if (action === "provider-settings") {
		screen.push(providerSettingsView(screen, id));
		return;
	}
	if (action === "model-defaults") {
		screen.push(modelDefaultsView(screen, id));
	}
}

function curatorView(screen: Screen, id: string): CuratorView {
	const p = screen.providers.config.providers[id];
	const view = new CuratorView(
		screen.providers,
		screen.theme,
		id,
		p,
		(title, message) => screen.ctx.ui.confirm(title, message),
		() => screen.rerender(),
		async () => {
			await screen.providers.persist();
			screen.ctx.ui.notify("Saved " + id, "info");
		},
		(discard) => {
			if (discard && view.dirty) {
				screen.providers.load();
				screen.providers.sync();
			}
			screen.pop();
		},
	);
	void view.refresh();
	return view;
}

function getPath(obj: any, path: string): any {
	return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

function setPath(obj: any, path: string, value: any): void {
	const keys = path.split(".");
	let cur = obj;
	for (let i = 0; i < keys.length - 1; i++) {
		if (typeof cur[keys[i]] !== "object" || cur[keys[i]] === null) cur[keys[i]] = {};
		cur = cur[keys[i]];
	}
	const last = keys[keys.length - 1];
	if (value === undefined) delete cur[last];
	else cur[last] = value;
}

async function editFieldValue(ctx: ExtensionContext, field: Field, values: Record<string, any>): Promise<void> {
	const current = values[field.id];
	let prefill = "";
	if (field.kind === "json" || Array.isArray(current)) prefill = JSON.stringify(current ?? {}, null, 2);
	else if (current !== undefined) prefill = String(current);
	const result = await ctx.ui.editor(field.label, prefill);
	if (result === undefined) return;
	const trimmed = result.trim();
	if (!trimmed) {
		values[field.id] = undefined;
		return;
	}
	if (field.kind === "number") {
		const n = Number(trimmed);
		if (!Number.isFinite(n)) {
			ctx.ui.notify("Not a number: " + trimmed, "warning");
			return;
		}
		values[field.id] = n;
	} else if (field.kind === "json") {
		try {
			values[field.id] = JSON.parse(trimmed);
		} catch {
			ctx.ui.notify("Invalid JSON", "warning");
			return;
		}
	} else if (field.kind === "tags") {
		values[field.id] = trimmed
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
	} else {
		values[field.id] = trimmed;
	}
}

const PROVIDER_FIELDS: Field[] = [
	{ id: "name", label: "Name", kind: "text" },
	{ id: "baseUrl", label: "Base URL", kind: "text" },
	{ id: "api", label: "API type", kind: "enum", options: API_CHOICES, optional: true, hint: "Inherited picks the API from the base URL" },
	{ id: "apiKey", label: "API key", kind: "text", placeholder: "not set", hint: "literal, $ENV_VAR, or !command. /login stores a key in auth.json instead" },
	{ id: "authHeader", label: "Authorization header", kind: "bool", optional: true, hint: "Inherited sends Bearer auth" },
	{ id: "modelsEndpoint", label: "Models endpoint", kind: "text", optional: true, hint: "Inherited uses base URL + /v1/models (or + /models when the base URL already has a version)" },
	{ id: "headers", label: "Headers", kind: "json" },
	{ id: "compat", label: "API compatibility", kind: "json", hint: "set only for verified differences" },
	{ id: "filters.hideDatedVariants", label: "Hide dated variants", kind: "bool", optional: true },
	{ id: "filters.hideBeta", label: "Hide beta / preview", kind: "bool", optional: true },
	{ id: "filters.minContextWindow", label: "Min context window", kind: "number", optional: true },
	{ id: "filters.exclude", label: "Exclude patterns", kind: "json", hint: "array of regular expressions" },
	{ id: "responseMap", label: "Response mapping", kind: "json", hint: "only needed for a non-standard model list response" },
];

function providerSettingsView(screen: Screen, id: string): FieldView {
	const providers = screen.providers;
	const p = providers.config.providers[id];
	const values: Record<string, any> = {};
	for (const f of PROVIDER_FIELDS) values[f.id] = getPath(p, f.id);

	const save = async () => {
		for (const f of PROVIDER_FIELDS) {
			const v = values[f.id];
			setPath(p, f.id, typeof v === "string" && !v.trim() ? undefined : v);
		}
		providers.sync();
		await providers.persist();
		screen.ctx.ui.notify("Saved " + id, "info");
		screen.pop();
	};

	const remove = async () => {
		const ok = await screen.ctx.ui.confirm("Delete provider", "Delete " + id + "? It is unregistered immediately and removed from models.json.");
		if (!ok) return;
		delete providers.config.providers[id];
		providers.sync();
		await providers.persist();
		screen.pop();
		screen.pop();
		screen.reset();
	};

	const view = new FieldView(
		"Provider settings",
		id,
		PROVIDER_FIELDS,
		values,
		["Delete provider"],
		screen.theme,
		async (field) => {
			await editFieldValue(screen.ctx, field, values);
			view.dirty = true;
			screen.rerender();
		},
		(action) => {
			if (action === "Delete provider") void remove();
		},
		() => void save(),
		() => screen.pop(),
	);
	return view;
}

const MODEL_FIELDS: Field[] = [
	{ id: "input", label: "Input", kind: "json" },
	{ id: "contextWindow", label: "Context window", kind: "number" },
	{ id: "maxTokens", label: "Max output tokens", kind: "number" },
	{ id: "reasoning", label: "Reasoning", kind: "bool" },
	{ id: "cost", label: "Cost per Mtok", kind: "json", hint: "{ input, output, cacheRead, cacheWrite }" },
	{ id: "promptCache", label: "Prompt cache", kind: "json", hint: "{ short, long } in seconds" },
	{ id: "thinkingLevelMap", label: "Thinking level map", kind: "json" },
	{ id: "compat", label: "API compatibility", kind: "json" },
	{ id: "inputLimits", label: "Input limits", kind: "json" },
	{ id: "samplingParams", label: "Sampling params", kind: "json" },
];

function modelDefaultsView(screen: Screen, id: string): FieldView {
	const providers = screen.providers;
	const p = providers.config.providers[id];
	p.defaults ??= {};
	const values: Record<string, any> = {};
	for (const f of MODEL_FIELDS) values[f.id] = p.defaults[f.id as keyof ModelFields];

	const save = async () => {
		const next: ModelFields = {};
		for (const f of MODEL_FIELDS) {
			const v = values[f.id];
			if (v !== undefined && v !== "") (next as any)[f.id] = v;
		}
		p.defaults = Object.keys(next).length ? next : undefined;
		providers.sync();
		await providers.persist();
		screen.ctx.ui.notify("Saved defaults for " + id, "info");
		screen.pop();
	};

	const view = new FieldView(
		"Model defaults",
		id + " · inherited by every model unless the model overrides it",
		MODEL_FIELDS,
		values,
		[],
		screen.theme,
		async (field) => {
			await editFieldValue(screen.ctx, field, values);
			view.dirty = true;
			screen.rerender();
		},
		() => {},
		() => void save(),
		() => screen.pop(),
	);
	return view;
}

function modelEditView(screen: Screen, id: string, modelId: string | undefined): FieldView {
	const providers = screen.providers;
	const p = providers.config.providers[id];
	const existing = modelId ? p.models[modelId] : undefined;
	const values: Record<string, any> = {
		id: modelId ?? "",
		name: existing?.fields && (existing.fields as any).name !== undefined ? (existing.fields as any).name : p.discovery?.models.find((m) => m.id === modelId)?.name ?? "",
		enabled: existing ? (existing.enabled === false ? "disabled" : "enabled") : "enabled",
		tags: existing?.tags,
		api: existing?.api,
		baseUrl: existing?.baseUrl,
		headers: existing?.headers,
	};
	for (const f of MODEL_FIELDS) values["fields." + f.id] = existing?.fields?.[f.id as keyof ModelFields];

	const fields: Field[] = [];
	if (!existing) fields.push({ id: "id", label: "Model id", kind: "text", hint: "the id your endpoint uses" });
	fields.push({ id: "name", label: "Display name", kind: "text" });
	fields.push({ id: "enabled", label: "Status", kind: "enum", options: ["enabled", "disabled"], optional: false });
	fields.push({ id: "tags", label: "Tags", kind: "tags", hint: "comma separated" });

	const probeId = modelId ?? "__new__";
	const prov = resolveModel(id, p, probeId, existing ?? { enabled: true }).provenance;
	for (const f of MODEL_FIELDS) {
		fields.push({ ...f, id: "fields." + f.id, hint: prov[f.id] ? "Inherited from " + prov[f.id] : f.hint });
	}
	fields.push({ id: "api", label: "API type override", kind: "enum", options: API_CHOICES, optional: true, hint: "Inherited uses the provider API" });
	fields.push({ id: "baseUrl", label: "Base URL override", kind: "text" });
	fields.push({ id: "headers", label: "Headers", kind: "json" });

	const save = async () => {
		const targetId = (values.id || modelId || "").trim();
		if (!targetId) {
			screen.ctx.ui.notify("Model id is required", "warning");
			return;
		}
		const fields: ModelFields = {};
		for (const f of MODEL_FIELDS) {
			const v = values["fields." + f.id];
			if (v !== undefined && v !== "") (fields as any)[f.id] = v;
		}
		if (typeof values.name === "string" && values.name.trim()) (fields as any).name = values.name.trim();
		const entry: StoredModel = {
			enabled: values.enabled === "disabled" ? false : true,
			fields: Object.keys(fields).length ? fields : undefined,
		};
		if (values.tags?.length) entry.tags = values.tags;
		if (values.api) entry.api = values.api;
		if (values.baseUrl) entry.baseUrl = values.baseUrl;
		if (values.headers && Object.keys(values.headers).length) entry.headers = values.headers;
		if (modelId && targetId !== modelId) delete p.models[modelId];
		p.models[targetId] = entry;
		providers.sync();
		await providers.persist();
		screen.ctx.ui.notify("Saved " + targetId, "info");
		screen.pop();
	};

	const remove = async () => {
		if (!modelId) return;
		const ok = await screen.ctx.ui.confirm("Delete model", "Remove " + modelId + " from " + id + "? Its model-specific configuration will be deleted.");
		if (!ok) return;
		delete p.models[modelId];
		providers.sync();
		await providers.persist();
		screen.pop();
	};

	const view = new FieldView(
		existing ? "Edit model" : "Add model",
		existing ? id + "/" + modelId : id,
		fields,
		values,
		existing ? ["Delete model"] : [],
		screen.theme,
		async (field) => {
			await editFieldValue(screen.ctx, field, values);
			view.dirty = true;
			screen.rerender();
		},
		(action) => {
			if (action === "Delete model") void remove();
		},
		() => void save(),
		() => screen.pop(),
	);
	return view;
}

// ============================================================================
// Entry points
// ============================================================================

async function openProvidersUi(ctx: ExtensionContext, providers: Providers, startProviderId?: string): Promise<void> {
	let screen: Screen | undefined;
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		screen = new Screen(providers, ctx, theme, tui, () => done());
		if (startProviderId && providers.config.providers[startProviderId]) {
			screen.push(providerView(screen, startProviderId));
		}
		return {
			render: (width: number) => screen!.render(width),
			invalidate: () => screen!.invalidate(),
			handleInput: (data: string) => screen!.handleInput(data),
			get focused() {
				return true;
			},
			set focused(value: boolean) {
				if (!value) screen?.setFocused(false);
			},
			dispose: () => {
				screen?.top?.setFocused?.(false);
			},
		};
	});
}

export default function cxProvidersExtension(pi: ExtensionAPI): void {
	const providers = new Providers(pi);

	// Register before startup so curated models are visible to model selection and --list-models.
	providers.boot();

	pi.on("session_start", (_event, ctx) => {
		providers.start(ctx);
	});

	pi.on("session_shutdown", () => {
		providers.stop();
	});

	pi.registerCommand("providers", {
		description: "Add, curate and configure custom providers and their models",
		getArgumentCompletions: (prefix) => {
			const needle = prefix.trim().toLowerCase();
			const items: { value: string; label: string }[] = [];
			for (const [id, p] of Object.entries(providers.config.providers)) {
				if (needle && !id.toLowerCase().includes(needle) && !p.name.toLowerCase().includes(needle)) continue;
				items.push({ value: id, label: p.name + " (" + id + ")" });
			}
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/providers requires interactive mode", "warning");
				return;
			}
			const needle = args.trim();
			let startProviderId: string | undefined;
			if (needle) {
				startProviderId = providers.findProvider(needle);
				if (!startProviderId) {
					ctx.ui.notify("No custom provider matches: " + needle, "warning");
					return;
				}
			}
			await openProvidersUi(ctx, providers, startProviderId);
		},
	});
}

