// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

// ---------------------------------------------------------------------------
// Shared type definitions for the IDE agent tool-use protocol.
// Used by both the Node.js backend (tool execution) and the Svelte frontend
// (SSE event rendering).
// ---------------------------------------------------------------------------

/** Every tool the IDE agent can invoke. */
export type ToolName =
  | "read_file"
  | "list_directory"
  | "search_files"
  | "search_codebase"
  | "write_file"
  | "edit_file"
  | "run_shell"
  | "git_status"
  | "git_diff"
  | "git_log"
  | "git_commit"
  | "git_branch"
  | "git_push"
  | "git_pull"
  | "git_fetch"
  | "github_create_pr"
  | "github_list_prs"
  | "github_list_issues"
  | "open_pull_request"
  // The web tool (src/web-tool/tools.ts): offered only when a chat's Web toggle or a bot's "Search the
  // web" permission is on; run on EdgeCoder's servers; never in TOOL_DEFINITIONS.
  | "web_search"
  | "read_page"
  // Tentacles (delegate.ts): offered only when a session has tentacles on; never in TOOL_DEFINITIONS.
  | "delegate"
  | "await_tentacles"
  | "cancel_tentacle";

/**
 * The tentacle tools (delegate.ts). They don't ask for approval: delegating runs nothing in the
 * lead's tree, and a tentacle's patch is applied (or asked about) when it finishes (tentacles.ts).
 */
export const TENTACLE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(["delegate", "await_tentacles", "cancel_tentacle"]);

/**
 * The web tool (src/web-tool/tools.ts). Not read tools: a call costs cSats and sends the query or URL
 * off this machine, so Manual mode asks; the other modes run them when the toggle or permission is on
 * (permission-policy.ts). After read_page, edits and commands that would run on their own ask
 * (agent-loop.ts makeToolRunner).
 */
export const WEB_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(["web_search", "read_page"]);

/** Tools that only observe the workspace (no approval needed). */
export const READ_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  "read_file",
  "list_directory",
  "search_files",
  "search_codebase",
  "git_status",
  "git_diff",
  "git_log",
  "git_fetch",
  "github_list_prs",
  "github_list_issues",
  // Tentacles: no approval at call time (see TENTACLE_TOOLS).
  ...TENTACLE_TOOLS,
]);

/** Tools that mutate the workspace or execute arbitrary commands. */
export const WRITE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  "write_file",
  "edit_file",
  "run_shell",
  "git_commit",
  "git_branch",
  "git_push",
  "git_pull",
  "github_create_pr",
  "open_pull_request",
]);

// ---------------------------------------------------------------------------
// Diff representation
// ---------------------------------------------------------------------------

/** A single hunk inside a unified diff. */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

// ---------------------------------------------------------------------------
// Plan representation
// ---------------------------------------------------------------------------

/** One step in an agent-proposed plan. */
export interface PlanStep {
  index: number;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
}

// ---------------------------------------------------------------------------
// SSE event protocol (discriminated union on `type`)
// ---------------------------------------------------------------------------

/**
 * What Auto decided for a model call (RouteSummary in src/inference-api/auto-route.ts): the label
 * ("This computer · qwen3-coder:30b"), the reason with the step's complexity, why it skipped the
 * obvious free model, and whether a smaller free model ran as a fallback.
 */
export interface StatusRoute {
  label: string;
  placement: "reserved" | "local" | "mine" | "network";
  model: string;
  reason: string;
  why?: string;
  complexity?: "low" | "medium" | "high" | "very_high";
  fallback?: boolean;
}

