#!/usr/bin/env python3
"""Stop: run test_command; while it fails, block Claude from finishing.
- stop_hook_active == true  => allow stop (already continued once; avoids infinite loops).
- Output fed back to Claude is capped at max_feedback_chars (tail kept).
Config: test_command, test_timeout_seconds, skip_tests_when_git_clean. Empty => no-op."""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _harness as h  # noqa: E402


def git_clean(root):
    try:
        p = subprocess.run(["git", "status", "--porcelain"], cwd=root, capture_output=True,
                           text=True, timeout=20)
        return p.returncode == 0 and not p.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return False


def main():
    data = h.read_input()
    if data.get("stop_hook_active") is True:
        return 0
    root = h.project_root(data)
    cfg = h.load_config(root)
    cmd = (cfg.get("test_command") or "").strip()
    if not cmd:
        return 0
    if cfg.get("skip_tests_when_git_clean") and git_clean(root):
        return 0
    timeout = int(cfg.get("test_timeout_seconds") or 600)
    code, out = h.run_shell(cmd, root, timeout)
    if code == 0:
        return 0
    reason = (f"Tests are failing (`{cmd}` exited {code}). Do not finish yet: fix the failures, "
              f"or if they cannot be fixed within PLAN.md scope, explain why and record it in "
              f"PROGRESS.md.\n\n" + h.cap(out, cfg.get("max_feedback_chars")))
    print(json.dumps({"decision": "block", "reason": reason}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
