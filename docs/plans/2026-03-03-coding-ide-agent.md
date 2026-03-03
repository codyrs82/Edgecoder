# Coding IDE Agent Interface — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the Edgecoder chat tab into an agentic coding IDE with project file access, git integration, shell execution, planning mode, and inline tool-use rendering.

**Architecture:** The agent (IDE provider on localhost:4304) gets a tool registry for filesystem, git, and shell operations. Tools execute via new Tauri commands exposed as HTTP endpoints. The SSE stream protocol extends from simple `{"content":"..."}` to typed events (`tool_call`, `tool_result`, `diff`, `shell_request`, `shell_output`, `plan`, `status`). The Svelte chat tab renders these as collapsible blocks. Write operations require user approval before executing.

**Tech Stack:** Svelte 5, Tauri 2 (Rust), Fastify, Ollama qwen2.5:7b, Node.js child_process, Monaco diff (existing), `marked` (existing)

---

## Key Files Reference

Before starting, familiarize yourself with these files:

| File | Purpose |
|------|---------|
| `desktop/src/App.svelte` | Root shell — tabs, layout, event routing |
| `desktop/src/pages/ChatView.svelte` | Chat tab — message list, streaming, conversation persistence |
| `desktop/src/components/ChatMessage.svelte` | Single message renderer (user/assistant bubbles) |
| `desktop/src/components/MarkdownRenderer.svelte` | Markdown→HTML with `marked`, code block "Open in Editor" buttons |
| `desktop/src/lib/api.ts` | All HTTP/SSE calls — `streamChat()`, `streamPortalChat()`, helpers |
| `desktop/src/lib/types.ts` | TypeScript interfaces — `ChatMessage`, `Conversation`, etc. |
| `desktop/src/lib/editor-store.ts` | Virtual file system — `EditorFile`, `detectLanguage()` |
| `desktop/src-tauri/src/main.rs` | Tauri app — agent spawn, system metrics, deep links |
| `desktop/src-tauri/Cargo.toml` | Rust dependencies |
| `desktop/src-tauri/capabilities/default.json` | Tauri permissions |
| `desktop/src-tauri/tauri.conf.json` | Window config, CSP, plugins |
| `src/apps/ide/provider-server.ts` | IDE chat server on :4304 — OpenAI-compatible, routes via `IntelligentRouter` |
| `src/model/system-prompt.ts` | System prompt builder — `buildChatSystemPrompt()` |

---

## Task 1: Add IDE tool types and SSE event protocol

Define the shared TypeScript types for tool calls, tool results, and all SSE event types. These types are used by both the provider-server (emitter) and the desktop frontend (renderer).

**Files:**
- Create: `src/apps/ide/tool-types.ts`

**Step 1: Create the tool types file**

```typescript
// src/apps/ide/tool-types.ts
// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/** All tools the agent can invoke */
export type ToolName =
  | "read_file"
  | "list_directory"
  | "search_files"
  | "write_file"
  | "edit_file"
  | "run_shell"
  | "git_status"
  | "git_diff"
  | "git_log"
  | "git_commit"
  | "git_branch";

/** Tools that auto-execute without user approval */
export const READ_TOOLS: ReadonlySet<ToolName> = new Set([
  "read_file",
  "list_directory",
  "search_files",
  "git_status",
  "git_diff",
  "git_log",
]);

/** Tools that require user approval before executing */
export const WRITE_TOOLS: ReadonlySet<ToolName> = new Set([
  "write_file",
  "edit_file",
  "run_shell",
  "git_commit",
  "git_branch",
]);

/** A single diff hunk for display */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string; // unified diff text
}

/** SSE event discriminated union */
export type IdeStreamEvent =
  | { type: "text"; content: string }
  | { type: "status"; message: string }
  | { type: "tool_call"; id: string; tool: ToolName; args: Record<string, unknown>; requires_approval: boolean }
  | { type: "tool_result"; id: string; result?: string; error?: string }
  | { type: "diff"; file: string; hunks: DiffHunk[]; id: string }
  | { type: "shell_request"; id: string; command: string }
  | { type: "shell_output"; id: string; stdout: string; stderr: string; exit_code: number }
  | { type: "plan"; steps: PlanStep[]; status: "proposed" | "approved" | "executing" }
  | { type: "done" };

export interface PlanStep {
  index: number;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
}

/** Tool definitions for the LLM system prompt */
export interface ToolDefinition {
  name: ToolName;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read the contents of a file. Returns the file content as a string.",
    parameters: {
      path: { type: "string", description: "Relative path from project root", required: true },
      start_line: { type: "number", description: "Optional start line (1-indexed)" },
      end_line: { type: "number", description: "Optional end line (1-indexed)" },
    },
  },
  {
    name: "list_directory",
    description: "List files and directories. Returns entries with name, type (file/dir), and size.",
    parameters: {
      path: { type: "string", description: "Relative directory path from project root. Use '.' for root." },
      pattern: { type: "string", description: "Optional glob pattern to filter (e.g. '*.ts')" },
    },
  },
  {
    name: "search_files",
    description: "Search for text across project files using regex. Returns matching lines with file paths and line numbers.",
    parameters: {
      pattern: { type: "string", description: "Regex pattern to search for", required: true },
      path: { type: "string", description: "Optional subdirectory to search within" },
      include: { type: "string", description: "Optional glob to filter files (e.g. '*.ts')" },
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content.",
    parameters: {
      path: { type: "string", description: "Relative path from project root", required: true },
      content: { type: "string", description: "Full file content to write", required: true },
    },
  },
  {
    name: "edit_file",
    description: "Apply a targeted edit to a file by replacing old_string with new_string. The old_string must be unique in the file.",
    parameters: {
      path: { type: "string", description: "Relative path from project root", required: true },
      old_string: { type: "string", description: "Exact text to find and replace", required: true },
      new_string: { type: "string", description: "Replacement text", required: true },
    },
  },
  {
    name: "run_shell",
    description: "Execute a shell command in the project directory. Returns stdout, stderr, and exit code.",
    parameters: {
      command: { type: "string", description: "Shell command to execute", required: true },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
    },
  },
  {
    name: "git_status",
    description: "Show git working tree status. Returns modified, staged, and untracked files.",
    parameters: {},
  },
  {
    name: "git_diff",
    description: "Show git diff of changes. Defaults to unstaged changes.",
    parameters: {
      staged: { type: "boolean", description: "If true, show staged (--cached) changes" },
      file: { type: "string", description: "Optional specific file to diff" },
    },
  },
  {
    name: "git_log",
    description: "Show recent git commit log.",
    parameters: {
      count: { type: "number", description: "Number of commits to show (default: 10)" },
    },
  },
  {
    name: "git_commit",
    description: "Stage files and create a git commit.",
    parameters: {
      message: { type: "string", description: "Commit message", required: true },
      files: { type: "string[]", description: "Files to stage. Use ['.'] for all changes.", required: true },
    },
  },
  {
    name: "git_branch",
    description: "Create or switch to a git branch.",
    parameters: {
      name: { type: "string", description: "Branch name", required: true },
      create: { type: "boolean", description: "If true, create the branch (default: false)" },
    },
  },
];
```

**Step 2: Verify the file compiles**

Run: `npx tsc --noEmit src/apps/ide/tool-types.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add src/apps/ide/tool-types.ts
git commit -m "feat(ide): add tool type definitions and SSE event protocol"
```

---

## Task 2: Add Tauri commands for project filesystem and shell access

Add Rust commands to the Tauri backend that let the agent process read/write files, list directories, search, run shell commands, and execute git operations — all sandboxed to a user-selected project directory.

**Files:**
- Modify: `desktop/src-tauri/src/main.rs`
- Modify: `desktop/src-tauri/Cargo.toml` (add `glob` crate)
- Modify: `desktop/src-tauri/capabilities/default.json` (add dialog permission)

**Step 1: Add the `glob` dependency to Cargo.toml**

