// Copyright (c) 2025 EdgeCoder, LLC
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
  | "write_file"
  | "edit_file"
  | "run_shell"
  | "git_status"
  | "git_diff"
  | "git_log"
  | "git_commit"
  | "git_branch";

/** Tools that only observe the workspace (no approval needed). */
export const READ_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  "read_file",
  "list_directory",
  "search_files",
  "git_status",
  "git_diff",
  "git_log",
]);

/** Tools that mutate the workspace or execute arbitrary commands. */
export const WRITE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  "write_file",
  "edit_file",
  "run_shell",
  "git_commit",
  "git_branch",
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

export type IdeStreamEvent =
  | { type: "text"; content: string }
  | { type: "status"; message: string }
  | {
      type: "tool_call";
      id: string;
      tool: ToolName;
      args: Record<string, unknown>;
      requires_approval: boolean;
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
    }
  | {
      type: "plan";
      steps: PlanStep[];
      status: "proposed" | "approved" | "executing";
    }
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
      "Read the contents of a file at the given path. Returns the full text of the file.",
    parameters: {
      path: {
        type: "string",
        description: "Absolute or workspace-relative path to the file.",
        required: true,
      },
      offset: {
        type: "number",
        description: "Optional 1-based line number to start reading from.",
      },
      limit: {
        type: "number",
        description: "Optional maximum number of lines to return.",
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
] as const;