export type IdeStreamEvent =
  | { type: "text"; content: string }
  /** `note`: why compute went where it did, for the run details ("Auto → … (tools needed; …)"). */
  /** `route`: what Auto decided for the model call that follows (where, why, the step's complexity). */
  | { type: "status"; message: string; note?: string; route?: StatusRoute }
  | {
      type: "tool_call";
      id: string;
      tool: ToolName;
      args: Record<string, unknown>;
      requires_approval: boolean;
      /** An approval the user may answer "Always allow" with: the rule kept for the project (`npm test:*`). */
      allow_rule?: string;
      /** A command line's rules when it keeps several (one per part: `python3 tools/x.py:*`, ...); allow_rule is the first. */
      allow_rules?: string[];
      /**
       * Asked only because a web page was read this run (the prompt-injection guard, docs/web-tool.md):
       * the mode or a rule would have run it. The card may offer "Allow for the rest of this run".
       */
      web_guard?: true;
      /**
       * With web_guard: the call runs a file this run wrote or edited (edited-runs.ts). "Allow for
       * the rest of this run" isn't offered and never covers it.
       */
      runs_edited?: string;
      /** Auto runs it in the OS sandbox (sandbox.ts): writes only inside the project, no network. */
      sandboxed?: true;
      /** The sandbox blocked the call just before (what it blocked): this asks to run it outside the sandbox. */
      sandbox_retry?: string;
      /**
       * An ask "Allow for this session" may answer (session-allowances.ts): what later calls it lets
       * run without asking ("npm test commands", "edits inside the project"). A bot: for the rest of the run.
       */
      allow_session?: string;
      /** Ran without asking because the session allowed calls like it: what was allowed. */
      session_allowed?: string;
    }
  | { type: "tool_result"; id: string; result?: string; error?: string }
  | { type: "diff"; file: string; hunks: DiffHunk[]; id: string }
  | { type: "shell_request"; id: string; command: string }
  | {
      type: "shell_output";
      id: string;
      stdout: string;
      stderr: string;
      exit_code: number;
      /** It ran in the OS sandbox (the card shows a "sandboxed" tag). */
      sandboxed?: true;
      /** What the sandbox most likely blocked when it failed (a write outside the project, the network). */
      sandbox_denied?: string;
    }
  | {
      type: "plan";
      steps: PlanStep[];
      status: "proposed" | "approved" | "executing";
    }
  /** First event of an agent turn: its id, for checkpoints (review and undo of its file changes). */
  | { type: "turn"; id: string }
  /** The turn wrote this project file (its original is kept under the turn's checkpoint). */
  | { type: "file_change"; turnId: string; path: string }
  /** The prompt the next model call sends, in estimated tokens (the chat's context meter), and the model's window. */
  | { type: "context"; tokens: number; window?: number }
  /**
   * Older messages were compacted (context-budget.ts): estimated prompt tokens before and after.
   * A persistent compaction (`/compact`, or the pass before a paid turn) also carries the summary
   * `note` and how many leading messages it `covered`; `manual` when the user asked for it.
   */
  | { type: "compacted"; before: number; after: number; savedTokens: number; summarized?: boolean; manual?: boolean; covered?: number; note?: string }
  /** cSats a model call on the network cost (0 on this computer or your own machines). */
  | {
      type: "usage";
      cSats: number;
      where: string;
      /** Auto: why it ran there ("… — high complexity, needs ≥30B; this computer has ≤14B"). */
      reason?: string;
      /** The model that answered, and where it ran (machine label, hardware, region, timings and tokens). */
      model?: string;
      /** Frontier calls on the user's own key: estimated USD (billed by the provider, not in cSats). */
      usd?: number;
      served?: {
        label: string;
        own: boolean;
        computeClass: string;
        tier: string | null;
        hardware: string;
        gpu?: string;
        region: string | null;
        city?: string;
        country: string | null;
        pickupMs?: number;
        promptMs?: number;
        genMs?: number;
        promptTokens?: number;
        outputTokens?: number;
        /** Frontier calls (computeClass "frontier"): estimated USD on the user's own key. */
        usd?: number;
      };
    }
  /**
   * The web tool's running total for this reply, after each search or page read: counts, cSats (in
   * all; `addedCSats` for this call) and the numbered sources the answer cites as [n].
   */
  | { type: "web"; searches: number; pages: number; cSats: number; addedCSats: number; sources: Array<{ n: number; title: string; url: string }>; free?: true }
  /**
   * Web was wanted (the chat's "Web: Auto") but not offered for this reply: no cSats ("Web search
   * needs cSats"), the hour's searches used, or EdgeCoder unreachable. The reply goes on without it.
   */
  | { type: "web_off"; reason: string; message: string }
  /**
   * A one-line cost note under the reply (cost-guard.ts, turn-waste.ts): "saved" re-reads skipped
   * ("Skipped re-reading 3 unchanged files · ~90K tokens saved"), "waste" what the turn did about
   * waste, "suggest" a cheaper model for this kind of work (`suggest`: its chat model id).
   */
  | { type: "cost_note"; kind: "saved" | "waste" | "suggest"; message: string; savedTokens?: number; suggest?: { id: string; name: string; factor?: number } }
  | { type: "done" };

