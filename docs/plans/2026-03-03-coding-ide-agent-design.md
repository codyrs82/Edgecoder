# Coding IDE Agent Interface — Design Document

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:writing-plans to create the implementation plan from this design.

**Goal:** Transform the Edgecoder chat tab into a full coding IDE agent interface — with project-aware file operations, git integration, shell execution, and planning mode — similar to Cursor and Claude Code.

**Architecture:** Extend the existing SSE chat stream protocol with structured tool-use events. The local agent (InteractiveAgent on localhost:4301) gets a tool registry for filesystem, git, and shell operations, executed via Tauri IPC. The frontend renders tool calls, diffs, and terminal output as collapsible blocks inline in the conversation. The portal web UI gets the same visual treatment but without local tool access.

**Tech Stack:** Svelte 5, Tauri (Rust), Monaco Editor (existing), Ollama qwen2.5:7b, Fastify SSE streaming, Node.js child_process for shell/git

---

## 1. SSE Stream Protocol Extension

The current chat stream sends `data: {"content":"..."}` events. We extend this with typed events:

| Event Type | Fields | Rendered As |
|---|---|---|
| `text` | `content` | Normal chat text (markdown) |
| `tool_call` | `tool`, `args`, `id`, `requires_approval` | Collapsible block header: "Reading src/main.ts..." |
| `tool_result` | `id`, `result`, `error` | Collapsible block body with content |
| `diff` | `file`, `hunks[]` | Unified diff view with Accept/Reject buttons |
| `shell_request` | `id`, `command` | Terminal block with Approve/Deny buttons |
| `shell_output` | `id`, `stdout`, `stderr`, `exit_code` | Terminal output block |
| `plan` | `steps[]`, `status` | Planning mode checklist view |
| `status` | `message` | Agent status indicator (thinking, reading, writing...) |

### Approval Flow

- **Read-only tools** (`read_file`, `list_directory`, `search_files`, `git_status`, `git_diff`, `git_log`): auto-execute without approval.
- **Write tools** (`write_file`, `edit_file`, `run_shell`, `git_commit`, `git_branch`): emit `requires_approval: true` and the agent **pauses** until the frontend sends approval via `POST /ide/tool-approval`.
- Approval endpoint: `POST /ide/tool-approval` with `{ id, approved: boolean }`.
- On rejection, the agent receives the rejection and adapts its approach.

---

## 2. Agent Tool System

When the user opens a project folder via Tauri's native folder dialog, the desktop app sets the project root on the agent. All file paths are sandboxed to this root.

### Tool Registry

| Tool | Type | Description |
|---|---|---|
| `read_file` | read | Read file contents, optional line range |
| `list_directory` | read | List files/dirs with glob pattern support |
| `search_files` | read | Grep/ripgrep across project files |
| `write_file` | write | Create or overwrite a file |
| `edit_file` | write | Targeted edits (old_string -> new_string) |
| `run_shell` | write | Execute shell command in project dir |
| `git_status` | read | Working tree status |
| `git_diff` | read | Staged/unstaged diffs |
| `git_commit` | write | Stage files and commit |
| `git_log` | read | Commit history |
| `git_branch` | write | Create/switch branches |

### Implementation

Tools are implemented as **Tauri commands** exposed to the agent process via HTTP endpoints on the desktop app. The agent process (localhost:4301) calls the Tauri app's IPC bridge to execute filesystem and git operations within the project directory.

### Agentic Loop

1. LLM (Ollama qwen2.5:7b) receives system prompt listing available tools with schemas
2. LLM responds with tool calls in structured format (JSON)
3. Agent parses tool calls, executes reads immediately, queues writes for approval
4. Tool results fed back to LLM as tool_result messages
5. Loop continues until LLM produces a final text response or task is complete
6. Each tool call/result is streamed to the frontend as SSE events in real-time

---

## 3. Frontend UI — Enhanced Chat Tab

### New Svelte Components

1. **`ToolCallBlock.svelte`** — Collapsible block for tool calls
   - Header: tool name + args summary, spinner while executing
   - Body: result content (collapsed by default for reads after execution)
   - Color-coded: blue for reads, amber for writes pending approval, green for approved

2. **`DiffBlock.svelte`** — Unified diff renderer with syntax highlighting
   - File path header, colored added/removed lines
   - "Accept" and "Reject" buttons for write approval
   - Accept sends approval to agent and applies the edit
   - Reject sends rejection, agent adapts

3. **`ShellBlock.svelte`** — Terminal output block
   - Shows command with "Run" / "Deny" buttons before execution
   - After approval: scrolling stdout/stderr output
   - Exit code indicator (green check / red X)

