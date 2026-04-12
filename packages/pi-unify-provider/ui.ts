import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { ProviderConfigRecord } from "./types.ts";

export type DashboardAction =
	| { kind: "close" }
	| { kind: "add" }
	| { kind: "refresh" }
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
		lines.push(this.theme.fg("dim", row("a:add  e:edit  h:auth  m:models  d:delete  r:refresh  q:close", inner)));
		return lines;
	}

	invalidate(): void {}
}
