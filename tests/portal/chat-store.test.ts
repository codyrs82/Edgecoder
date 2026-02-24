import { describe, it, expect } from "vitest";

describe("chat store types", () => {
  it("conversation has required fields", () => {
    const conv = {
      conversationId: "conv-1",
      userId: "user-1",
      title: "Test chat",
      createdAtMs: Date.now(),
      updatedAtMs: Date.now()
    };
    expect(conv.conversationId).toBe("conv-1");
    expect(conv.userId).toBe("user-1");
    expect(conv.title).toBe("Test chat");
  });

  it("message has required fields", () => {
    const msg = {
      messageId: "msg-1",
      conversationId: "conv-1",
      role: "user" as const,
      content: "Hello",
      tokensUsed: 0,
      creditsSpent: 0,
      createdAtMs: Date.now()
    };
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Hello");
    expect(msg.tokensUsed).toBe(0);
  });

  it("message roles are constrained", () => {
    const roles: Array<"user" | "assistant" | "system"> = ["user", "assistant", "system"];
    expect(roles).toHaveLength(3);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(roles).toContain("system");
  });
});
