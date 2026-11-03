# CLAUDE.md

## Agent harness (Claude Code hooks)
Ported from mustang-ops. Hooks live in `.claude/hooks/` (Python 3 stdlib only) and are wired in `.claude/settings.json`; per-repo values are in `.claude/harness.json`.
- **PreToolUse** (`guard_paths.py`): edits to protected paths (`.claude/settings.json`, `.claude/harness.json`, `.claude/hooks/**`, `.github/workflows/**`, `**/migrations/**`, `package-lock.json`, `**/package-lock.json`, `**/Cargo.lock`, …) and generated paths are refused. Changing them needs the owner's explicit approval.
- **PostToolUse** (`format_file.py`): runs `(no formatter)` then `: {file}; npx --no-install tsc --noEmit -p tsconfig.json` on each edited file matching ['src/**/*.ts']; a lint failure is fed back to fix.
- **Stop** (`stop_tests.py`): runs `npm test` when the tree is dirty and blocks finishing while it fails. CI is still the full gate.
- For multi-session work, copy `.claude/templates/PLAN.md` to the repo root and fill it in.
