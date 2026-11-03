"""Shared helpers for the harness hooks. Python 3 stdlib only."""
import json
import os
import re
import shlex
import subprocess
import sys

DEFAULTS = {
    "format_command": "",
    "lint_command": "",
    "file_globs": [],
    "protected_paths": [],
    "generated_paths": [],
    "test_command": "",
    "test_timeout_seconds": 600,
    "skip_tests_when_git_clean": False,
    "max_feedback_chars": 4000,
}


def read_input():
    """Parse hook JSON from stdin; return {} on empty/invalid input."""
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
        return data if isinstance(data, dict) else {}
    except (ValueError, OSError):
        return {}


def project_root(data):
    root = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or os.getcwd()
    return os.path.realpath(root)


def load_config(root):
    """Load .claude/harness.json (override path with HARNESS_CONFIG). Missing => defaults (all no-op)."""
    path = os.environ.get("HARNESS_CONFIG") or os.path.join(root, ".claude", "harness.json")
    cfg = dict(DEFAULTS)
    try:
        with open(path, encoding="utf-8") as fh:
            user = json.load(fh)
        if isinstance(user, dict):
            cfg.update({k: v for k, v in user.items() if not k.startswith("_")})
    except FileNotFoundError:
        pass
    except (ValueError, OSError) as exc:
        print(f"harness: cannot read {path}: {exc}", file=sys.stderr)
    return cfg


def edited_paths(data):
    """file_path(s) from Edit/Write/MultiEdit tool_input (absolute per docs)."""
    ti = data.get("tool_input") or {}
    paths = []
    if isinstance(ti.get("file_path"), str) and ti["file_path"]:
        paths.append(ti["file_path"])
    return paths


def rel_to_root(path, root):
    absolute = os.path.realpath(path if os.path.isabs(path) else os.path.join(root, path))
    try:
        rel = os.path.relpath(absolute, root)
    except ValueError:
        return None, absolute
    if rel == ".." or rel.startswith(".." + os.sep):
        return None, absolute  # outside project
    return rel.replace(os.sep, "/"), absolute


def _glob_to_regex(pattern):
    """gitignore-style glob -> regex. '**' crosses dirs, '*' and '?' don't.
    A pattern with no '/' matches the basename at any depth; trailing '/' = directory prefix."""
    pat = pattern.strip()
    if pat.startswith("./"):
        pat = pat[2:]
    anchored = "/" in pat.rstrip("/")
    if pat.endswith("/"):
        pat += "**"
    pat = pat.lstrip("/")
    out, i = [], 0
    while i < len(pat):
        c = pat[i]
        if pat.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pat.startswith("**", i):
            out.append(".*")
            i += 2
        elif c == "*":
            out.append("[^/]*")
            i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(c))
            i += 1
    body = "".join(out)
    prefix = "" if anchored else "(?:.*/)?"
    return re.compile("^" + prefix + body + "$")


def match_any(rel_path, patterns):
    for p in patterns or []:
        if isinstance(p, str) and p.strip() and _glob_to_regex(p).match(rel_path):
            return p
    return None


def build_cmd(template, file_path):
    """Substitute {file} (shell-quoted) or append the file if no placeholder."""
    q = shlex.quote(file_path)
    return template.replace("{file}", q) if "{file}" in template else f"{template} {q}"


def run_shell(cmd, cwd, timeout):
    try:
        p = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True,
                           timeout=timeout, stdin=subprocess.DEVNULL)
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired as exc:
        out = exc.stdout or ""
        if isinstance(out, bytes):
            out = out.decode(errors="replace")
        return 124, out + f"\n[harness] timed out after {timeout}s"


def cap(text, limit):
    """Keep the tail (where test failures usually are), capped at `limit` chars."""
    limit = max(200, int(limit or 4000))
    text = text.strip()
    if len(text) <= limit:
        return text
    return f"[... {len(text) - limit} chars truncated ...]\n" + text[-limit:]
