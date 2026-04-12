import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { ProviderConfigRecord, UnifyModelConfig } from "./types.ts";

export type DashboardAction =
	| { kind: "close" }
	| { kind: "add" }
	| { kind: "refresh" }
	| { kind: "official-models"; providerName: string }
	| { kind: "edit"; providerName: string }
	| { kind: "auth"; providerName: string }
	| { kind: "models"; providerName: string }
	| { kind: "delete"; providerName: string };

function row(content: string, width: number): string {
	return content.length >= width ? truncateToWidth(content, width) : `${content}${" ".repeat(width - content.length)}`;
}

export class UnifyDashboardComponent implements Component {
	private cursor = 0;
	private readonly theme: Theme;
	private readonly providers: ProviderConfigRecord[];
	private readonly done: (action: DashboardAction) => void;

	constructor(
		theme: Theme,
		providers: ProviderConfigRecord[],
		done: (action: DashboardAction) => void,
	) {
		this.theme = theme;
		this.providers = providers;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.done({ kind: "close" });
			return;
		}
		if (data === "a") {
			this.done({ kind: "add" });
			return;
		}
		if (data === "r") {
			this.done({ kind: "refresh" });
			return;
		}
		if (matchesKey(data, "up")) {
			this.cursor = Math.max(0, this.cursor - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.cursor = Math.min(Math.max(0, this.providers.length - 1), this.cursor + 1);
			return;
		}
		const selected = this.providers[this.cursor];
		if (!selected) return;
		if (data === "e") {
			this.done({ kind: "edit", providerName: selected.name });
			return;
		}
		if (data === "h") {
			this.done({ kind: "auth", providerName: selected.name });
			return;
		}
		if (data === "m") {
			this.done({ kind: "models", providerName: selected.name });
			return;
		}
		if (data === "o") {
			this.done({ kind: "official-models", providerName: selected.name });
			return;
		}
		if (data === "d") {
			this.done({ kind: "delete", providerName: selected.name });
			return;
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const inner = Math.max(20, width);
		lines.push(this.theme.fg("accent", row("Unify Provider Manager", inner)));
		lines.push(this.theme.fg("dim", row("", inner)));
		if (this.providers.length === 0) {
			lines.push(row(this.theme.fg("dim", "No providers configured. Press [a] to add."), inner));
		} else {
			for (let i = 0; i < this.providers.length; i++) {
				const provider = this.providers[i]!;
				const selected = i === this.cursor;
				const prefix = selected ? this.theme.fg("accent", "▶") : " ";
				const authMethod = provider.auth.method;
				const text = `${prefix} ${provider.name} [${provider.type}]  models:${provider.models.length}  auth:${authMethod}`;
				lines.push(row(selected ? this.theme.fg("accent", text) : text, inner));
			}
		}
		lines.push(this.theme.fg("dim", row("", inner)));
		lines.push(this.theme.fg("dim", row("a:add  e:edit  h:auth  m:models  o:official  d:delete  r:refresh  q:close", inner)));
		return lines;
	}

	invalidate(): void {}
}

export type ModelManagerAction =
	| { kind: "cancel" }
	| { kind: "save"; models: UnifyModelConfig[] }
	| { kind: "add-custom" }
	| { kind: "edit-model"; modelId: string };

type ModelTab = "all" | "selected";

export class ModelManagerComponent implements Component {
	private readonly allModels: UnifyModelConfig[];
	private readonly selectedById = new Map<string, UnifyModelConfig>();
	private readonly theme: Theme;
	private readonly done: (action: ModelManagerAction) => void;
	private tab: ModelTab = "all";
	private allIndex = 0;
	private selectedIndex = 0;

	constructor(
		theme: Theme,
		allModels: UnifyModelConfig[],
		selectedModels: UnifyModelConfig[],
		done: (action: ModelManagerAction) => void,
	) {
		this.theme = theme;
		this.done = done;
		this.allModels = [...allModels].sort((a, b) => a.id.localeCompare(b.id));
		for (const model of selectedModels) {
			this.selectedById.set(model.id, model);
		}
	}

