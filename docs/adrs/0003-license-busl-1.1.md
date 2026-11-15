# ADR 0003: The whole repository stays under BUSL-1.1

Status: Accepted (owner decision, 2026-11-14; issue #19)

## Context

Issue #19 asked whether EdgeCoder should stay under the Business Source License 1.1 or move to an
open-source license, and to make the license declarations consistent. Before this change:

- `LICENSE`, the root `package.json` and `packages/mcp-server/package.json` said BUSL-1.1.
- `extensions/vscode/LICENSE.txt` was the MIT license, and the extension's `package.json` had no
  `license` field.
- `desktop/package.json`, `packages/tokens/package.json` and `desktop/src-tauri/Cargo.toml` had no
  license field.

## Decision

1. EdgeCoder stays under BUSL-1.1 with the parameters in `LICENSE`: the Additional Use Grant allows
   any use except offering a competing hosted or managed service, the Change Date is 2030-02-25 and
   the Change License is Apache-2.0.
2. One license covers the whole repository. Every package manifest declares `BUSL-1.1`, and the
   VS Code extension ships the same license text as the repository root.
3. Source files carry `SPDX-License-Identifier: BUSL-1.1`.

Moving to an open-source license later remains possible. The reverse is not: code published under
Apache-2.0 or MIT cannot be taken back, which is why the decision is to keep the current license
until the owner chooses to open-source.

## Consequences

- Copies of the VS Code extension that were distributed while its folder carried the MIT text stay
  under MIT for whoever received them. Versions built after this change are BUSL-1.1.
- GitHub shows the repository license as "Other". GitHub's detector only names licenses from
  choosealicense.com, which does not list BUSL; other BUSL-1.1 repositories (hashicorp/terraform,
  cockroachdb/cockroach) show the same. The `license` fields and SPDX headers are what tools should
  read. The "detected by GitHub" criterion of #19 cannot be met while the license is BUSL-1.1.
- `tests/repo/license-consistency.test.ts` fails if a manifest declares a different license or the
  extension's license text drifts from the root `LICENSE`.
