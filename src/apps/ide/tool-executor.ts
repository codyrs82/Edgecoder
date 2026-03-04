// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

// ---------------------------------------------------------------------------
// Server-side tool executor for the IDE agent process.
// Called directly by the agent (provider-server on :4304) to perform
// filesystem, shell, and git operations within the user's project.
// ---------------------------------------------------------------------------

import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import type { ToolName } from "./tool-types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ToolResult {
  result?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// ToolExecutor
// ---------------------------------------------------------------------------

export class ToolExecutor {
  private readonly root: string;
  private readonly githubToken: string | null;

  constructor(projectRoot: string, githubToken?: string | null) {
    this.root = resolve(projectRoot);
    this.githubToken = githubToken ?? null;
  }

  // -----------------------------------------------------------------------
  // Path helpers
  // -----------------------------------------------------------------------

  /**
   * Resolve a user-supplied path against the project root and ensure the
   * resolved path does not escape outside the sandbox.
   */
  private resolvePath(relativePath: string): string {
    const abs = resolve(this.root, relativePath);
    const rel = relative(this.root, abs);
    if (rel.startsWith("..")) {
      throw new Error(`Path escapes project root: ${relativePath}`);
    }
    // If the path exists, verify the real (symlink-resolved) path is also within root
    if (existsSync(abs)) {
      const real = realpathSync(abs);
      if (!real.startsWith(this.root)) {
        throw new Error(`Symlink escapes project root: ${relativePath}`);
      }
    }
    return abs;
  }

  // -----------------------------------------------------------------------
  // Main dispatch
  // -----------------------------------------------------------------------

  async execute(
    tool: ToolName,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      switch (tool) {
        case "read_file":
          return await this.readFileImpl(args);
        case "list_directory":
          return await this.listDirectory(args);
        case "search_files":
          return await this.searchFiles(args);
        case "write_file":
          return await this.writeFileImpl(args);
        case "edit_file":
          return await this.editFile(args);
        case "run_shell":
          return await this.runShell(args);
        case "git_status":
          return this.gitStatus();
        case "git_diff":
          return this.gitDiff(args);
        case "git_log":
          return this.gitLog(args);
        case "git_commit":
          return this.gitCommit(args);
        case "git_branch":
          return this.gitBranch(args);
        case "git_fetch":
          return this.gitFetch(args);
        case "git_push":
          return this.gitPush(args);
        case "git_pull":
          return this.gitPull(args);
        case "github_create_pr":
          return await this.githubCreatePr(args);
        case "github_list_prs":
          return await this.githubListPrs(args);
        case "github_list_issues":
          return await this.githubListIssues(args);
        default: {
          const _exhaustive: never = tool;
          return { error: `Unknown tool: ${_exhaustive}` };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: message };
    }
  }

  // -----------------------------------------------------------------------
  // read_file
  // -----------------------------------------------------------------------

  private async readFileImpl(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const filePath = this.resolvePath(String(args.path ?? ""));
    const raw = await readFile(filePath, "utf-8");
    const allLines = raw.split("\n");

    const offset = typeof args.offset === "number" ? args.offset : 1;
    const limit =
      typeof args.limit === "number" ? args.limit : allLines.length;

    // offset is 1-based per the tool definition
    const startIdx = Math.max(0, offset - 1);
    const slice = allLines.slice(startIdx, startIdx + limit);

    const numbered = slice.map(
      (line, i) => `${String(startIdx + i + 1).padStart(6, " ")}  ${line}`,
    );
    return { result: numbered.join("\n") };
  }

  // -----------------------------------------------------------------------
  // list_directory
  // -----------------------------------------------------------------------

  private async listDirectory(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const dirPath = this.resolvePath(String(args.path ?? "."));
    const entries = await readdir(dirPath, { withFileTypes: true });

    const lines: string[] = [];
    for (const entry of entries) {
      // Skip dotfiles/dotfolders
      if (entry.name.startsWith(".")) continue;

      if (entry.isDirectory()) {
        lines.push(`dir   ${entry.name}/`);
      } else {
        try {
          const info = await stat(join(dirPath, entry.name));
          lines.push(`file  ${entry.name}  (${info.size} bytes)`);
        } catch {
          lines.push(`file  ${entry.name}`);
        }
      }
    }
    return { result: lines.join("\n") || "(empty directory)" };
  }

  // -----------------------------------------------------------------------
  // search_files
  // -----------------------------------------------------------------------

