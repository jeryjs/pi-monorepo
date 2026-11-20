# hermes-config

**Problem.** With default settings `pi-hermes-memory` opens its SQLite database during startup:
a `PRAGMA quick_check` integrity scan plus (on Windows) a `powershell.exe` lock probe, both on
the critical path of "mounting agent & tools".

**Fix.** In `~/.pi/agent/hermes-memory-config.json`:

```json
{ "lazyInitialization": true, "quickCheckOnOpen": false }
```

Both keys move that work behind first use. Nothing else in the file changes — the patch parses the
JSON, sets only the two keys, and re-serializes (2-space indent + trailing newline) only when a
value actually differs. An already-tuned config is byte-identical after a run, so `verify` shows
0 drift.

**Revert.** No guessing: the previous values are not recoverable from the file, so there is no
`revert()` hook and the runner restores its pre-patch backup (`backups/hermes-config/`) instead.
If the config was already tuned when the patch first ran, nothing was written and there is nothing
to revert.

**If it breaks.** A non-object or invalid JSON config raises a conflict with the parse error
instead of corrupting the file.