In `desktop/src-tauri/Cargo.toml`, add to `[dependencies]`:

```toml
glob = "0.3"
tauri-plugin-dialog = "2"
```

**Step 2: Add Tauri commands to main.rs**

At the top of `main.rs`, add imports:

```rust
use std::fs;
use std::io::Write as IoWrite;
use glob::glob;
```

Add a managed state struct for the active project root:

```rust
struct ProjectRoot(Arc<Mutex<Option<PathBuf>>>);
```

Add these Tauri commands after `get_local_token`:

```rust
#[derive(Serialize)]
struct DirEntry {
    name: String,
    entry_type: String, // "file" or "dir"
    size: u64,
}

#[tauri::command]
fn set_project_root(path: String, state: tauri::State<'_, ProjectRoot>) -> Result<bool, String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    *guard = Some(p);
    Ok(true)
}

#[tauri::command]
fn get_project_root(state: tauri::State<'_, ProjectRoot>) -> Option<String> {
    let guard = state.0.lock().ok()?;
    guard.as_ref().map(|p| p.to_string_lossy().to_string())
}

fn resolve_project_path(root: &PathBuf, relative: &str) -> Result<PathBuf, String> {
    let resolved = root.join(relative).canonicalize().map_err(|e| e.to_string())?;
    if !resolved.starts_with(root) {
        return Err("Path escapes project root".to_string());
    }
    Ok(resolved)
}

#[tauri::command]
fn project_read_file(
    path: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let root = guard.as_ref().ok_or("No project open")?;
    let full = resolve_project_path(root, &path)?;
    let content = fs::read_to_string(&full).map_err(|e| e.to_string())?;

    match (start_line, end_line) {
        (Some(start), Some(end)) => {
            let lines: Vec<&str> = content.lines().collect();
            let s = start.saturating_sub(1).min(lines.len());
            let e = end.min(lines.len());
            Ok(lines[s..e].join("\n"))
        }
        (Some(start), None) => {
            let lines: Vec<&str> = content.lines().collect();
            let s = start.saturating_sub(1).min(lines.len());
            Ok(lines[s..].join("\n"))
        }
        _ => Ok(content),
    }
}

#[tauri::command]
fn project_write_file(
    path: String,
    content: String,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<bool, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let root = guard.as_ref().ok_or("No project open")?;
    let full = root.join(&path);
    // Verify it doesn't escape root after normalization
    if let Ok(canonical_root) = root.canonicalize() {
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let canonical = full.canonicalize().unwrap_or_else(|_| full.clone());
        if !canonical.starts_with(&canonical_root) && !full.starts_with(root) {
            return Err("Path escapes project root".to_string());
        }
    }
    let mut f = fs::File::create(&full).map_err(|e| e.to_string())?;
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn project_list_dir(
    path: String,
    pattern: Option<String>,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<Vec<DirEntry>, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let root = guard.as_ref().ok_or("No project open")?;
    let dir = resolve_project_path(root, &path)?;

    let mut entries = Vec::new();

    if let Some(pat) = pattern {
        let glob_pattern = dir.join(&pat).to_string_lossy().to_string();
        for entry in glob(&glob_pattern).map_err(|e| e.to_string())? {
            if let Ok(p) = entry {
                let meta = fs::metadata(&p).ok();
                entries.push(DirEntry {
                    name: p.strip_prefix(root).unwrap_or(&p).to_string_lossy().to_string(),
                    entry_type: if p.is_dir() { "dir".into() } else { "file".into() },
                    size: meta.map(|m| m.len()).unwrap_or(0),
                });
            }
        }
    } else {
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let meta = entry.metadata().ok();
            entries.push(DirEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                entry_type: if entry.path().is_dir() { "dir".into() } else { "file".into() },
                size: meta.map(|m| m.len()).unwrap_or(0),
            });
        }
    }

    Ok(entries)
}

#[derive(Serialize)]
struct SearchMatch {
    file: String,
    line: usize,
    content: String,
}

#[tauri::command]
fn project_search(
    pattern: String,
    path: Option<String>,
    include: Option<String>,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<Vec<SearchMatch>, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let root = guard.as_ref().ok_or("No project open")?;
    let search_dir = if let Some(p) = &path {
        resolve_project_path(root, p)?
    } else {
        root.clone()
    };

    // Use grep via shell for regex support
    let mut cmd = Command::new("grep");
    cmd.arg("-rn")
       .arg("--include").arg(include.as_deref().unwrap_or("*"))
       .arg("-E")
       .arg(&pattern)
       .arg(&search_dir);

    let output = cmd.output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut matches = Vec::new();
    for line in stdout.lines().take(100) {
        // grep output: path:line_number:content
        let parts: Vec<&str> = line.splitn(3, ':').collect();
        if parts.len() >= 3 {
            let file_path = PathBuf::from(parts[0]);
            matches.push(SearchMatch {
                file: file_path.strip_prefix(root).unwrap_or(&file_path).to_string_lossy().to_string(),
                line: parts[1].parse().unwrap_or(0),
                content: parts[2].to_string(),
            });
        }
    }
    Ok(matches)
}

#[derive(Serialize)]
struct ShellResult {
    stdout: String,
    stderr: String,
    exit_code: i32,
}

#[tauri::command]
fn project_run_shell(
    command: String,
    timeout_ms: Option<u64>,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<ShellResult, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let root = guard.as_ref().ok_or("No project open")?;

    let output = Command::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(root)
        .output()
        .map_err(|e| e.to_string())?;

    Ok(ShellResult {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

#[tauri::command]
fn project_git_status(state: tauri::State<'_, ProjectRoot>) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let root = guard.as_ref().ok_or("No project open")?;
    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(root)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
fn project_git_diff(
    staged: Option<bool>,
    file: Option<String>,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let root = guard.as_ref().ok_or("No project open")?;
    let mut args = vec!["diff".to_string()];
    if staged.unwrap_or(false) { args.push("--cached".to_string()); }
    if let Some(f) = file { args.push(f); }
    let output = Command::new("git")
        .args(&args)
        .current_dir(root)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
fn project_git_log(
    count: Option<usize>,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let root = guard.as_ref().ok_or("No project open")?;
    let n = count.unwrap_or(10).to_string();
    let output = Command::new("git")
        .args(["log", "--oneline", "-n", &n])
        .current_dir(root)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
fn project_git_commit(
    message: String,
    files: Vec<String>,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let root = guard.as_ref().ok_or("No project open")?;

    // Stage files
    let mut add_args = vec!["add".to_string()];
    add_args.extend(files);
    Command::new("git")
        .args(&add_args)
        .current_dir(root)
        .output()
        .map_err(|e| e.to_string())?;

    // Commit
    let output = Command::new("git")
        .args(["commit", "-m", &message])
        .current_dir(root)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[tauri::command]
fn project_git_branch(
    name: String,
    create: Option<bool>,
    state: tauri::State<'_, ProjectRoot>,
) -> Result<String, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let root = guard.as_ref().ok_or("No project open")?;

    let args = if create.unwrap_or(false) {
        vec!["checkout", "-b", &name]
    } else {
        vec!["checkout", &name]
    };

    let output = Command::new("git")
        .args(&args)
        .current_dir(root)
        .output()
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}
```

**Step 3: Register new commands and state in `main()`**

In the `tauri::Builder` chain, update `.manage()` and `.invoke_handler()`:

```rust
    .manage(ProjectRoot(Arc::new(Mutex::new(None))))
    .manage(LocalToken(local_token.clone()))
    .invoke_handler(tauri::generate_handler![
        get_system_metrics,
        get_local_token,
        set_project_root,
        get_project_root,
        project_read_file,
        project_write_file,
        project_list_dir,
        project_search,
        project_run_shell,
        project_git_status,
        project_git_diff,
        project_git_log,
        project_git_commit,
        project_git_branch,
    ])
```

Also add the dialog plugin:

