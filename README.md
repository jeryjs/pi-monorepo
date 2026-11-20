# pi-extensions

Monorepo for my [Pi](https://pi.dev/) extensions. Each package lives in
`packages/` and is published to npm under its own name.

| Package | Directory |
| --- | --- |
| keyrouter | [`packages/pi-keyrouter`](./packages/pi-keyrouter) — credential pools, automatic key/OAuth rotation on 429 failovers |
| bg_terminal | [`packages/pi-bg-terminal`](./packages/pi-bg-terminal) — background commands, attachable PTY/TUI sessions |
| unify_provider | [`packages/pi-unify-provider`](./packages/pi-unify-provider) — multi-provider LLM management and model discovery |
| oc_proxy | [`packages/opencode-429-proxy`](./packages/opencode-429-proxy) — egress-proxy fallback for `opencode-free` rate limits |

## Install

```bash
pi install npm:@jeryjs/pi-keyrouter
pi install npm:@jeryjs/pi-bg-terminal
pi install npm:@jeryjs/pi-unify-provider
```

The npm names are independent of the folder names; check each package's
`package.json` for the published name.

## Layout

```
packages/
  pi-keyrouter/        # package.json, sources, tests, own docs
  pi-bg-terminal/
  pi-unify-provider/
```

Each package keeps its own `package.json`, lockfile, tests, docs, and README.
The root `package.json` only declares the workspace and is never published.

## History

This repository was created by renaming `jeryjs/pi-keyrouter` and importing the
histories of `jeryjs/pi-unify-provider` and the standalone working copy of
`pi-bg-terminal` into `packages/`. Commit messages carry the package they belong
to as a prefix:

- `[keyrouter]` — `packages/pi-keyrouter` (original commits, hashes unchanged)
- `[bg_terminal]` — `packages/pi-bg-terminal`
- `[unify_provider]` — `packages/pi-unify-provider`
- `[oc_proxy]` — `packages/opencode-429-proxy` (no git history existed; imported as one commit)
- `[monorepo]` — repo-root scaffolding

Imported commits had their paths rewritten to their package directory, so their
hashes differ from the standalone repositories. Authors, dates, messages, and
contents were preserved.

## Tags and releases

GitHub release tags are `<folder-name>@<version>` — the repository-side name,
not the npm name. The npm scope (`@jeryjs/...`) is a separate decision and stays
out of the tags:

```bash
git tag pi-keyrouter@1.10.0
git tag pi-bg-terminal@3.0.1
git tag pi-unify-provider@2.0.0
```

Tags created before the move keep their original `vX.Y.Z` names.

`packages/pi-keyrouter/.github/workflows/publish.yml` is the original
single-package workflow, kept for reference. The active one is
`.github/workflows/publish-keyrouter.yml` at the repo root, which publishes
`packages/pi-keyrouter` when a `pi-keyrouter@<version>` tag is pushed.

## Workspace commands

```bash
bun install                             # install every package
npm test -w packages/pi-keyrouter       # run one package's tests
npm publish -w packages/pi-bg-terminal  # publish one package
```

## License

MIT. Each package retains its own `LICENSE`.
