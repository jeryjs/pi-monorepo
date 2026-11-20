# Pi Unify Provider - Rewrite Checklist (Flat)

## 0) Reset / Baseline
- [x] Move old implementation to `old_src/`
- [x] Commit archive checkpoint
- [x] Re-study `pi-subagents` + VSCode unify provider internals
- [x] Re-study `pi-ai` + `pi-agent-core` API contracts

## 1) Flat Core Scaffolding
- [ ] Create root files (`index.ts`, `types.ts`, `config-store.ts`, `secret-store.ts`)
- [ ] Switch `package.json` extension entry to flat file (`./index.ts`)
- [ ] Keep implementation DRY + fail-fast

## 2) Auth + Request Mutation
- [ ] Implement auth config union + runtime resolver
- [ ] Support methods: none, api-key, bearer-token, oauth2, oauth2-pkce, oauth-device-code, browser-session, custom-header, query-param
- [ ] Apply auth to request payload/baseUrl/headers/query in `before_provider_request`

## 3) Provider + Model Sources
- [ ] Add 5 presets: Together, Fireworks, AI21, Poe, Perplexity (+ Custom)
- [ ] Implement model fetchers with retry/backoff
- [ ] Add compact model metadata database and merge pipeline

## 4) Persistent TUI
- [ ] Build one `ctx.ui.custom`-based stateful router component
- [ ] Add provider list/add/edit/delete flow
- [ ] Add model list/add/remove flow
- [ ] Add auth method edit flow

## 5) Command + Runtime Wiring
- [ ] `/unify` dashboard command
- [ ] `/unify-add` fast add flow
- [ ] `/unify-refresh` model refresh command
- [ ] Register configured providers on `session_start`

## 6) Validation + Polish
- [ ] Typecheck passes
- [ ] Manual smoke tests pass for all 5 providers
- [ ] Clean error text and status updates

## Commit Rule
- [ ] Commit every meaningful milestone (no giant dump commits)