```rust
    .plugin(tauri_plugin_dialog::init())
```

**Step 4: Update capabilities**

In `desktop/src-tauri/capabilities/default.json`, add:

```json
"dialog:default"
```

to the permissions array.

**Step 5: Verify compilation**

Run: `cd desktop/src-tauri && cargo check`
Expected: Compiles without errors

**Step 6: Commit**

```bash
git add desktop/src-tauri/src/main.rs desktop/src-tauri/Cargo.toml desktop/src-tauri/capabilities/default.json
git commit -m "feat(tauri): add project filesystem, shell, and git commands"
```

---

## Task 3: Add project tools HTTP bridge on the IDE provider server

The agent process (IDE provider on :4304) can't call Tauri commands directly — it's a separate Node.js process. Create an HTTP bridge: the desktop Svelte app exposes project tool operations via fetch calls to Tauri commands, and the agent calls these through a localhost HTTP endpoint that the desktop app serves.

Actually, a simpler approach: the agent process executes tool operations directly using Node.js `fs`, `child_process`, and the project root path. The Tauri commands we built in Task 2 are for direct frontend use (e.g., "Open Project" dialog). The agent just needs the project root path, which the frontend sends when starting a chat session.

**Files:**
- Create: `src/apps/ide/tool-executor.ts`

**Step 1: Create the tool executor**

```typescript
// src/apps/ide/tool-executor.ts
// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { execSync, spawn } from "node:child_process";
import { join, resolve, relative } from "node:path";
import { existsSync } from "node:fs";
import type { ToolName } from "./tool-types.js";

export interface ToolResult {
  result?: string;
  error?: string;
}

export class ToolExecutor {
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
  }

  private resolvePath(relativePath: string): string {
    const full = resolve(this.projectRoot, relativePath);
    if (!full.startsWith(this.projectRoot)) {
      throw new Error("Path escapes project root");
    }
    return full;
  }

  async execute(tool: ToolName, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (tool) {
        case "read_file":
          return await this.readFile(args);
        case "list_directory":
          return await this.listDirectory(args);
        case "search_files":
          return await this.searchFiles(args);
        case "write_file":
          return await this.writeFile(args);
        case "edit_file":
          return await this.editFile(args);
        case "run_shell":
          return await this.runShell(args);
        case "git_status":
          return await this.gitStatus();
        case "git_diff":
          return await this.gitDiff(args);
        case "git_log":
          return await this.gitLog(args);
        case "git_commit":
          return await this.gitCommit(args);
        case "git_branch":
          return await this.gitBranch(args);
        default:
          return { error: `Unknown tool: ${tool}` };
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async readFile(args: Record<string, unknown>): Promise<ToolResult> {
    const path = this.resolvePath(args.path as string);
    const content = await readFile(path, "utf-8");
    const startLine = args.start_line as number | undefined;
    const endLine = args.end_line as number | undefined;

    if (startLine || endLine) {
      const lines = content.split("\n");
      const s = (startLine ?? 1) - 1;
      const e = endLine ?? lines.length;
      const numbered = lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`);
      return { result: numbered.join("\n") };
    }

    // Add line numbers
    const numbered = content.split("\n").map((l, i) => `${i + 1}: ${l}`);
    return { result: numbered.join("\n") };
  }

  private async listDirectory(args: Record<string, unknown>): Promise<ToolResult> {
    const dirPath = this.resolvePath((args.path as string) || ".");
    const entries = await readdir(dirPath, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue; // skip dotfiles by default
      const type = entry.isDirectory() ? "dir" : "file";
      if (type === "file") {
        try {
          const s = await stat(join(dirPath, entry.name));
          results.push(`${type}\t${entry.name}\t${s.size}`);
        } catch {
          results.push(`${type}\t${entry.name}\t0`);
        }
      } else {
        results.push(`${type}\t${entry.name}`);
      }
    }

    return { result: results.join("\n") || "(empty directory)" };
  }

  private async searchFiles(args: Record<string, unknown>): Promise<ToolResult> {
    const pattern = args.pattern as string;
    const searchPath = args.path ? this.resolvePath(args.path as string) : this.projectRoot;
    const include = (args.include as string) || "*";

    try {
      const result = execSync(
        `grep -rn --include='${include}' -E '${pattern.replace(/'/g, "'\\''")}' .`,
        { cwd: searchPath, maxBuffer: 1024 * 1024, timeout: 10_000 },
      ).toString();

      // Limit output
      const lines = result.split("\n").slice(0, 50);
      return { result: lines.join("\n") };
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer; status?: number };
      if (e.status === 1) return { result: "(no matches)" };
      return { error: String(err) };
    }
  }

  private async writeFile(args: Record<string, unknown>): Promise<ToolResult> {
    const path = args.path as string;
    const full = join(this.projectRoot, path);
    // Sandbox check
    if (!resolve(full).startsWith(this.projectRoot)) {
      return { error: "Path escapes project root" };
    }
    const dir = join(full, "..");
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(full, args.content as string, "utf-8");
    return { result: `Wrote ${path}` };
  }

  private async editFile(args: Record<string, unknown>): Promise<ToolResult> {
    const path = this.resolvePath(args.path as string);
    const content = await readFile(path, "utf-8");
    const oldStr = args.old_string as string;
    const newStr = args.new_string as string;

    const idx = content.indexOf(oldStr);
    if (idx === -1) return { error: `old_string not found in ${args.path}` };
    // Check uniqueness
    if (content.indexOf(oldStr, idx + 1) !== -1) {
      return { error: `old_string appears multiple times in ${args.path} — provide more context` };
    }

    const updated = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
    await writeFile(path, updated, "utf-8");
    return { result: `Edited ${args.path}` };
  }

  private async runShell(args: Record<string, unknown>): Promise<ToolResult> {
    const cmd = args.command as string;
    const timeout = (args.timeout_ms as number) || 30_000;

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      const proc = spawn("sh", ["-c", cmd], {
        cwd: this.projectRoot,
        timeout,
      });
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        resolve({
          result: JSON.stringify({
            stdout: stdout.slice(0, 10_000),
            stderr: stderr.slice(0, 5_000),
            exit_code: code ?? -1,
          }),
        });
      });
      proc.on("error", (err) => {
        resolve({ error: err.message });
      });
    });
  }

  private async gitStatus(): Promise<ToolResult> {
    try {
      const result = execSync("git status --porcelain", {
        cwd: this.projectRoot,
        timeout: 5_000,
      }).toString();
      return { result: result || "(clean working tree)" };
    } catch (err) {
      return { error: String(err) };
    }
  }

  private async gitDiff(args: Record<string, unknown>): Promise<ToolResult> {
    const parts = ["git", "diff"];
    if (args.staged) parts.push("--cached");
    if (args.file) parts.push(args.file as string);
    try {
      const result = execSync(parts.join(" "), {
        cwd: this.projectRoot,
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }).toString();
      return { result: result || "(no changes)" };
    } catch (err) {
      return { error: String(err) };
    }
  }

  private async gitLog(args: Record<string, unknown>): Promise<ToolResult> {
    const count = (args.count as number) || 10;
    try {
      const result = execSync(`git log --oneline -n ${count}`, {
        cwd: this.projectRoot,
        timeout: 5_000,
      }).toString();
      return { result: result || "(no commits)" };
    } catch (err) {
      return { error: String(err) };
    }
  }

  private async gitCommit(args: Record<string, unknown>): Promise<ToolResult> {
    const message = args.message as string;
    const files = args.files as string[];
    try {
      execSync(`git add ${files.join(" ")}`, { cwd: this.projectRoot, timeout: 5_000 });
      const result = execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
        cwd: this.projectRoot,
        timeout: 10_000,
      }).toString();
      return { result };
    } catch (err) {
      return { error: String(err) };
    }
  }

  private async gitBranch(args: Record<string, unknown>): Promise<ToolResult> {
    const name = args.name as string;
    const create = args.create as boolean;
    const cmd = create ? `git checkout -b "${name}"` : `git checkout "${name}"`;
    try {
      const result = execSync(cmd, { cwd: this.projectRoot, timeout: 5_000 }).toString();
      return { result: result || `Switched to ${name}` };
    } catch (err) {
      return { error: String(err) };
    }
  }
}
```

**Step 2: Verify compilation**

Run: `npx tsc --noEmit src/apps/ide/tool-executor.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add src/apps/ide/tool-executor.ts
git commit -m "feat(ide): add tool executor for filesystem, shell, and git ops"
```

---

## Task 4: Add agentic chat endpoint to IDE provider server

Add a new `/v1/ide/chat` endpoint to the IDE provider server that runs an agentic tool-use loop. The LLM gets tool definitions in its system prompt, emits tool calls, the server executes them (or pauses for approval), feeds results back, and streams the entire interaction to the frontend as extended SSE events.

**Files:**
- Modify: `src/apps/ide/provider-server.ts`
- Modify: `src/model/system-prompt.ts` (add tool definitions to system prompt)

**Step 1: Update system prompt to include tool definitions**

In `src/model/system-prompt.ts`, add a new function after `buildChatSystemPrompt`:

```typescript
import { TOOL_DEFINITIONS, type ToolDefinition } from "../apps/ide/tool-types.js";

