import { describe, expect, it } from "vitest";
import { askCards, groupsOf, prCards, runSourceText, toolsFor, triggerStatusText, triggerText } from "../src/lib/bots";

describe("bot GitHub helpers", () => {
  it("shows an open_pull_request approval with title, body, branch and diffstat", () => {
    const [card] = askCards(
      [{ type: "tool_call", id: "c1", tool: "open_pull_request", requires_approval: true, approval_status: "pending", args: { title: "Fix the flaky test", body: "Retries.", branch: "bot/harry/fix-the-flaky-test", base: "main", diffstat: " a.txt | 1 +", commits: 1, uncommitted: 2 } }],
      "Harry",
    );
    expect(card.question).toBe("Harry wants to open a pull request");
    expect(card.answer).toBeNull();
    expect(card.pr).toEqual({ title: "Fix the flaky test", body: "Retries.", branch: "bot/harry/fix-the-flaky-test", base: "main", diffstat: " a.txt | 1 +", commits: 1, uncommitted: 2 });
  });

  it("finds opened PRs for the PR card", () => {
    const cards = prCards([
      { type: "tool_call", id: "c1", tool: "open_pull_request", args: { title: "Fix", branch: "bot/harry/fix", base: "main" }, result: "Opened pull request https://github.com/octo/widgets/pull/42\nBranch …" },
      { type: "tool_call", id: "c2", tool: "open_pull_request", args: { title: "Nope" }, error: "Refusing to push to main" },
      { type: "tool_call", id: "c3", tool: "git_push", result: "https://github.com/octo/widgets/pull/1" },
    ]);
    expect(cards).toEqual([{ id: "c1", url: "https://github.com/octo/widgets/pull/42", number: 42, title: "Fix", branch: "bot/harry/fix", base: "main" }]);
  });

  it("names run sources and triggers in plain words", () => {
    expect(runSourceText({ trigger: "github", source: "PR #12 updated" })).toBe("PR #12 updated");
    expect(runSourceText({ trigger: "schedule" })).toBe("Schedule");
    expect(runSourceText({ trigger: "manual" })).toBe("Run now");
    expect(triggerText({ kind: "pr", onlyOthers: true, label: "needs-review" })).toBe("PR opened or updated by others with label needs-review");
    expect(triggerText({ kind: "ci_failed", scope: "default" })).toBe("CI failed on the default branch");
    expect(triggerText({ kind: "issue_labeled", label: "bug" })).toBe("Issue labeled bug");
    expect(triggerStatusText(undefined, false)).toBe("Off");
    expect(triggerStatusText({ lastCheckedAtMs: 60_000 }, true, 6 * 60_000)).toBe("Checked 5 min ago");
    expect(triggerStatusText({ error: "GitHub rate limit: waiting before the next check.", backoffUntilMs: 10 * 60_000 }, true, 0)).toMatch(/Next check in 10 min/);
  });

  it("the commit-and-push group includes opening pull requests", () => {
    const tools = toolsFor({ edit: false, shell: false, git: true });
    expect(tools).toContain("open_pull_request");
    expect(groupsOf(tools).git).toBe(true);
    expect(groupsOf(["git_commit", "git_push"]).git).toBe(false);
  });
});
