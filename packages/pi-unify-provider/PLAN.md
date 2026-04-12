# Pi Unify Provider - Rewrite Plan (Flat / Pi-native)

## Why Rewrite

The implementation is being rebuilt to follow Pi-native patterns more strictly:
- Flat file layout like `pi-subagents` (minimal architecture overhead).
- Prefer peer dependency exports over custom utility rewrites.
- Use `ctx.ui.custom` + `@mariozechner/pi-tui` for persistent TUI flows.
- Keep code compact and DRY (fail-fast style).

## Target Scope (v0.2 rewrite)

1. Provider management and registration via `pi.registerProvider`.
2. Five provider presets: Together, Fireworks, AI21, Poe, Perplexity (+ Custom).
3. Auth method support:
     - `none`, `api-key`, `bearer-token`, `oauth2`, `oauth2-pkce`,
         `oauth-device-code`, `browser-session`, `custom-header`, `query-param`.
4. Official model fetch + merge with local manual models.
5. Persistent TUI flow for `/unify`, `/unify-add`, `/unify-refresh`.

## Flat File Layout

All implementation files stay in project root (single-folder style):

```
index.ts                    # extension entry
types.ts                    # config + auth + model types
config-store.ts             # provider config persistence
secret-store.ts             # local secret ref storage
well-known.ts               # 5 provider presets
model-database.ts           # model metadata presets
fetcher.ts                  # provider model discovery
auth.ts                     # auth resolver + header/query/body injection
ui.ts                       # persistent TUI component/router
commands.ts                 # slash command registration
register.ts                 # provider registration coordinator
```

## Dependency Reuse Policy

- `@mariozechner/pi-coding-agent`
    - `ExtensionAPI`, `ExtensionContext`, `ToolDefinition`, `ProviderConfig`, `ProviderModelConfig`, `defineTool`, `loadSkills`, `getMarkdownTheme`.
- `@mariozechner/pi-ai`
    - `Api`, `Model`, `Message`, `Usage`, `TextContent`, `ToolCall`, `StreamOptions`, `SimpleStreamOptions`, `AssistantMessageEventStream` types.
- `@mariozechner/pi-agent-core`
    - `AgentToolResult`, `AgentToolUpdateCallback`, `ThinkingLevel`, `AgentMessage` types for strongly-typed tool/update state.
- `@mariozechner/pi-tui`
    - `Component`, `Container`, `Box`, `Text`, `Markdown`, `matchesKey`, `Key`, `truncateToWidth`, `visibleWidth` for interactive views.

## Implementation Order

1. **Core contracts**: `types.ts`, `config-store.ts`, `secret-store.ts`.
2. **Provider intelligence**: `well-known.ts`, `model-database.ts`, `fetcher.ts`.
3. **Auth pipeline**: token resolution + request mutation support.
4. **UI**: single persistent TUI component with screen stack.
5. **Commands + registration**: `index.ts`, `commands.ts`, `register.ts`.
6. **Validation pass**: typecheck + runtime smoke tests.

## Commit Cadence

Meaningful small commits (one capability per commit):
- `feat: scaffold flat rewrite entry and types`
- `feat: add config and secret stores`
- `feat: add well-known provider presets`
- `feat: implement auth resolution pipeline`
- `feat: add official model fetcher and merge`
- `feat: add persistent unify tui`
- `feat: wire commands and provider registration`
- `fix: type/runtime polish after smoke tests`
