#!/usr/bin/env python3
"""PostToolUse (Edit|Write|MultiEdit): run format_command, then lint_command, on the edited file.
- format failure: reported to the user only (non-blocking).
- lint failure: exit 2 so Claude sees the (capped) lint output and fixes it.
Config: format_command, lint_command, file_globs. Empty commands => no-op."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _harness as h  # noqa: E402


def main():
    data = h.read_input()
    root = h.project_root(data)
    cfg = h.load_config(root)
    fmt, lint = (cfg.get("format_command") or "").strip(), (cfg.get("lint_command") or "").strip()
    if not fmt and not lint:
        return 0
    globs = cfg.get("file_globs") or []
    limit = cfg.get("max_feedback_chars")
    for path in h.edited_paths(data):
        rel, absolute = h.rel_to_root(path, root)
        if rel is None or not os.path.isfile(absolute):
            continue
        if globs and not h.match_any(rel, globs):
            continue
        if fmt:
            code, out = h.run_shell(h.build_cmd(fmt, absolute), root, 90)
            if code != 0:
                print(json.dumps({"systemMessage": f"harness: formatter failed on {rel} (exit {code}): "
                                  + h.cap(out, 500)}))
        if lint:
            code, out = h.run_shell(h.build_cmd(lint, absolute), root, 90)
            if code != 0:
                print(f"Lint failed on {rel} (exit {code}). Fix these before continuing:\n"
                      + h.cap(out, limit), file=sys.stderr)
                return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
