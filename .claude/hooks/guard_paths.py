#!/usr/bin/env python3
"""PreToolUse (Edit|Write|MultiEdit): block writes to protected or generated paths.
Config: protected_paths, generated_paths in .claude/harness.json. Empty => no-op."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _harness as h  # noqa: E402


def main():
    data = h.read_input()
    root = h.project_root(data)
    cfg = h.load_config(root)
    protected, generated = cfg.get("protected_paths") or [], cfg.get("generated_paths") or []
    if not protected and not generated:
        return 0
    for path in h.edited_paths(data):
        rel, _abs = h.rel_to_root(path, root)
        if rel is None:
            continue  # outside the project; left to Claude Code's own permission rules
        hit, kind = h.match_any(rel, protected), "protected"
        if not hit:
            hit, kind = h.match_any(rel, generated), "generated"
        if hit:
            hint = ("Edit the source and regenerate instead." if kind == "generated"
                    else "Ask the user for explicit approval; do not work around this.")
            reason = f"Blocked by harness: '{rel}' is a {kind} path (pattern '{hit}'). {hint}"
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason}}))
            return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