  private async searchFiles(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const pattern = String(args.pattern ?? "");
    const searchDir = this.resolvePath(String(args.path ?? "."));
    const include = typeof args.include === "string" ? args.include : "";

    const grepArgs = ["grep", "-rn", "-E", pattern];
    if (include) {
      grepArgs.push("--include", include);
    }
    grepArgs.push(searchDir);

    return new Promise<ToolResult>((resolvePromise) => {
      const proc = spawn(grepArgs[0], grepArgs.slice(1), {
        cwd: this.root,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let lineCount = 0;
      const MAX_RESULTS = 50;

      proc.stdout.on("data", (chunk: Buffer) => {
        if (lineCount >= MAX_RESULTS) return;
        const text = chunk.toString("utf-8");
        const lines = text.split("\n");
        for (const line of lines) {
          if (!line) continue;
          if (lineCount >= MAX_RESULTS) {
            proc.kill();
            break;
          }
          // Make paths relative to project root for readability
          const relLine = line.startsWith(this.root)
            ? line.slice(this.root.length + 1)
            : line;
          stdout += relLine + "\n";
          lineCount++;
        }
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      proc.on("close", (code) => {
        if (lineCount === 0 && code !== 0) {
          resolvePromise({
            result: stderr ? `No matches found. ${stderr.trim()}` : "No matches found.",
          });
        } else {
          const suffix =
            lineCount >= MAX_RESULTS
              ? `\n... (limited to ${MAX_RESULTS} results)`
              : "";
          resolvePromise({ result: stdout.trimEnd() + suffix });
        }
      });
    });
  }

  // -----------------------------------------------------------------------
  // write_file
  // -----------------------------------------------------------------------

  private async writeFileImpl(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const filePath = this.resolvePath(String(args.path ?? ""));
    const content = String(args.content ?? "");

    // Ensure parent directories exist
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(filePath, content, "utf-8");
    return { result: `Wrote ${content.length} bytes to ${relative(this.root, filePath)}` };
  }

  // -----------------------------------------------------------------------
  // edit_file
  // -----------------------------------------------------------------------

  private async editFile(args: Record<string, unknown>): Promise<ToolResult> {
    const filePath = this.resolvePath(String(args.path ?? ""));
    const oldString = String(args.old_string ?? "");
    const newString = String(args.new_string ?? "");

    if (!oldString) {
      return { error: "old_string must not be empty" };
    }

    const original = await readFile(filePath, "utf-8");
    const firstIdx = original.indexOf(oldString);
    if (firstIdx === -1) {
      return { error: "old_string not found in file" };
    }

    // Check uniqueness — there should be exactly one occurrence
    const secondIdx = original.indexOf(oldString, firstIdx + 1);
    if (secondIdx !== -1) {
      return {
        error:
          "old_string matches multiple locations in the file. Provide a more specific string.",
      };
    }

    const updated = original.replace(oldString, newString);
    await writeFile(filePath, updated, "utf-8");

    const relPath = relative(this.root, filePath);
    return { result: `Edited ${relPath} — replaced ${oldString.length} chars` };
  }

  // -----------------------------------------------------------------------
  // run_shell
  // -----------------------------------------------------------------------

  private async runShell(args: Record<string, unknown>): Promise<ToolResult> {
    const command = String(args.command ?? "");
    const timeout =
      typeof args.timeout === "number" ? args.timeout : 30_000;

    return new Promise<ToolResult>((resolvePromise) => {
      const proc = spawn("sh", ["-c", command], {
        cwd: this.root,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        proc.kill("SIGKILL");
      }, timeout);

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        const exitCode = killed ? 137 : (code ?? 1);
        resolvePromise({
          result: JSON.stringify({
            stdout: stdout.trimEnd(),
            stderr: stderr.trimEnd(),
            exit_code: exitCode,
          }),
        });
      });
    });
  }

  // -----------------------------------------------------------------------
  // git_status
  // -----------------------------------------------------------------------

  private gitStatus(): ToolResult {
    try {
      const out = execFileSync("git", ["status", "--porcelain"], {
        cwd: this.root,
        encoding: "utf-8",
        timeout: 10_000,
      });
      return { result: out.trimEnd() || "(clean working tree)" };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "git status failed",
      };
    }
  }

  // -----------------------------------------------------------------------
  // git_diff
  // -----------------------------------------------------------------------

  private gitDiff(args: Record<string, unknown>): ToolResult {
    const ref = typeof args.ref === "string" ? args.ref : "";
    const filePath = typeof args.path === "string" ? args.path : "";

    const gitArgs = ["diff"];
    if (ref) gitArgs.push(ref);
    if (filePath) gitArgs.push("--", filePath);

    try {
      const out = execFileSync("git", gitArgs, {
        cwd: this.root,
        encoding: "utf-8",
        timeout: 10_000,
      });
      return { result: out.trimEnd() || "(no diff)" };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "git diff failed",
      };
    }
  }