export function buildIdeAgentSystemPrompt(ctx: SystemPromptContext, projectRoot: string): string {
  const base = buildChatSystemPrompt(ctx);

  const toolDocs = TOOL_DEFINITIONS.map((t) => {
    const params = Object.entries(t.parameters)
      .map(([k, v]) => `    ${k}: ${v.type} — ${v.description}${v.required ? " (required)" : ""}`)
      .join("\n");
    return `- ${t.name}: ${t.description}\n  Parameters:\n${params || "    (none)"}`;
  }).join("\n\n");

  return `${base}

--- IDE Agent Mode ---
You have access to the user's project at: ${projectRoot}

You can use tools to read files, edit code, run commands, and manage git.
To use a tool, respond with a JSON tool call block:

\`\`\`tool_call
{"tool": "<tool_name>", "args": {<arguments>}}
\`\`\`

Available tools:

${toolDocs}

Rules:
1. Read files before editing them — understand existing code first.
2. Make targeted edits with edit_file, not full file rewrites with write_file.
3. After making changes, run relevant tests to verify.
4. When asked to plan, output a plan block before executing:
\`\`\`plan
[{"description": "Step 1: ..."},{"description": "Step 2: ..."}]
\`\`\`
5. Explain what you're doing and why as you go.
6. Never execute destructive operations (rm -rf, force push) without explicit user request.`;
}
```

**Step 2: Add agentic chat endpoint to provider-server**

In `src/apps/ide/provider-server.ts`, add imports at the top:

```typescript
import { ToolExecutor } from "./tool-executor.js";
import { READ_TOOLS, type ToolName, type IdeStreamEvent } from "./tool-types.js";
import { buildIdeAgentSystemPrompt } from "../../model/system-prompt.js";
```

Add a project root state and approval queue:

```typescript
let activeProjectRoot: string | null = null;
const pendingApprovals = new Map<string, {
  resolve: (approved: boolean) => void;
  tool: ToolName;
  args: Record<string, unknown>;
}>();
```

Add the project management endpoints:

```typescript
app.post("/v1/ide/project", async (req, reply) => {
  const body = z.object({ projectRoot: z.string().min(1) }).parse(req.body);
  activeProjectRoot = body.projectRoot;
  return reply.send({ ok: true, projectRoot: activeProjectRoot });
});

app.get("/v1/ide/project", async (_req, reply) => {
  return reply.send({ projectRoot: activeProjectRoot });
});