4. **`PlanBlock.svelte`** — Planning mode checklist
   - Numbered steps with status indicators (pending/in-progress/done)
   - User can approve/modify the plan before agent executes

5. **`ProjectBar.svelte`** — Bar above chat showing:
   - Current project path (or "No project open")
   - "Open Project" button (triggers Tauri native folder dialog)
   - Git branch indicator
   - File count summary

### Message Rendering

ChatView.svelte parses the extended SSE events and routes each to the appropriate component:
- `text` events → existing MarkdownRenderer
- `tool_call` + `tool_result` events → ToolCallBlock
- `diff` events → DiffBlock
- `shell_request` + `shell_output` events → ShellBlock
- `plan` events → PlanBlock
- `status` events → status indicator in ProjectBar or inline

### Example Flow

```
User: "Fix the authentication bug in login.ts"

Agent streams:
  status("Analyzing project...")
  tool_call(read_file, {path: "src/login.ts"})          → auto-executes
  tool_result(file contents)                              → collapsed block
  text("I found the issue on line 42...")                 → markdown
  diff(src/login.ts, [{remove: "old", add: "new"}])      → diff with Accept/Reject

User clicks [Accept]

Agent streams:
  shell_request("npm test")                               → Run/Deny buttons

User clicks [Run]

Agent streams:
  shell_output({stdout: "5 passing", exit_code: 0})       → green check
  text("All tests pass. Want me to commit this fix?")
```

---

## 4. Portal Web Experience

The portal has no local filesystem access. It gets a **subset** of the IDE experience:

- **Code generation blocks** — syntax highlighted code with copy buttons (existing behavior, enhanced)
- **Planning mode** — agent proposes plans and discusses architecture
- **Tool blocks render as "unavailable"** — write tools show: "Install the Edgecoder desktop app to work with local projects"
- **Same visual design** — tool blocks rendered as styled HTML in the portal's server-rendered pages

The portal server (`server.ts`) parses the coordinator's SSE response and re-renders tool events as HTML blocks. The visual design matches the desktop Svelte components.

---

## 5. Data Flow

```
┌─ Desktop App (Tauri) ─────────────────────────────────────┐
│                                                            │
│  Svelte UI                    Agent (localhost:4301)        │
│  ┌──────────┐                 ┌──────────────────┐         │
│  │ ChatView │ ── SSE ──────── │ IDE Provider     │         │
│  │          │                 │   ↕ LLM (Ollama) │         │
│  │ ToolCall │ ← tool events   │   ↕ Tool Registry│         │
│  │ DiffBlock│                 │     ↕             │         │
│  │ ShellBlk │ ── approval ──→ │   Approval Queue │         │
│  └──────────┘                 └────────┬─────────┘         │
│                                        │                   │
│  Tauri Bridge ←── HTTP/IPC ────────────┘                   │
│    ↕ fs read/write                                         │
│    ↕ shell exec                                            │
│    ↕ git commands                                          │
│    (sandboxed to project root)                             │
└────────────────────────────────────────────────────────────┘

┌─ Portal (web) ────────────────────────────────────────────┐
│  Browser → portal server → coordinator → Ollama           │
│  Same SSE protocol, tool_calls marked unavailable         │
│  "Install desktop app for local project access"           │
└────────────────────────────────────────────────────────────┘
```

---

## 6. Files to Modify

| Layer | File | Changes |
|---|---|---|
| Desktop UI | `desktop/src/pages/ChatView.svelte` | Parse extended SSE events, render tool blocks |
| Desktop UI | `desktop/src/components/ToolCallBlock.svelte` | **New** — collapsible tool call renderer |
| Desktop UI | `desktop/src/components/DiffBlock.svelte` | **New** — diff renderer with accept/reject |
| Desktop UI | `desktop/src/components/ShellBlock.svelte` | **New** — terminal output block |
| Desktop UI | `desktop/src/components/PlanBlock.svelte` | **New** — planning mode checklist |
| Desktop UI | `desktop/src/components/ProjectBar.svelte` | **New** — project status bar |
| Desktop UI | `desktop/src/lib/api.ts` | New endpoints: `openProject()`, `sendToolApproval()` |
| Tauri | `desktop/src-tauri/src/main.rs` | Tauri commands: folder dialog, fs ops, shell exec, git ops |
| Agent | `src/apps/ide/provider-server.ts` | Tool registry, agentic loop, extended SSE protocol, approval queue |
| Portal | `src/portal/server.ts` | Parse/re-render tool events in portal chat HTML |

## 7. Out of Scope (YAGNI)

- GitHub PR creation from portal (desktop-only feature)
- Multi-file diff views (one diff block per file is sufficient)
- Collaborative editing (single user per project)
- File upload to portal for remote code review
- Custom tool plugins / extension API
- Breakpoint debugging integration
