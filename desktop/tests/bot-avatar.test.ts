import { describe, expect, it } from "vitest";
import { AVATAR_COLORS, AVATAR_SHAPES, colorFromName, inkFor, moodFor, nameHash, shapeFor } from "../src/lib/bot-avatar";
import { askCards } from "../src/lib/bots";

describe("bot avatars", () => {
  it("picks a stable shape and color from the name unless one was chosen", () => {
    expect(nameHash("Harry")).toBe(nameHash("  harry "));
    expect(AVATAR_SHAPES).toContain(shapeFor({ name: "Harry" }));
    expect(shapeFor({ name: "Harry" })).toBe(shapeFor({ name: "Harry" }));
    expect(shapeFor({ name: "Harry", avatarShape: "hex" })).toBe("hex");
    expect(shapeFor({ name: "Harry", avatarShape: "blob" })).toBe(shapeFor({ name: "Harry" }));
    expect(AVATAR_COLORS).toContain(colorFromName("Harry"));
    // Different names spread over the shapes.
    expect(new Set(["Harry", "Billing", "Sec", "Docs", "Ops", "Ana", "Q"].map((n) => shapeFor({ name: n }))).size).toBeGreaterThan(1);
  });

  it("maps state to a mood, and picks readable ink", () => {
    expect(moodFor("idle")).toBe("idle");
    expect(moodFor("running")).toBe("working");
    expect(moodFor("needs_approval")).toBe("needs");
    expect(moodFor("error")).toBe("failed");
    expect(moodFor("paused")).toBe("asleep");
    expect(inkFor("#ffc53d")).toBe("#1d1d1f");
    expect(inkFor("#6e56cf")).toBe("#ffffff");
  });
});

describe("ask cards", () => {
  it("turns approval tool calls into questions, with your answer once given", () => {
    const cards = askCards(
      [
        { type: "tool_call", id: "a", tool: "run_shell", args: { command: "npm test" }, requires_approval: true, approval_status: "pending" },
        { type: "tool_call", id: "b", tool: "git_push", args: {}, requires_approval: true, approval_status: "approved" },
        { type: "tool_call", id: "c", tool: "edit_file", args: { path: "src/a.ts" }, requires_approval: true, approval_status: "rejected" },
        { type: "tool_call", id: "d", tool: "read_file", args: { path: "x" }, requires_approval: false },
      ],
      "Harry",
    );
    expect(cards).toEqual([
      { id: "a", question: "Harry wants to run a command", detail: "npm test", answer: null },
      { id: "b", question: "Harry wants to push", answer: "Allowed" },
      { id: "c", question: "Harry wants to edit a file", detail: "src/a.ts", answer: "Denied" },
    ]);
  });
});