app.post("/v1/ide/tool-approval", async (req, reply) => {
  const body = z.object({ id: z.string(), approved: z.boolean() }).parse(req.body);
  const pending = pendingApprovals.get(body.id);
  if (!pending) return reply.code(404).send({ error: "no_pending_approval" });
  pending.resolve(body.approved);
  pendingApprovals.delete(body.id);
  return reply.send({ ok: true });
});
```

Add the agentic chat endpoint:

```typescript
app.post("/v1/ide/chat", async (req, reply) => {
  const body = z.object({
    messages: z.array(z.object({ role: z.string(), content: z.string() })).min(1),
    model: z.string().optional(),
    projectRoot: z.string().optional(),
  }).parse(req.body);

  const projectRoot = body.projectRoot || activeProjectRoot;
  if (!projectRoot) {
    return reply.code(400).send({ error: "no_project_open", message: "Open a project first" });
  }

  const executor = new ToolExecutor(projectRoot);

  // Build system prompt with tool definitions
  let systemPrompt: string;
  try {
    const tags = await ollamaTags().catch(() => ({ models: [] }));
    const activeModel = body.model || process.env.OLLAMA_MODEL || "qwen2.5:7b";
    const ctx = {
      activeModel,
      activeModelParamSize: 0,
      installedModels: tags.models.map((m: { name: string; details: { parameter_size: string } }) => ({
        name: m.name,
        paramSize: parseFloat(m.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0"),
      })),
      swarmModels: [],
      ollamaHealthy: true,
      queueDepth: 0,
      connectedAgents: 0,
    };
    systemPrompt = buildIdeAgentSystemPrompt(ctx, projectRoot);
  } catch {
    systemPrompt = `You are EdgeCoder IDE agent. Project root: ${projectRoot}`;
  }

  // Set up SSE stream
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  function sendEvent(event: IdeStreamEvent): void {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  // Build messages array with system prompt
  const messages = [
    { role: "system", content: systemPrompt },
    ...body.messages,
  ];

  const ollamaHost = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const chatModel = body.model || process.env.OLLAMA_MODEL || "qwen2.5:7b";

  // Agentic loop: call LLM, parse tool calls, execute, feed back, repeat
  const MAX_ITERATIONS = 20;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    sendEvent({ type: "status", message: iter === 0 ? "Thinking..." : "Continuing..." });

    // Call Ollama (non-streaming to parse full response for tool calls)
    let llmResponse: string;
    try {
      const { request } = await import("undici");
      const res = await request(`${ollamaHost}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: chatModel,
          messages,
          stream: false,
          options: { temperature: 0.3, num_predict: 4096 },
        }),
        headersTimeout: 120_000,
        bodyTimeout: 120_000,
      });
      const data = await res.body.json() as { message?: { content?: string } };
      llmResponse = data.message?.content ?? "";
    } catch (err) {
      sendEvent({ type: "text", content: `Error calling model: ${err instanceof Error ? err.message : String(err)}` });
      break;
    }

    // Parse response for tool_call blocks
    const toolCallRegex = /```tool_call\s*\n([\s\S]*?)\n```/g;
    const planRegex = /```plan\s*\n([\s\S]*?)\n```/g;
    let hasToolCalls = false;

    // Extract text before/between/after tool calls
    let lastIndex = 0;
    const allMatches: Array<{ index: number; end: number; type: "tool" | "plan"; content: string }> = [];

    let match: RegExpExecArray | null;
    while ((match = toolCallRegex.exec(llmResponse)) !== null) {
      allMatches.push({ index: match.index, end: match.index + match[0].length, type: "tool", content: match[1] });
    }
    while ((match = planRegex.exec(llmResponse)) !== null) {
      allMatches.push({ index: match.index, end: match.index + match[0].length, type: "plan", content: match[1] });
    }

    allMatches.sort((a, b) => a.index - b.index);

    for (const m of allMatches) {
      // Send text before this match
      const textBefore = llmResponse.slice(lastIndex, m.index).trim();
      if (textBefore) sendEvent({ type: "text", content: textBefore });
      lastIndex = m.end;

      if (m.type === "plan") {
        try {
          const steps = JSON.parse(m.content) as Array<{ description: string }>;
          sendEvent({
            type: "plan",
            steps: steps.map((s, i) => ({ index: i, description: s.description, status: "pending" as const })),
            status: "proposed",
          });
        } catch {
          sendEvent({ type: "text", content: m.content });
        }
        continue;
      }

      // Tool call
      hasToolCalls = true;
      try {
        const call = JSON.parse(m.content) as { tool: ToolName; args: Record<string, unknown> };
        const toolId = `tc_${randomUUID().slice(0, 8)}`;
        const isRead = READ_TOOLS.has(call.tool);

        sendEvent({
          type: "tool_call",
          id: toolId,
          tool: call.tool,
          args: call.args,
          requires_approval: !isRead,
        });

        // For write tools, wait for approval
        if (!isRead) {
          const approved = await new Promise<boolean>((resolve) => {
            pendingApprovals.set(toolId, { resolve, tool: call.tool, args: call.args });
            // Auto-timeout after 5 minutes
            setTimeout(() => {
              if (pendingApprovals.has(toolId)) {
                pendingApprovals.delete(toolId);
                resolve(false);
              }
            }, 300_000);
          });

          if (!approved) {
            sendEvent({ type: "tool_result", id: toolId, error: "User rejected this action" });
            messages.push({ role: "assistant", content: llmResponse });
            messages.push({ role: "user", content: `Tool ${call.tool} was rejected by the user. Adapt your approach.` });
            continue;
          }
        }

        // Execute the tool
        const result = await executor.execute(call.tool, call.args);

        // For shell commands, send structured output
        if (call.tool === "run_shell" && result.result) {
          try {
            const parsed = JSON.parse(result.result) as { stdout: string; stderr: string; exit_code: number };
            sendEvent({
              type: "shell_output",
              id: toolId,
              stdout: parsed.stdout,
              stderr: parsed.stderr,
              exit_code: parsed.exit_code,
            });
          } catch {
            sendEvent({ type: "tool_result", id: toolId, result: result.result, error: result.error });
          }
        } else {
          sendEvent({ type: "tool_result", id: toolId, result: result.result, error: result.error });
        }

        // Add to message history for next LLM call
        messages.push({ role: "assistant", content: llmResponse });
        messages.push({
          role: "user",
          content: `Tool result for ${call.tool}:\n${result.result ?? result.error ?? "(empty)"}`,
        });
      } catch (parseErr) {
        sendEvent({ type: "text", content: `Failed to parse tool call: ${m.content}` });
      }
    }

    // Send remaining text after last match
    const trailingText = llmResponse.slice(lastIndex).trim();
    if (trailingText) sendEvent({ type: "text", content: trailingText });

    // If no tool calls were made, we're done
    if (!hasToolCalls) {
      if (allMatches.length === 0) {
        // No matches at all — just add to history and break
        messages.push({ role: "assistant", content: llmResponse });
      }
      break;
    }
  }

  sendEvent({ type: "done" });
  reply.raw.end();
});
```

**Step 3: Verify compilation**

Run: `npx tsc --noEmit src/apps/ide/provider-server.ts`
Expected: No errors

**Step 4: Commit**

```bash
git add src/apps/ide/provider-server.ts src/model/system-prompt.ts
git commit -m "feat(ide): add agentic chat endpoint with tool-use loop"
```

---

## Task 5: Add ProjectBar component and project management to desktop API

Add the `ProjectBar.svelte` component (shows project path, "Open Project" button, git branch) and the API functions to open a project and send tool approvals.

**Files:**
- Create: `desktop/src/components/ProjectBar.svelte`
- Modify: `desktop/src/lib/api.ts` (add IDE project and approval functions)

**Step 1: Add API functions**

In `desktop/src/lib/api.ts`, add after the `streamChat` function:

```typescript
// ---------------------------------------------------------------------------
// IDE Agent (:4304)
// ---------------------------------------------------------------------------

export async function ideSetProject(projectRoot: string): Promise<void> {
  const base = import.meta.env.DEV ? "/chat" : "http://localhost:4304";
  await post(base, "/v1/ide/project", { projectRoot });
}

export async function ideGetProject(): Promise<string | null> {
  try {
    const base = import.meta.env.DEV ? "/chat" : "http://localhost:4304";
    const data = await get<{ projectRoot: string | null }>(base, "/v1/ide/project");
    return data.projectRoot;
  } catch {
    return null;
  }
}

export async function ideSendToolApproval(id: string, approved: boolean): Promise<void> {
  const base = import.meta.env.DEV ? "/chat" : "http://localhost:4304";
  await post(base, "/v1/ide/tool-approval", { id, approved });
}

export interface IdeStreamEvent {
  type: "text" | "status" | "tool_call" | "tool_result" | "diff" | "shell_request" | "shell_output" | "plan" | "done";
  [key: string]: unknown;
}

export async function streamIdeChat(
  messages: Array<{ role: string; content: string }>,
  projectRoot: string,
  onEvent: (event: IdeStreamEvent) => void,
  signal?: AbortSignal,
  requestedModel?: string,
): Promise<void> {
  const base = import.meta.env.DEV ? "/chat" : "http://localhost:4304";
  const res = await fetch(`${base}/v1/ide/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      model: requestedModel,
      projectRoot,
    }),
    signal,
  });

  if (!res.ok) throw new Error(`IDE chat request failed: ${res.status}`);
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;

      try {
        const event = JSON.parse(data) as IdeStreamEvent;
        onEvent(event);
      } catch {
        // Skip malformed events
      }
    }
  }
}
```

**Step 2: Create ProjectBar component**

```svelte
<!-- desktop/src/components/ProjectBar.svelte -->
<script lang="ts">
  interface Props {
    projectRoot: string | null;
    gitBranch: string | null;
    onOpenProject: () => void;
  }
  let { projectRoot, gitBranch, onOpenProject }: Props = $props();

  let displayPath = $derived(
    projectRoot
      ? projectRoot.replace(/^\/Users\/\w+/, "~")
      : null
  );
</script>

<div class="project-bar">
  {#if projectRoot}
    <span class="project-path" title={projectRoot}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      {displayPath}
    </span>
    {#if gitBranch}
      <span class="git-branch" title="Current branch">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="6" y1="3" x2="6" y2="15"/>
          <circle cx="18" cy="6" r="3"/>
          <circle cx="6" cy="18" r="3"/>
          <path d="M18 9a9 9 0 0 1-9 9"/>
        </svg>
        {gitBranch}
      </span>
    {/if}
    <button class="change-btn" onclick={onOpenProject}>Change</button>
  {:else}
    <button class="open-btn" onclick={onOpenProject}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      Open Project
    </button>
  {/if}
</div>

<style>
  .project-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 16px;
    background: var(--bg-surface);
    border-bottom: 0.5px solid var(--border);
    font-size: 12px;
    color: var(--text-secondary);
    flex-shrink: 0;
  }
  .project-path {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 300px;
  }
  .git-branch {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    background: var(--bg-elevated);
    border-radius: 999px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--accent);
  }
  .open-btn, .change-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border: 0.5px solid var(--border-strong);
    background: var(--bg-elevated);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 12px;
    transition: all 0.15s;
  }
  .open-btn:hover, .change-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .change-btn {
    margin-left: auto;
    padding: 2px 8px;
    font-size: 11px;
  }