  // -----------------------------------------------------------------------
  // git_log
  // -----------------------------------------------------------------------

  private gitLog(args: Record<string, unknown>): ToolResult {
    const count =
      typeof args.count === "number" ? args.count : 10;
    const ref = typeof args.ref === "string" ? args.ref : "";

    const gitArgs = ["log", "--oneline", "-n", `${count}`];
    if (ref) gitArgs.push(ref);

    try {
      const out = execFileSync("git", gitArgs, {
        cwd: this.root,
        encoding: "utf-8",
        timeout: 10_000,
      });
      return { result: out.trimEnd() || "(no commits)" };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "git log failed",
      };
    }
  }

  // -----------------------------------------------------------------------
  // git_commit
  // -----------------------------------------------------------------------

  private gitCommit(args: Record<string, unknown>): ToolResult {
    const message = String(args.message ?? "");
    const files = String(args.files ?? ".");

    if (!message) {
      return { error: "commit message is required" };
    }

    try {
      // Stage files — split on whitespace to pass as separate arguments
      const fileList = files.split(/\s+/).filter(Boolean);
      execFileSync("git", ["add", ...fileList], {
        cwd: this.root,
        encoding: "utf-8",
        timeout: 10_000,
      });

      // Commit — execFileSync passes message as argument, no shell interpolation
      const out = execFileSync("git", ["commit", "-m", message], {
        cwd: this.root,
        encoding: "utf-8",
        timeout: 10_000,
      });
      return { result: out.trimEnd() };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "git commit failed",
      };
    }
  }

  // -----------------------------------------------------------------------
  // git_branch
  // -----------------------------------------------------------------------

  private gitBranch(args: Record<string, unknown>): ToolResult {
    const name = typeof args.name === "string" ? args.name : "";
    const create = args.create === true;

    try {
      if (!name) {
        // List branches
        const out = execFileSync("git", ["branch"], {
          cwd: this.root,
          encoding: "utf-8",
          timeout: 10_000,
        });
        return { result: out.trimEnd() };
      }

      const gitArgs = create
        ? ["checkout", "-b", name]
        : ["checkout", name];

      const out = execFileSync("git", gitArgs, {
        cwd: this.root,
        encoding: "utf-8",
        timeout: 10_000,
      });
      return { result: out.trimEnd() || `Switched to branch '${name}'` };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "git branch failed",
      };
    }
  }

  // -----------------------------------------------------------------------
  // Git credential helper for authenticated remote ops
  // -----------------------------------------------------------------------

  private execGitAuth(gitArgs: string[], timeoutMs = 60_000): string {
    const args: string[] = [];
    if (this.githubToken) {
      // Inject a one-shot credential helper that echoes the token as HTTPS password
      const helper = `!f() { echo "protocol=https"; echo "host=github.com"; echo "username=x-access-token"; echo "password=${this.githubToken}"; }; f`;
      args.push("-c", `credential.helper=${helper}`);
    }
    args.push(...gitArgs);
    return execFileSync("git", args, {
      cwd: this.root,
      encoding: "utf-8",
      timeout: timeoutMs,
    }).trimEnd();
  }

  // -----------------------------------------------------------------------
  // git_fetch
  // -----------------------------------------------------------------------

  private gitFetch(args: Record<string, unknown>): ToolResult {
    const remote = typeof args.remote === "string" ? args.remote : "origin";
    try {
      const out = this.execGitAuth(["fetch", remote]);
      return { result: out || `Fetched from ${remote}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "git fetch failed" };
    }
  }

  // -----------------------------------------------------------------------
  // git_push
  // -----------------------------------------------------------------------

  private gitPush(args: Record<string, unknown>): ToolResult {
    const remote = typeof args.remote === "string" ? args.remote : "origin";
    const branch = typeof args.branch === "string" ? args.branch : "";
    const setUpstream = args.setUpstream === true;

    const gitArgs = ["push"];
    if (setUpstream) gitArgs.push("--set-upstream");
    gitArgs.push(remote);
    if (branch) gitArgs.push(branch);

    try {
      const out = this.execGitAuth(gitArgs);
      return { result: out || `Pushed to ${remote}${branch ? ` ${branch}` : ""}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "git push failed" };
    }
  }

  // -----------------------------------------------------------------------
  // git_pull
  // -----------------------------------------------------------------------

  private gitPull(args: Record<string, unknown>): ToolResult {
    const remote = typeof args.remote === "string" ? args.remote : "origin";
    const branch = typeof args.branch === "string" ? args.branch : "";

    const gitArgs = ["pull", remote];
    if (branch) gitArgs.push(branch);

    try {
      const out = this.execGitAuth(gitArgs);
      return { result: out || `Pulled from ${remote}${branch ? ` ${branch}` : ""}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "git pull failed" };
    }
  }

  // -----------------------------------------------------------------------
  // GitHub API helpers
  // -----------------------------------------------------------------------

  private getGitHubRepo(): { owner: string; repo: string } {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: this.root,
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();

    // HTTPS: https://github.com/owner/repo.git
    const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

    // SSH: git@github.com:owner/repo.git
    const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
    if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };

    throw new Error(`Could not parse GitHub owner/repo from remote URL: ${url}`);
  }

  private async githubApiFetch(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    if (!this.githubToken) {
      throw new Error("GitHub not connected. Connect GitHub in Settings > Integrations.");
    }
    const { request: httpRequest } = await import("undici");
    const res = await httpRequest(`https://api.github.com${path}`, {
      method: (options.method ?? "GET") as any,
      headers: {
        authorization: `Bearer ${this.githubToken}`,
        accept: "application/vnd.github+json",
        "user-agent": "EdgeCoder-IDE",
        "x-github-api-version": "2022-11-28",
        ...(options.body ? { "content-type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.body.json();
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const msg = (data as any)?.message ?? `HTTP ${res.statusCode}`;
      throw new Error(`GitHub API error: ${msg}`);
    }
    return data;
  }

  // -----------------------------------------------------------------------
  // github_create_pr
  // -----------------------------------------------------------------------

  private async githubCreatePr(args: Record<string, unknown>): Promise<ToolResult> {
    const title = String(args.title ?? "");
    if (!title) return { error: "title is required" };

    const body = typeof args.body === "string" ? args.body : "";
    const base = typeof args.base === "string" ? args.base : "main";
    let head = typeof args.head === "string" ? args.head : "";

    if (!head) {
      head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: this.root,
        encoding: "utf-8",
        timeout: 5_000,
      }).trim();
    }

    try {
      const { owner, repo } = this.getGitHubRepo();
      const pr = (await this.githubApiFetch(`/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        body: { title, body, head, base },
      })) as { number: number; html_url: string; title: string };
      return { result: `Created PR #${pr.number}: ${pr.title}\n${pr.html_url}` };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "github_create_pr failed" };
    }
  }

  // -----------------------------------------------------------------------
  // github_list_prs
  // -----------------------------------------------------------------------

  private async githubListPrs(args: Record<string, unknown>): Promise<ToolResult> {
    const state = typeof args.state === "string" ? args.state : "open";
    try {
      const { owner, repo } = this.getGitHubRepo();
      const prs = (await this.githubApiFetch(
        `/repos/${owner}/${repo}/pulls?state=${encodeURIComponent(state)}&per_page=30`,
      )) as Array<{ number: number; title: string; state: string; user: { login: string }; html_url: string }>;
      if (prs.length === 0) return { result: `No ${state} pull requests.` };
      const lines = prs.map(
        (pr) => `#${pr.number} [${pr.state}] ${pr.title} (by @${pr.user.login}) — ${pr.html_url}`,
      );
      return { result: lines.join("\n") };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "github_list_prs failed" };
    }
  }

  // -----------------------------------------------------------------------
  // github_list_issues
  // -----------------------------------------------------------------------

  private async githubListIssues(args: Record<string, unknown>): Promise<ToolResult> {
    const state = typeof args.state === "string" ? args.state : "open";
    const labels = typeof args.labels === "string" ? args.labels : "";
    try {
      const { owner, repo } = this.getGitHubRepo();
      let url = `/repos/${owner}/${repo}/issues?state=${encodeURIComponent(state)}&per_page=30`;
      if (labels) url += `&labels=${encodeURIComponent(labels)}`;
      const items = (await this.githubApiFetch(url)) as Array<{
        number: number; title: string; state: string; user: { login: string };
        html_url: string; pull_request?: unknown;
      }>;
      // GitHub API returns PRs as issues — filter them out
      const issues = items.filter((i) => !i.pull_request);
      if (issues.length === 0) return { result: `No ${state} issues.` };
      const lines = issues.map(
        (i) => `#${i.number} [${i.state}] ${i.title} (by @${i.user.login}) — ${i.html_url}`,
      );
      return { result: lines.join("\n") };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "github_list_issues failed" };
    }
  }
}
