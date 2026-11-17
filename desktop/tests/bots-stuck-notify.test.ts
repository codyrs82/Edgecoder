import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/api", () => ({ listBots: vi.fn() }));
vi.mock("../src/lib/toast", () => ({ notify: vi.fn() }));

import { announceStuck } from "../src/lib/bots-store";
import type { Bot } from "../src/lib/bots";

const bot = (over: Partial<Bot>): Bot => ({ id: "bot_h", name: "Harry", role: "", instructions: "", projectRoot: "/p", enabled: false, schedule: "", budgetCSatsPerDay: 100, allowedTools: [], autoApproveEdits: true, color: "#000000", createdAtMs: 0, updatedAtMs: 0, status: "paused", spentTodayCSats: 0, pending: [], queuedMessages: 0, ...over });

describe("a bot that pauses itself because it's stuck is announced once", () => {
  it("toasts when it gets stuck, not on every poll, and again if it gets stuck again later", () => {
    const say = vi.fn();
    const stuck = { atMs: 1, problem: "npm test: package.json not found", runs: 3 };
    announceStuck([bot({ stuck })], say);
    announceStuck([bot({ stuck })], say);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith("Paused: Harry kept hitting the same problem (npm test: package.json not found). Tell it what to do, or resume.", "bot-stuck-bot_h");
    announceStuck([bot({ enabled: true, status: "idle" })], say);
    announceStuck([bot({ stuck: { ...stuck, atMs: 2 } })], say);
    expect(say).toHaveBeenCalledTimes(2);
  });
});