</style>
```

**Step 3: Verify desktop compilation**

Run: `cd desktop && npm run build`
Expected: Compiles (ignore pre-existing `@tauri-apps/plugin-shell` warning)

**Step 4: Commit**

```bash
git add desktop/src/components/ProjectBar.svelte desktop/src/lib/api.ts
git commit -m "feat(desktop): add ProjectBar component and IDE agent API functions"
```

---

## Task 6: Add ToolCallBlock, DiffBlock, ShellBlock, and PlanBlock components

Create the four Svelte components that render inline tool-use events in the chat.

**Files:**
- Create: `desktop/src/components/ToolCallBlock.svelte`
- Create: `desktop/src/components/DiffBlock.svelte`
- Create: `desktop/src/components/ShellBlock.svelte`
- Create: `desktop/src/components/PlanBlock.svelte`

**Step 1: Create ToolCallBlock**

```svelte
<!-- desktop/src/components/ToolCallBlock.svelte -->
<script lang="ts">
  interface Props {
    id: string;
    tool: string;
    args: Record<string, unknown>;
    requiresApproval: boolean;
    result?: string;
    error?: string;
    status: "pending" | "executing" | "completed" | "rejected";
    onApprove?: (id: string) => void;
    onReject?: (id: string) => void;
  }
  let { id, tool, args, requiresApproval, result, error, status, onApprove, onReject }: Props = $props();

  let expanded = $state(false);

  let summary = $derived(() => {
    const argStr = args.path ?? args.command ?? args.pattern ?? args.name ?? "";
    return `${tool}${argStr ? `: ${argStr}` : ""}`;
  });

  let statusColor = $derived(
    status === "completed" ? "var(--green)" :
    status === "rejected" ? "var(--red)" :
    status === "pending" && requiresApproval ? "var(--yellow)" :
    "var(--accent-secondary)"
  );
</script>

