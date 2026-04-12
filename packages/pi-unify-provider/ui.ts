import {
	DynamicBorder,
	keyHint,
	rawKeyHint,
	type Theme,
} from "@mariozechner/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
	truncateToWidth,
	type Component,
} from "@mariozechner/pi-tui";
import type { UnifyModelConfig } from "./types.ts";

export interface SearchSelectorItem {
	value: string;
	label: string;
	secondary?: string;
	searchText?: string;
    disabled?: boolean;
    visible?: boolean;
}

function padLine(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width));
}

function formatCount(selected: number, total: number): string {
	return total === 0 ? "0/0" : `${selected}/${total}`;
}

function compactTokens(tokens?: number): string | undefined {
	if (!tokens || tokens <= 0) return undefined;
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

export function formatModelProperties(model: UnifyModelConfig): string {
	const props: string[] = [];
	if (model.capabilities?.reasoning) props.push("think");
	if (model.capabilities?.imageInput) props.push("img");
	const ctx = compactTokens(model.contextWindow);
	if (ctx) props.push(`ctx:${ctx}`);
	const out = compactTokens(model.maxTokens);
	if (out) props.push(`out:${out}`);
	if (model.source) props.push(model.source);
	return props.join(" · ");
}

/**
 * Searchable selector with keyboard behavior mirroring model-selector style.
 */
export class SearchSelectorComponent extends Container {
	searchInput: Input;
	_focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	listContainer: Container;
	allItems: SearchSelectorItem[] = [];
	filteredItems: SearchSelectorItem[] = [];
	selectedIndex = 0;
	titleText: Text;
	theme: Theme;
	onSelect: (value: string) => void;
	onCancel: () => void;
	hints: string;

	constructor(
		theme: Theme,
		title: string,
		items: SearchSelectorItem[],
		onSelect: (value: string) => void,
		onCancel: () => void,
		hints?: string,
		initialSearchInput?: string,
	) {
		super();
		this.theme = theme;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.hints = hints ?? `${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "cancel")}`;

		this.allItems = [...items];
		this.filteredItems = [...items];

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.titleText = new Text(this.theme.fg("accent", title), 0, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			const selected = this.filteredItems[this.selectedIndex];
			if (selected) this.onSelect(selected.value);
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(new Text(this.theme.fg("dim", this.hints), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.filterItems(this.searchInput.getValue());
	}

	filterItems(query: string): void {
		this.filteredItems = query
			? fuzzyFilter(this.allItems, query, (item) => item.searchText ?? `${item.label} ${item.secondary ?? ""}`)
			: this.allItems;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateList();
	}

	updateList(): void {
		this.listContainer.clear();
		const maxVisible = 15;
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredItems.length - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, this.filteredItems.length);

		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("dim", "No matching results"), 0, 0));
			return;
		}

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;
            if (item.visible === false) continue;
			if (item.disabled) {
				this.listContainer.addChild(new Text(this.theme.fg("dim", `  ${item.label}`), 0));
				continue;
			}
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
			const label = isSelected ? this.theme.fg("accent", item.label) : item.label;
			const secondary = item.secondary ? this.theme.fg("dim", ` ${item.secondary}`) : "";
			this.listContainer.addChild(new Text(`${prefix}${label}${secondary}`, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			this.listContainer.addChild(new Text(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
            // If the newly selected item is not visible or disabled, keep moving up until we find an enabled item or loop back to the original index
            if (this.filteredItems[this.selectedIndex].disabled || this.filteredItems[this.selectedIndex].visible === false) {
                let direction = -1, newIndex = this.selectedIndex;
                do {
                    newIndex = newIndex === 0 && direction === -1 ? this.filteredItems.length - 1 : (newIndex + direction) % this.filteredItems.length;
                } while ((this.filteredItems[newIndex].disabled || this.filteredItems[newIndex].visible === false) && newIndex !== this.selectedIndex);
                this.selectedIndex = newIndex;
            }
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
            // If the newly selected item is not visible or disabled, keep moving down until we find an enabled item or loop back to the original index
            if (this.filteredItems[this.selectedIndex].disabled || this.filteredItems[this.selectedIndex].visible === false) {
                let direction = 1, newIndex = this.selectedIndex;
                do {
                    newIndex = newIndex === this.filteredItems.length - 1 && direction === 1 ? 0 : (newIndex + direction) % this.filteredItems.length;
                } while ((this.filteredItems[newIndex].disabled || this.filteredItems[newIndex].visible === false) && newIndex !== this.selectedIndex);
                this.selectedIndex = newIndex;
            }
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredItems[this.selectedIndex];
			if (selected) this.onSelect(selected.value);
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
			return;
		}

		this.searchInput.handleInput(keyData);
		this.filterItems(this.searchInput.getValue());
	}
}

export interface ScopedModelsConfig {
	allModels: UnifyModelConfig[];
	enabledModelIds: Set<string>;
	hasEnabledModelsFilter: boolean;
}

export interface ScopedModelsCallbacks {
	onModelToggle: (modelId: string, enabled: boolean) => void;
	onEnableAll: (allModelIds: string[]) => void;
	onClearAll: () => void;
	onPersist: (enabledModelIds: string[]) => void;
	onCancel: () => void;
}

interface ScopedModelItem {
	id: string;
	model: UnifyModelConfig;
	enabled: boolean;
}

function isModelEnabled(enabledIds: string[] | null, id: string): boolean {
	return enabledIds === null || enabledIds.includes(id);
}

function toggleModel(enabledIds: string[] | null, id: string): string[] {
	if (enabledIds === null) return [id];
	const index = enabledIds.indexOf(id);
	if (index >= 0) return [...enabledIds.slice(0, index), ...enabledIds.slice(index + 1)];
	return [...enabledIds, id];
}

function enableAllModels(enabledIds: string[] | null, allIds: string[]): string[] | null {
	if (enabledIds === null) return null;
	return null;
}

function clearAllModels(enabledIds: string[] | null, allIds: string[]): string[] {
	if (enabledIds === null) return [];
	return allIds.filter((id) => !enabledIds.includes(id));
}

function getSortedIds(enabledIds: string[] | null, allIds: string[]): string[] {
	if (enabledIds === null) return allIds;
	const enabledSet = new Set(enabledIds);
	return [...enabledIds, ...allIds.filter((id) => !enabledSet.has(id))];
}

/**
 * Scoped model configuration component modeled after ScopedModelsSelectorComponent.
 */
export class ScopedModelConfigComponent extends Container {
	private modelsById = new Map<string, UnifyModelConfig>();
	private allIds: string[] = [];
	private enabledIds: string[] | null = null;
	private filteredItems: ScopedModelItem[] = [];
	private selectedIndex = 0;
	private searchInput: Input;
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private footerText: Text;
	private callbacks: ScopedModelsCallbacks;
	private maxVisible = 15;
	private isDirty = false;
	private theme: Theme;

	constructor(theme: Theme, config: ScopedModelsConfig, callbacks: ScopedModelsCallbacks) {
		super();
		this.theme = theme;
		this.callbacks = callbacks;

		for (const model of config.allModels) {
			this.modelsById.set(model.id, model);
			this.allIds.push(model.id);
		}
		this.enabledIds = config.hasEnabledModelsFilter ? [...config.enabledModelIds] : null;
		this.filteredItems = this.buildItems();

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Model Configuration")), 0, 0));
		this.addChild(new Text(theme.fg("dim", "Search + Enter toggle · Ctrl+S save · Esc back"), 0, 0));
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));
		this.footerText = new Text(this.getFooterText(), 0, 0);
		this.addChild(this.footerText);
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	private buildItems(): ScopedModelItem[] {
		return getSortedIds(this.enabledIds, this.allIds)
			.filter((id) => this.modelsById.has(id))
			.map((id) => ({
				id,
				model: this.modelsById.get(id)!,
				enabled: isModelEnabled(this.enabledIds, id),
			}));
	}

	private getFooterText(): string {
		const enabledCount = this.enabledIds?.length ?? this.allIds.length;
		const allEnabled = this.enabledIds === null;
		const countText = allEnabled ? "all enabled" : `${enabledCount}/${this.allIds.length} enabled`;
		const base = `Enter toggle · Ctrl+A all · Ctrl+X clear · Ctrl+S save · ${countText}`;
		return this.isDirty ? `${this.theme.fg("dim", base)} ${this.theme.fg("warning", "(unsaved)")}` : this.theme.fg("dim", base);
	}

	private refresh(): void {
		const query = this.searchInput.getValue();
		const items = this.buildItems();
		this.filteredItems = query
			? fuzzyFilter(items, query, (item) => `${item.model.id} ${item.model.name ?? ""} ${formatModelProperties(item.model)}`)
			: items;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateList();
		this.footerText.setText(this.getFooterText());
	}

	private updateList(): void {
		this.listContainer.clear();
		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("dim", "No matching models"), 0, 0));
			return;
		}

		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible));
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.fg("accent", "→ ") : "  ";
			const status = item.enabled ? this.theme.fg("success", "●") : this.theme.fg("dim", "○");
			const modelText = isSelected ? this.theme.fg("accent", item.model.id) : item.model.id;
			const secondary = formatModelProperties(item.model);
			this.listContainer.addChild(new Text(`${prefix}${status} ${modelText}${secondary ? this.theme.fg("dim", ` ${secondary}`) : ""}`, 0, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			this.listContainer.addChild(new Text(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0));
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const item = this.filteredItems[this.selectedIndex];
			if (!item) return;
			const wasAllEnabled = this.enabledIds === null;
			this.enabledIds = toggleModel(this.enabledIds, item.id);
			this.isDirty = true;
			if (wasAllEnabled) {
				this.callbacks.onClearAll();
			}
			this.callbacks.onModelToggle(item.id, isModelEnabled(this.enabledIds, item.id));
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.ctrl("a"))) {
			this.enabledIds = enableAllModels(this.enabledIds, this.allIds);
			this.isDirty = true;
			this.callbacks.onEnableAll(this.allIds);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.ctrl("x"))) {
			this.enabledIds = clearAllModels(this.enabledIds, this.allIds);
			this.isDirty = true;
			this.callbacks.onClearAll();
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.ctrl("s"))) {
			this.callbacks.onPersist(this.enabledIds ?? [...this.allIds]);
			this.isDirty = false;
			this.footerText.setText(this.getFooterText());
			return;
		}
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.refresh();
			} else {
				this.callbacks.onCancel();
			}
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.callbacks.onCancel();
			return;
		}

		this.searchInput.handleInput(data);
		this.refresh();
	}
}

export interface ProviderDashboardItem {
	providerName: string;
	providerType: string;
	authMethod: string;
	enabledModels: number;
	totalModels: number;
}

export function toDashboardItems(
	providers: Array<{
		name: string;
		type: string;
		auth: { method: string };
		models: UnifyModelConfig[];
	}>,
): ProviderDashboardItem[] {
	return providers.map((provider) => {
		const enabledModels = provider.models.filter((model) => model.enabled !== false).length;
		return {
			providerName: provider.name,
			providerType: provider.type,
			authMethod: provider.auth.method,
			enabledModels,
			totalModels: provider.models.length,
		};
	});
}

export function toDashboardSelectorItems(items: ProviderDashboardItem[]): SearchSelectorItem[] {
	return items.map((item) => ({
		value: item.providerName,
		label: item.providerName,
		secondary: `${item.providerType} · auth:${item.authMethod} · models:${formatCount(item.enabledModels, item.totalModels)}`,
		searchText: `${item.providerName} ${item.providerType} ${item.authMethod}`,
	}));
}