	private get selectedModels(): UnifyModelConfig[] {
		return [...this.selectedById.values()].sort((a, b) => a.id.localeCompare(b.id));
	}

	private toggleTab(): void {
		this.tab = this.tab === "all" ? "selected" : "all";
	}

	private clampIndices(): void {
		this.allIndex = Math.max(0, Math.min(this.allIndex, Math.max(0, this.allModels.length - 1)));
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.selectedModels.length - 1)));
	}

	private addCurrentAllModel(): void {
		const model = this.allModels[this.allIndex];
		if (!model) return;
		if (!this.selectedById.has(model.id)) {
			this.selectedById.set(model.id, model);
		}
		this.clampIndices();
	}

	private removeCurrentSelectedModel(): void {
		const selected = this.selectedModels[this.selectedIndex];
		if (!selected) return;
		this.selectedById.delete(selected.id);
		this.clampIndices();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.done({ kind: "cancel" });
			return;
		}
		if (matchesKey(data, "tab")) {
			this.toggleTab();
			return;
		}
		if (matchesKey(data, "up")) {
			if (this.tab === "all") this.allIndex = Math.max(0, this.allIndex - 1);
			else this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			if (this.tab === "all") this.allIndex = Math.min(Math.max(0, this.allModels.length - 1), this.allIndex + 1);
			else this.selectedIndex = Math.min(Math.max(0, this.selectedModels.length - 1), this.selectedIndex + 1);
			return;
		}
		if (matchesKey(data, "return")) {
			if (this.tab === "all") this.addCurrentAllModel();
			else this.removeCurrentSelectedModel();
			return;
		}
		if (data === "d" && this.tab === "selected") {
			this.removeCurrentSelectedModel();
			return;
		}
		if (data === "e" && this.tab === "selected") {
			const selected = this.selectedModels[this.selectedIndex];
			if (!selected) return;
			this.done({ kind: "edit-model", modelId: selected.id });
			return;
		}
		if (data === "n") {
			this.done({ kind: "add-custom" });
			return;
		}
		if (data === "s") {
			this.done({ kind: "save", models: this.selectedModels });
		}
	}

	render(width: number): string[] {
		const lines: string[] = [];
		const inner = Math.max(20, width);
		const allCount = this.allModels.length;
		const selected = this.selectedModels;
		const selectedCount = selected.length;

		const tabAll = this.tab === "all" ? this.theme.fg("accent", `[All Models ${allCount}]`) : `[All Models ${allCount}]`;
		const tabSelected = this.tab === "selected" ? this.theme.fg("accent", `[Selected ${selectedCount}]`) : `[Selected ${selectedCount}]`;

		lines.push(this.theme.fg("accent", row("Model Configuration", inner)));
		lines.push(row(`${tabAll}  ${tabSelected}`, inner));
		lines.push(this.theme.fg("dim", row("Enter: add/remove  Tab: switch tab  e:edit selected  n:new model  s:save  q:cancel", inner)));
		lines.push(this.theme.fg("dim", row("", inner)));

		const items = this.tab === "all" ? this.allModels : selected;
		const index = this.tab === "all" ? this.allIndex : this.selectedIndex;

		if (items.length === 0) {
			lines.push(row(this.theme.fg("dim", this.tab === "all" ? "No official models available" : "No selected models yet"), inner));
		} else {
			for (let i = 0; i < items.length; i++) {
				const model = items[i]!;
				const isCurrent = i === index;
				const prefix = isCurrent ? this.theme.fg("accent", "▶") : " ";
				const selectedMark = this.selectedById.has(model.id) ? this.theme.fg("success", "●") : this.theme.fg("dim", "○");
				const modeMark = this.tab === "all" ? selectedMark : this.theme.fg("success", "●");
				const line = `${prefix} ${modeMark} ${model.id}`;
				lines.push(row(isCurrent ? this.theme.fg("accent", line) : line, inner));
			}
		}

		return lines;
	}

	invalidate(): void {}
}