<div class="tool-block" style="--status-color: {statusColor}">
  <button class="tool-header" onclick={() => expanded = !expanded}>
    <span class="tool-indicator"></span>
    <span class="tool-summary">{summary()}</span>
    {#if status === "executing"}
      <span class="spinner"></span>
    {:else if status === "completed"}
      <span class="check">&#10003;</span>
    {:else if status === "rejected"}
      <span class="cross">&#10007;</span>
    {/if}
    <span class="chevron" class:open={expanded}>&#9656;</span>
  </button>

  {#if status === "pending" && requiresApproval}
    <div class="approval-bar">
      <span class="approval-label">Approve this action?</span>
      <button class="approve-btn" onclick={() => onApprove?.(id)}>Allow</button>
      <button class="reject-btn" onclick={() => onReject?.(id)}>Deny</button>
    </div>
  {/if}

  {#if expanded && (result || error)}
    <div class="tool-body">
      {#if error}
        <pre class="tool-error">{error}</pre>
      {:else if result}
        <pre class="tool-result">{result.length > 2000 ? result.slice(0, 2000) + "\n... (truncated)" : result}</pre>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tool-block {
    margin: 6px 0;
    border: 0.5px solid var(--border);
    border-left: 2px solid var(--status-color);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .tool-header {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    background: var(--bg-surface);
    border: none;
    color: var(--text-secondary);
    font-size: 12px;
    font-family: var(--font-mono);
    cursor: pointer;
    text-align: left;
  }
  .tool-header:hover {
    background: var(--bg-elevated);
  }
  .tool-indicator {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--status-color);
    flex-shrink: 0;
  }
  .tool-summary {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spinner {
    width: 12px;
    height: 12px;
    border: 1.5px solid var(--border-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .check { color: var(--green); font-size: 13px; }
  .cross { color: var(--red); font-size: 13px; }
  .chevron {
    font-size: 10px;
    transition: transform 0.15s;
    color: var(--text-muted);
  }
  .chevron.open { transform: rotate(90deg); }
  .approval-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: rgba(251, 191, 36, 0.06);
    border-top: 0.5px solid var(--border);
    font-size: 12px;
  }
  .approval-label {
    flex: 1;
    color: var(--yellow);
  }
  .approve-btn, .reject-btn {
    padding: 3px 12px;
    border-radius: 4px;
    border: 0.5px solid var(--border-strong);
    cursor: pointer;
    font-size: 11px;
    transition: all 0.15s;
  }
  .approve-btn {
    background: rgba(74, 222, 128, 0.1);
    color: var(--green);
    border-color: var(--green);
  }
  .approve-btn:hover { background: rgba(74, 222, 128, 0.2); }
  .reject-btn {
    background: rgba(248, 113, 113, 0.1);
    color: var(--red);
    border-color: var(--red);
  }
  .reject-btn:hover { background: rgba(248, 113, 113, 0.2); }
  .tool-body {
    border-top: 0.5px solid var(--border);
    max-height: 300px;
    overflow-y: auto;
  }
  .tool-result, .tool-error {
    margin: 0;
    padding: 8px 10px;
    font-size: 11px;
    font-family: var(--font-mono);
    white-space: pre-wrap;
    word-break: break-all;
    line-height: 1.5;
  }
  .tool-result { color: var(--text-secondary); }
  .tool-error { color: var(--red); background: rgba(248, 113, 113, 0.05); }
</style>
```

**Step 2: Create ShellBlock**

```svelte
<!-- desktop/src/components/ShellBlock.svelte -->
<script lang="ts">
  interface Props {
    id: string;
    command?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    status: "pending" | "approved" | "completed";
    onApprove?: (id: string) => void;
    onReject?: (id: string) => void;
  }
  let { id, command, stdout, stderr, exitCode, status, onApprove, onReject }: Props = $props();
</script>

<div class="shell-block">
  {#if command}
    <div class="shell-header">
      <span class="shell-prompt">$</span>
      <code class="shell-cmd">{command}</code>
      {#if status === "pending"}
        <button class="run-btn" onclick={() => onApprove?.(id)}>Run</button>
        <button class="deny-btn" onclick={() => onReject?.(id)}>Deny</button>
      {:else if status === "completed"}
        <span class="exit-code" class:success={exitCode === 0} class:fail={exitCode !== 0}>
          {exitCode === 0 ? "&#10003;" : `exit ${exitCode}`}
        </span>
      {/if}
    </div>
  {/if}
  {#if stdout || stderr}
    <div class="shell-output">
      {#if stdout}<pre class="stdout">{stdout}</pre>{/if}
      {#if stderr}<pre class="stderr">{stderr}</pre>{/if}
    </div>
  {/if}
</div>

<style>
  .shell-block {
    margin: 6px 0;
    border: 0.5px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--bg-deep);
  }
  .shell-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--bg-surface);
    border-bottom: 0.5px solid var(--border);
  }
  .shell-prompt {
    color: var(--green);
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 600;
  }
  .shell-cmd {
    flex: 1;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .run-btn, .deny-btn {
    padding: 2px 10px;
    border-radius: 4px;
    border: 0.5px solid var(--border-strong);
    cursor: pointer;
    font-size: 11px;
    transition: all 0.15s;
  }
  .run-btn {
    background: rgba(74, 222, 128, 0.1);
    color: var(--green);
    border-color: var(--green);
  }
  .run-btn:hover { background: rgba(74, 222, 128, 0.2); }
  .deny-btn {
    background: rgba(248, 113, 113, 0.1);
    color: var(--red);
    border-color: var(--red);
  }
  .deny-btn:hover { background: rgba(248, 113, 113, 0.2); }
  .exit-code { font-size: 12px; font-family: var(--font-mono); }
  .exit-code.success { color: var(--green); }
  .exit-code.fail { color: var(--red); }
  .shell-output {
    max-height: 300px;
    overflow-y: auto;
  }
  .stdout, .stderr {
    margin: 0;
    padding: 8px 10px;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .stdout { color: var(--text-secondary); }
  .stderr { color: var(--yellow); }
</style>
```

**Step 3: Create DiffBlock**

```svelte
<!-- desktop/src/components/DiffBlock.svelte -->
<script lang="ts">
  interface Props {
    id: string;
    file: string;
    hunks: Array<{ content: string }>;
    onAccept?: (id: string) => void;
    onReject?: (id: string) => void;
    status: "pending" | "accepted" | "rejected";
  }
  let { id, file, hunks, onAccept, onReject, status }: Props = $props();

  let diffLines = $derived(
    hunks.flatMap(h => h.content.split("\n")).map(line => ({
      text: line,
      type: line.startsWith("+") ? "add" as const :
            line.startsWith("-") ? "remove" as const :
            "context" as const,
    }))
  );
</script>

<div class="diff-block">
  <div class="diff-header">
    <span class="diff-file">{file}</span>
    {#if status === "pending"}
      <button class="accept-btn" onclick={() => onAccept?.(id)}>Accept</button>
      <button class="reject-btn" onclick={() => onReject?.(id)}>Reject</button>
    {:else if status === "accepted"}
      <span class="diff-status accepted">Applied</span>
    {:else}
      <span class="diff-status rejected">Rejected</span>
    {/if}
  </div>
  <div class="diff-content">
    {#each diffLines as line}
      <div class="diff-line {line.type}">{line.text}</div>
    {/each}
  </div>
</div>

<style>
  .diff-block {
    margin: 6px 0;
    border: 0.5px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .diff-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--bg-surface);
    border-bottom: 0.5px solid var(--border);
  }
  .diff-file {
    flex: 1;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-primary);
  }
  .accept-btn, .reject-btn {
    padding: 2px 10px;
    border-radius: 4px;
    border: 0.5px solid var(--border-strong);
    cursor: pointer;
    font-size: 11px;
    transition: all 0.15s;
  }
  .accept-btn {
    background: rgba(74, 222, 128, 0.1);
    color: var(--green);
    border-color: var(--green);
  }
  .accept-btn:hover { background: rgba(74, 222, 128, 0.2); }
  .reject-btn {
    background: rgba(248, 113, 113, 0.1);
    color: var(--red);
    border-color: var(--red);
  }
  .reject-btn:hover { background: rgba(248, 113, 113, 0.2); }
  .diff-status { font-size: 11px; font-family: var(--font-mono); }
  .diff-status.accepted { color: var(--green); }
  .diff-status.rejected { color: var(--red); }
  .diff-content {
    max-height: 400px;
    overflow-y: auto;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.5;
  }
  .diff-line {
    padding: 0 10px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .diff-line.add { background: rgba(74, 222, 128, 0.08); color: var(--green); }
  .diff-line.remove { background: rgba(248, 113, 113, 0.08); color: var(--red); }
  .diff-line.context { color: var(--text-muted); }
</style>
```

**Step 4: Create PlanBlock**

```svelte
<!-- desktop/src/components/PlanBlock.svelte -->
<script lang="ts">
  interface PlanStep {
    index: number;
    description: string;
    status: "pending" | "in_progress" | "completed" | "failed";
  }

  interface Props {
    steps: PlanStep[];
    planStatus: "proposed" | "approved" | "executing";
  }
  let { steps, planStatus }: Props = $props();
</script>

<div class="plan-block">
  <div class="plan-header">
    <span class="plan-title">Plan</span>
    <span class="plan-status">{planStatus}</span>
  </div>
  <div class="plan-steps">
    {#each steps as step}
      <div class="plan-step" class:completed={step.status === "completed"} class:active={step.status === "in_progress"} class:failed={step.status === "failed"}>
        <span class="step-indicator">
          {#if step.status === "completed"}
            &#10003;
          {:else if step.status === "in_progress"}
            &#9654;
          {:else if step.status === "failed"}
            &#10007;
          {:else}
            {step.index + 1}
          {/if}
        </span>
        <span class="step-desc">{step.description}</span>
      </div>
    {/each}
  </div>
</div>

<style>
  .plan-block {
    margin: 6px 0;
    border: 0.5px solid var(--border);
    border-left: 2px solid var(--accent);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .plan-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    background: var(--bg-surface);
    border-bottom: 0.5px solid var(--border);
  }
  .plan-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
  }
  .plan-status {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .plan-steps {
    padding: 6px 0;
  }
  .plan-step {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 4px 10px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .plan-step.completed { color: var(--green); }
  .plan-step.active { color: var(--accent); }
  .plan-step.failed { color: var(--red); }
  .step-indicator {
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: var(--bg-elevated);
    font-size: 10px;
    flex-shrink: 0;
    font-family: var(--font-mono);
  }
  .plan-step.completed .step-indicator { background: rgba(74, 222, 128, 0.15); }
  .plan-step.active .step-indicator { background: rgba(193, 120, 80, 0.15); }
  .plan-step.failed .step-indicator { background: rgba(248, 113, 113, 0.15); }
  .step-desc { line-height: 18px; }
</style>
```

**Step 5: Verify compilation**

Run: `cd desktop && npm run build`
Expected: Compiles

**Step 6: Commit**

```bash
git add desktop/src/components/ToolCallBlock.svelte desktop/src/components/DiffBlock.svelte desktop/src/components/ShellBlock.svelte desktop/src/components/PlanBlock.svelte
git commit -m "feat(desktop): add ToolCallBlock, DiffBlock, ShellBlock, and PlanBlock components"
```

---

## Task 7: Wire up ChatView to render IDE stream events

Update `ChatView.svelte` to use the IDE agent endpoint when a project is open. Parse extended SSE events and render the new tool block components inline in the conversation.

**Files:**
- Modify: `desktop/src/pages/ChatView.svelte`
- Modify: `desktop/src/lib/types.ts` (extend ChatMessage with tool events)

**Step 1: Extend ChatMessage type**

In `desktop/src/lib/types.ts`, update the `ChatMessage` interface:

```typescript
export interface ToolEvent {
  type: "tool_call" | "tool_result" | "shell_request" | "shell_output" | "diff" | "plan" | "status";
  id?: string;
  tool?: string;
  args?: Record<string, unknown>;
  requires_approval?: boolean;
  result?: string;
  error?: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  file?: string;
  hunks?: Array<{ content: string }>;
  steps?: Array<{ index: number; description: string; status: string }>;
  plan_status?: string;
  message?: string;
  approval_status?: "pending" | "approved" | "rejected";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  /** IDE agent tool events attached to this message */
  toolEvents?: ToolEvent[];
}
```

**Step 2: Update ChatView.svelte**

This is the biggest change. Update `ChatView.svelte` to:

1. Import `ProjectBar` and the new API functions
2. Track `projectRoot` state
3. When a project is open, use `streamIdeChat` instead of `streamChat`
4. Parse IDE events into `toolEvents` on the streaming message
5. Handle approval callbacks

Add these imports to the `<script>` section:

```typescript
import ProjectBar from "../components/ProjectBar.svelte";
import {
  streamIdeChat,
  ideSetProject,
  ideGetProject,
  ideSendToolApproval,
} from "../lib/api";
import type { IdeStreamEvent } from "../lib/api";
import type { ToolEvent } from "../lib/types";
```

Add project state variables:

```typescript
let projectRoot: string | null = $state(null);
let gitBranch: string | null = $state(null);
let streamingToolEvents: ToolEvent[] = $state([]);
```

Add project functions:

```typescript
async function openProject() {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true, title: "Open Project" });
    if (selected && typeof selected === "string") {
      projectRoot = selected;
      await ideSetProject(selected);
      // Detect git branch
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const status = await invoke<string>("project_git_status", {});
        // Get branch name
        const { execSync } = await import("child_process"); // won't work in browser
      } catch {}
    }
  } catch (err) {
    console.warn("Failed to open project dialog:", err);
  }
}

function handleToolApproval(id: string, approved: boolean) {
  ideSendToolApproval(id, approved);
  // Update the tool event status
  const evt = streamingToolEvents.find(e => e.id === id);
  if (evt) {
    evt.approval_status = approved ? "approved" : "rejected";
    streamingToolEvents = [...streamingToolEvents];
  }
}
```

Replace the `sendMessage` function body's local chat branch with IDE agent logic when `projectRoot` is set:

```typescript
// Inside sendMessage(), replace the `else` (local) branch:
if (projectRoot && !usePortalChat) {
  // Use IDE agent with tool support
  const apiMessages = conversation.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  streamingToolEvents = [];

  await streamIdeChat(
    apiMessages,
    projectRoot,
    (event: IdeStreamEvent) => {
      switch (event.type) {
        case "text":
          streamingContent += event.content as string;
          scrollToBottom();
          break;
        case "status":
          // Could update a status indicator
          break;
        case "tool_call":
          streamingToolEvents = [...streamingToolEvents, {
            type: "tool_call",
            id: event.id as string,
            tool: event.tool as string,
            args: event.args as Record<string, unknown>,
            requires_approval: event.requires_approval as boolean,
            approval_status: (event.requires_approval ? "pending" : "approved") as "pending" | "approved",
          }];
          scrollToBottom();
          break;
        case "tool_result": {
          const tc = streamingToolEvents.find(e => e.id === event.id);
          if (tc) {
            tc.result = event.result as string | undefined;
            tc.error = event.error as string | undefined;
            streamingToolEvents = [...streamingToolEvents];
          }
          break;
        }
        case "shell_output": {
          streamingToolEvents = [...streamingToolEvents, {
            type: "shell_output",
            id: event.id as string,
            stdout: event.stdout as string,
            stderr: event.stderr as string,
            exit_code: event.exit_code as number,
          }];
          scrollToBottom();
          break;
        }
        case "plan":
          streamingToolEvents = [...streamingToolEvents, {
            type: "plan",
            steps: event.steps as ToolEvent["steps"],
            plan_status: event.status as string,
          }];
          scrollToBottom();
          break;
        case "done":
          break;
      }
    },
    abortController.signal,
    conversation.selectedModel,
  );
} else if (usePortalChat) {
  // ... existing portal chat logic ...
} else {
  // ... existing local chat logic ...
}
```

After the streaming completes (in the `try` block after streaming), save tool events to the message:

```typescript
const assistantMsg = addMessage(conversation, "assistant", streamingContent);
if (streamingToolEvents.length > 0) {
  assistantMsg.toolEvents = [...streamingToolEvents];
}
```

Update the `onMount` to detect existing project:

```typescript
// Inside onMount, after backend detection:
ideGetProject().then(p => {
  if (p) projectRoot = p;
});
```

In the template, add ProjectBar above the chat header and update ChatMessage to pass tool events:

```svelte
<ProjectBar {projectRoot} {gitBranch} onOpenProject={openProject} />

<!-- In the messages loop, pass toolEvents -->
<ChatMessage
  role={msg.role}
  content={msg.content}
  toolEvents={msg.toolEvents}
  {onOpenInEditor}
  onToolApproval={handleToolApproval}
/>

<!-- For streaming message -->
{#if isStreaming && (streamingContent || streamingToolEvents.length > 0)}
  <ChatMessage
    role="assistant"
    content={streamingContent}
    streaming={true}
    {streamProgress}
    toolEvents={streamingToolEvents}
    {onOpenInEditor}
    onToolApproval={handleToolApproval}
  />
{/if}
```

**Step 3: Update ChatMessage.svelte to render tool events**

Update `ChatMessage.svelte` to accept and render `toolEvents`:

```svelte
<script lang="ts">
  import MarkdownRenderer from "./MarkdownRenderer.svelte";
  import StreamingIndicator from "./StreamingIndicator.svelte";
  import ToolCallBlock from "./ToolCallBlock.svelte";
  import ShellBlock from "./ShellBlock.svelte";
  import DiffBlock from "./DiffBlock.svelte";
  import PlanBlock from "./PlanBlock.svelte";
  import type { StreamProgress } from "../lib/api";
  import type { ToolEvent } from "../lib/types";

  interface Props {
    role: "user" | "assistant";
    content: string;
    streaming?: boolean;
    streamProgress?: StreamProgress;
    toolEvents?: ToolEvent[];
    onOpenInEditor?: (code: string, language: string) => void;
    onToolApproval?: (id: string, approved: boolean) => void;
  }
  let { role, content, streaming = false, streamProgress, toolEvents, onOpenInEditor, onToolApproval }: Props = $props();
</script>

<div class="message {role}">
  {#if role === "user"}
    <div class="bubble user-bubble">{content}</div>
  {:else}
    <div class="bubble assistant-bubble">
      {#if content}
        <MarkdownRenderer source={content} {onOpenInEditor} />
      {/if}

      {#if toolEvents?.length}
        {#each toolEvents as evt}
          {#if evt.type === "tool_call"}
            <ToolCallBlock
              id={evt.id ?? ""}
              tool={evt.tool ?? ""}
              args={evt.args ?? {}}
              requiresApproval={evt.requires_approval ?? false}
              result={evt.result}
              error={evt.error}
              status={evt.error ? "completed" : evt.result ? "completed" : evt.approval_status === "rejected" ? "rejected" : evt.requires_approval && evt.approval_status === "pending" ? "pending" : "executing"}
              onApprove={(id) => onToolApproval?.(id, true)}
              onReject={(id) => onToolApproval?.(id, false)}
            />
          {:else if evt.type === "shell_output"}
            <ShellBlock
              id={evt.id ?? ""}
              command={evt.command}
              stdout={evt.stdout}
              stderr={evt.stderr}
              exitCode={evt.exit_code}
              status="completed"
            />
          {:else if evt.type === "diff"}
            <DiffBlock
              id={evt.id ?? ""}
              file={evt.file ?? ""}
              hunks={evt.hunks ?? []}
              status="pending"
              onAccept={(id) => onToolApproval?.(id, true)}
              onReject={(id) => onToolApproval?.(id, false)}
            />
          {:else if evt.type === "plan"}
            <PlanBlock
              steps={(evt.steps ?? []).map(s => ({ ...s, status: s.status as "pending" | "in_progress" | "completed" | "failed" }))}
              planStatus={(evt.plan_status ?? "proposed") as "proposed" | "approved" | "executing"}
            />
          {/if}
        {/each}
      {/if}

      {#if streaming}
        <StreamingIndicator progress={streamProgress} />
      {/if}
    </div>
  {/if}
</div>
```

**Step 4: Install the Tauri dialog plugin (npm)**

Run: `cd desktop && npm install @tauri-apps/plugin-dialog`

**Step 5: Verify compilation**

Run: `cd desktop && npm run build`
Expected: Compiles

**Step 6: Commit**

```bash
git add desktop/src/pages/ChatView.svelte desktop/src/components/ChatMessage.svelte desktop/src/lib/types.ts desktop/package.json desktop/package-lock.json
git commit -m "feat(desktop): wire ChatView to IDE agent with tool event rendering"
```

---

## Task 8: Verify end-to-end — build and test

Run full build and existing tests to verify nothing is broken.

**Step 1: Build the backend**

Run: `npm run build`
Expected: TypeScript compiles cleanly

**Step 2: Run tests**

Run: `npx vitest run`
Expected: All existing tests pass (1218+)

**Step 3: Build the desktop frontend**

Run: `cd desktop && npm run build`
Expected: Svelte/Vite compiles cleanly

**Step 4: Commit any fixes if needed**

```bash
git add -A
git commit -m "fix: resolve build issues from IDE agent integration"
```

---

## Summary

| Task | Component | Files |
|------|-----------|-------|
| 1 | Tool types + SSE protocol | `src/apps/ide/tool-types.ts` |
| 2 | Tauri commands (fs, shell, git) | `desktop/src-tauri/src/main.rs`, `Cargo.toml`, `capabilities/default.json` |
| 3 | Node.js tool executor | `src/apps/ide/tool-executor.ts` |
| 4 | Agentic chat endpoint | `src/apps/ide/provider-server.ts`, `src/model/system-prompt.ts` |
| 5 | ProjectBar + API functions | `desktop/src/components/ProjectBar.svelte`, `desktop/src/lib/api.ts` |
| 6 | UI blocks (Tool, Shell, Diff, Plan) | `desktop/src/components/*.svelte` (4 new) |
| 7 | ChatView integration | `desktop/src/pages/ChatView.svelte`, `ChatMessage.svelte`, `types.ts` |
| 8 | End-to-end verification | Build + tests |
