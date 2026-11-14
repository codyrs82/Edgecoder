# Contributing to EdgeCoder

Thanks for helping. This page covers how to propose a change. How the code is laid out and how to run it is in the [README](README.md#developer-guide).

## Before you start

- Look for an existing issue first. For anything bigger than a small fix, open an issue (or comment on one) before writing code, so the approach can be agreed on.
- Report security problems privately; see [SECURITY.md](SECURITY.md). Don't open a public issue for them.
- By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

- Node.js 22 (see `.nvmrc`) and npm. Docker and Ollama are optional.
- `npm ci`, then `npm run dev` for the all-in-one stack, or see the README for running services one at a time.
- Desktop app: `cd desktop && npm ci && npm run tauri dev` (needs the Rust toolchain and the Tauri system dependencies).

## Making a change

1. Branch from `main` (`fix/<issue>-short-name` or `feat/<issue>-short-name`).
2. Keep a PR to **one issue**, and put `Closes #N` in its description.
3. Add or update tests with the change: `tests/` for the backend, `desktop/tests/` for the desktop app.
4. Before pushing, run `npm run build` (type check) and `npm test`. CI runs them on Linux, macOS and Windows, plus the desktop and Docker builds, so line endings and paths must work on all three.
5. Update the docs when you add an endpoint, an env var or a startup script. Env vars go in [site-docs/reference/environment-variables.md](site-docs/reference/environment-variables.md).
6. Never commit secrets, `.env` files, build output (`dist/`, `out/`, `*.vsix`, Tauri `gen/schemas/`) or IDE user state.

## Review and merge

- At least one maintainer review and green CI are required.
- PRs are merged with merge commits; please don't force-push a branch after review has started. Push follow-up commits instead.
- Changes to auth, the mesh, the economy or the ledger get an extra security review.

## Releasing the VS Code extension

The `.vsix` is never committed (`out/` and `*.vsix` are gitignored). It is built from source at a tag:

1. Bump `version` in `extensions/vscode/package.json` in a PR and merge it.
2. Tag that merge commit `vscode-v<version>` (for example `vscode-v0.2.0`) and push the tag. The tag must equal the version, or the build stops.
3. The `vscode-release` workflow runs `scripts/release/package-vscode.sh`, which runs `npm ci`, compiles, and runs `vsce package` with the `@vscode/vsce` pinned in the extension's lockfile. It attaches `edgecoder-vscode-<version>.vsix` and `SHA256SUMS` to the `vscode-v<version>` GitHub release.
4. Publish only that `.vsix`, to the Marketplace or anywhere else. Check its hash against `SHA256SUMS` first. Never publish one built on a laptop.

To build one locally (for example, to try it with `code --install-extension`), run `npm run package:vscode`. The result goes in `build/vscode/`.

## Licensing

Source files carry an SPDX header. Copy the header used by the files around your change. See [LICENSE](LICENSE).
