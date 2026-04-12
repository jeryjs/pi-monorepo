const SECRET_KEY_PATTERN = /(authorization|api[-_]?key|token|secret|cookie|password)/i;

function replacer(_key: string, value: unknown): unknown {
	if (typeof value !== "string") return value;
	if (value.length <= 8) return "***";
	return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

export function isVerboseEnabled(): boolean {
	return process.argv.includes("--verbose") || process.argv.includes("-v");
}

export function redactSecrets<T>(value: T): T {
	if (!value || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		return value.map((item) => redactSecrets(item)) as T;
	}
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (SECRET_KEY_PATTERN.test(key)) {
			out[key] = replacer(key, entry);
			continue;
		}
		out[key] = redactSecrets(entry);
	}
	return out as T;
}

export function verboseLog(scope: string, message: string, data?: unknown): void {
	if (!isVerboseEnabled()) return;
	const prefix = `[unify:${scope}]`;
	if (data === undefined) {
		console.log(prefix, message);
		return;
	}
	console.log(prefix, message, redactSecrets(data));
}