// ---------------------------------------------------------------------------
// Tool definition schema (used to build the tools array sent to the LLM)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: ToolName;
  description: string;
  parameters: Record<
    string,
    { type: string; description: string; required?: boolean }
  >;
}

/** Complete catalogue of IDE agent tools with parameter schemas. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  // -- Read tools ----------------------------------------------------------
  {
    name: "read_file",
    description:
      "Read a file at the given path, with line numbers. Returns at most 400 lines per call (800 with limit); a longer file ends with a note giving the offset to read on from. Use search_files to find the part you need in a large file.",
    parameters: {
      path: {
        type: "string",
        description: "Absolute or workspace-relative path to the file.",
        required: true,
      },
      offset: {
        type: "number",
        description: "Optional 1-based line number to start reading from (default 1).",
      },
      limit: {
        type: "number",
        description: "Optional number of lines to return (default 400, at most 800).",
      },
    },
  },
  {
    name: "list_directory",
    description:
      "List the files and subdirectories in a directory. Returns names with a trailing '/' for directories.",
    parameters: {
      path: {
        type: "string",
        description:
          "Absolute or workspace-relative path to the directory to list.",
        required: true,
      },
      recursive: {
        type: "boolean",
        description:
          "If true, list contents recursively. Defaults to false (single level).",
      },
    },
  },
  {
    name: "search_files",
    description:
      "Search for a regex pattern across files in the workspace. Returns matching file paths and line content.",
    parameters: {
      pattern: {
        type: "string",
        description: "Regular expression pattern to search for.",
        required: true,
      },
      path: {
        type: "string",
        description:
          "Directory to search within. Defaults to the workspace root.",
      },
      include: {
        type: "string",
        description:
          "Glob pattern to filter which files are searched (e.g. '*.ts').",
      },
    },
  },
  {
    name: "git_status",
    description:
      "Show the current git working-tree status. Returns staged, unstaged, and untracked file lists.",
    parameters: {},
  },
  {
    name: "git_diff",
    description:
      "Show the git diff for the working tree or between specific refs.",
    parameters: {
      ref: {
        type: "string",
        description:
          "Optional ref or range (e.g. 'HEAD~3', 'main..feature'). Defaults to unstaged changes.",
      },
      path: {
        type: "string",
        description: "Optional file path to limit the diff to.",
      },
    },
  },
  {
    name: "git_log",
    description:
      "Show recent git commit history. Returns commit hashes, authors, dates, and messages.",
    parameters: {
      count: {
        type: "number",
        description: "Number of commits to show. Defaults to 10.",
      },
      ref: {
        type: "string",
        description: "Branch or ref to show log for. Defaults to HEAD.",
      },
    },
  },

  {
    name: "search_codebase",
    description:
      "Find code by meaning rather than exact text (e.g. 'where are payouts retried', 'the login form'). Returns the most relevant file regions with line numbers. Use search_files for exact names or strings.",
    parameters: {
      query: {
        type: "string",
        description: "What you are looking for, in plain words.",
        required: true,
      },
    },
  },

  // -- Write tools ---------------------------------------------------------
  {
    name: "write_file",
    description:
      "Create or overwrite a file with the given content. Parent directories are created automatically.",
    parameters: {
      path: {
        type: "string",
        description: "Absolute or workspace-relative path for the file.",
        required: true,
      },
      content: {
        type: "string",
        description: "The full text content to write to the file.",
        required: true,
      },
    },
  },
  {
    name: "edit_file",
    description:
      "Apply a targeted edit to an existing file by replacing an exact string match with new content.",
    parameters: {
      path: {
        type: "string",
        description: "Path to the file to edit.",
        required: true,
      },
      old_string: {
        type: "string",
        description:
          "The exact text to find in the file. Must match uniquely.",
        required: true,
      },
      new_string: {
        type: "string",
        description: "The replacement text.",
        required: true,
      },
    },
  },
  {
    name: "run_shell",
    description:
      "Execute a shell command in the workspace directory. Returns stdout, stderr, and exit code.",
    parameters: {
      command: {
        type: "string",
        description: "The shell command to execute.",
        required: true,
      },
      timeout: {
        type: "number",
        description:
          "Optional timeout in milliseconds. Defaults to 30000 (30 s).",
      },
    },
  },
  {
    name: "git_commit",
    description:
      "Stage the specified files (or all changes) and create a git commit with the given message.",
    parameters: {
      message: {
        type: "string",
        description: "The commit message.",
        required: true,
      },
      files: {
        type: "string",
        description:
          "Space-separated file paths to stage, or '.' to stage everything. Defaults to '.'.",
      },
    },
  },
  {
    name: "git_branch",
    description:
      "Create, switch, or list git branches.",
    parameters: {
      name: {
        type: "string",
        description:
          "Branch name to create or switch to. Omit to list branches.",
      },
      create: {
        type: "boolean",
        description:
          "If true, create a new branch with the given name. Defaults to false.",
      },
    },
  },

  // -- Remote git + GitHub tools ----------------------------------------------
  {
    name: "git_fetch",
    description:
      "Fetch refs and objects from a remote repository.",
    parameters: {
      remote: {
        type: "string",
        description: "Name of a configured remote to fetch from (URLs and paths are refused). Defaults to 'origin'.",
      },
    },
  },
  {
    name: "git_push",
    description:
      "Push local commits to a remote repository. Requires GitHub to be connected.",
    parameters: {
      remote: {
        type: "string",
        description: "Name of a configured remote (URLs and paths are refused). Defaults to 'origin'.",
      },
      branch: {
        type: "string",
        description: "Branch to push. Defaults to current branch.",
      },
      setUpstream: {
        type: "boolean",
        description: "If true, set upstream tracking (--set-upstream). Defaults to false.",
      },
    },
  },
  {
    name: "git_pull",
    description:
      "Pull changes from a remote repository. Requires GitHub to be connected.",
    parameters: {
      remote: {
        type: "string",
        description: "Name of a configured remote (URLs and paths are refused). Defaults to 'origin'.",
      },
      branch: {
        type: "string",
        description: "Branch to pull. Omit to pull current tracking branch.",
      },
    },
  },
  {
    name: "github_create_pr",
    description:
      "Create a pull request on GitHub. Requires GitHub to be connected.",
    parameters: {
      title: {
        type: "string",
        description: "Pull request title.",
        required: true,
      },
      body: {
        type: "string",
        description: "Pull request body/description.",
      },
      head: {
        type: "string",
        description: "The branch containing the changes. Defaults to current branch.",
      },
      base: {
        type: "string",
        description: "The branch to merge into. Defaults to 'main'.",
      },
    },
  },
  {
    name: "github_list_prs",
    description:
      "List pull requests on the GitHub repository. Requires GitHub to be connected.",
    parameters: {
      state: {
        type: "string",
        description: "Filter by state: 'open', 'closed', or 'all'. Defaults to 'open'.",
      },
    },
  },
  {
    name: "github_list_issues",
    description:
      "List issues on the GitHub repository. Requires GitHub to be connected.",
    parameters: {
      state: {
        type: "string",
        description: "Filter by state: 'open', 'closed', or 'all'. Defaults to 'open'.",
      },
      labels: {
        type: "string",
        description: "Comma-separated list of label names to filter by.",
      },
    },
  },
  {
    name: "open_pull_request",
    description:
      "Open a pull request for the work you committed: pushes the current branch (creating a new branch if you're on the default branch) and opens the PR with the GitHub CLI. It commits nothing: commit first with git_commit. Always asks the user, who sees the title, body, branch and diffstat. Never pushes to the default branch.",
    parameters: {
      title: {
        type: "string",
        description: "Pull request title.",
        required: true,
      },
      body: {
        type: "string",
        description: "Pull request description: what changed and why, and how it was tested.",
      },
      base: {
        type: "string",
        description: "The branch to merge into. Defaults to the repository's default branch.",
      },
      branch: {
        type: "string",
        description: "The branch to push. Defaults to the current branch, or a new bot/<name>/<slug> branch when on the default branch.",
      },
    },
  },
] as const;
