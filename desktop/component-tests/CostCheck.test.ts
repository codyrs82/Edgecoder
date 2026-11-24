import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import axe from "axe-core";

const api = vi.hoisted(() => ({ computeOverview: vi.fn(), getFrontierStatus: vi.fn() }));
vi.mock("../src/lib/api", () => api);

import CostCheckCard from "../src/components/CostCheckCard.svelte";
import ChatMessage from "../src/components/ChatMessage.svelte";
import PremiumModelHint from "../src/components/PremiumModelHint.svelte";

const ARGS = {
  question: "This reply has used 160 cSats (read 210K tokens, wrote 3K).",
  waste: "This reply re-read 3 files it had already read.",
  suggest: { id: "network/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", factor: 5 },
  switchLabel: "Switch to DeepSeek V4.1 Flash (~5× cheaper)",
};

describe("CostCheckCard", () => {
  it("asks with Keep going · Switch · Stop and answers once", async () => {
    const onChoice = vi.fn();
    render(CostCheckCard, { id: "cost_1", args: ARGS, pending: true, onChoice });
    expect(screen.getByRole("group", { name: /Keep going\? This reply has used 160 cSats/ })).toBeTruthy();
    expect(screen.getByText(ARGS.waste)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Switch to DeepSeek V4.1 Flash (~5× cheaper)" }));
    expect(onChoice).toHaveBeenCalledWith("cost_1", "switch", ARGS.suggest);
    // Answered: the buttons go, one quiet line stays.
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("note").textContent).toContain(ARGS.question);
  });

  it("Keep going and Stop; no Switch where it can't be carried", async () => {
    const onChoice = vi.fn();
    render(CostCheckCard, { id: "cost_2", args: ARGS, pending: true, onChoice, canSwitch: false });
    expect(screen.queryByRole("button", { name: /Switch to/ })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onChoice).toHaveBeenCalledWith("cost_2", "stop", undefined);
  });

  it("passes axe (named group, real buttons)", async () => {
    const { container } = render(CostCheckCard, { id: "cost_4", args: ARGS, pending: true, onChoice: () => {} });
    const r = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it("answered elsewhere: shows what was chosen", () => {
    render(CostCheckCard, { id: "cost_3", args: ARGS, pending: false, result: "Kept going" });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("note").textContent).toContain("Kept going");
  });
});

describe("ChatMessage with a cost check", () => {
  const events = [{ type: "tool_call" as const, id: "cost_1", tool: "cost_check", args: ARGS, requires_approval: true, approval_status: "pending" as const }];

  it("the app's turn: Switch goes to onCostChoice; cost notes show while streaming", async () => {
    const onCostChoice = vi.fn();
    render(ChatMessage, { role: "assistant", content: "", streaming: true, toolEvents: events, onCostChoice, costNotes: ["Skipped re-reading 3 unchanged files · ~90K tokens saved"] });
    expect(screen.getByText("Skipped re-reading 3 unchanged files · ~90K tokens saved")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Keep going" }));
    expect(onCostChoice).toHaveBeenCalledWith("cost_1", "continue", undefined);
  });

  it("without onCostChoice (a phone-started turn): Keep going / Stop through the approval", async () => {
    const onToolApproval = vi.fn();
    render(ChatMessage, { role: "assistant", content: "", streaming: true, toolEvents: events, onToolApproval });
    expect(screen.queryByRole("button", { name: /Switch to/ })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onToolApproval).toHaveBeenCalledWith("cost_1", false);
  });
});

describe("PremiumModelHint", () => {
  const glm = { model: "glm-5.3", cloudHint: "premium", cSatsPerMTokens: { input: 1034, output: 3250, cachedInput: 192 } };
  const flash = { model: "deepseek-v4.1-flash", cSatsPerMTokens: { input: 222, output: 886, cachedInput: 4.4 } };
  const load = () => Promise.resolve({ models: [glm, flash], frontierModels: ["frontier/anthropic/claude-opus-5-5"] });
  beforeEach(() => localStorage.clear());

  it("shows once per chat under the composer, and can be dismissed", async () => {
    const first = render(PremiumModelHint, { choice: "network/glm-5.3", chatId: "chat-a", load });
    const note = await screen.findByTestId("premium-hint");
    expect(note.textContent).toContain("GLM-5.3 costs ~5× Flash for exploring; Flash or Claude (your key) may fit better.");
    await fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("premium-hint")).toBeNull();
    first.unmount();
    // The same chat again: no nag.
    render(PremiumModelHint, { choice: "network/glm-5.3", chatId: "chat-a", load });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("premium-hint")).toBeNull();
  });

  it("not for a cheap or free model", async () => {
    render(PremiumModelHint, { choice: "network/deepseek-v4.1-flash", chatId: "chat-b", load });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("premium-hint")).toBeNull();
    render(PremiumModelHint, { choice: "qwen3:8b", chatId: "chat-c", load });
    await waitFor(() => expect(screen.queryByTestId("premium-hint")).toBeNull());
  });
});
