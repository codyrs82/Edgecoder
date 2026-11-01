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

## Licensing

Source files carry an SPDX header. Copy the header used by the files around your change. See [LICENSE](LICENSE).
