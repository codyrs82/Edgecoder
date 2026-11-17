import { describe, expect, it } from "vitest";
import { get } from "svelte/store";
import type { ComputeOverview } from "../src/lib/api";
import { availabilityLine, classAvailability, classFamily, modelsInClass, unavailableTitle, unavailableWarning } from "../src/lib/compute-availability";
import { buyRequest, lowBalance, neededCSatsIn, openWalletRequest, requestBuy, suggestedTopUpSats } from "../src/lib/buy-csats";
import { FAILURE_LINE, collapseFailures, failureKind, splitModelError } from "../src/lib/failures";

/** The network on the day of the report: one A100 (gpu.dc), two Macs, nine CPU machines, no consumer GPU. */
const ov: ComputeOverview = {
  connected: true,
  classes: {
    cpu: { label: "CPU", cSatsPerSecondBaseTier: 1, agents: 9 },
    apple: { label: "Apple", cSatsPerSecondBaseTier: 3, agents: 2 },
    gpu: { label: "GPU", cSatsPerSecondBaseTier: 4, agents: 0 },
    "gpu.dc": { label: "Datacenter GPU", cSatsPerSecondBaseTier: 8, agents: 1 },
  },
  models: [
    { model: "qwen3-coder:30b", agents: 3, agentsByClass: { "gpu.dc": 1, apple: 2 }, classes: ["gpu.dc", "apple"] },
    { model: "qwen2.5-coder:7b", agents: 9, agentsByClass: { cpu: 9 }, classes: ["cpu"] },
    { model: "secret:70b", agents: 1, classes: ["gpu"], restricted: "security" },
  ],
};

describe("class availability", () => {
  it("counts machines per class; GPU is any GPU", () => {
    expect(classFamily("gpu")).toEqual(["gpu", "gpu.dc"]);
    expect(classAvailability(ov, "gpu")).toEqual({ state: "available", online: 1, models: ["qwen3-coder:30b"] });
    expect(classAvailability(ov, "cpu")).toEqual({ state: "available", online: 9, models: ["qwen2.5-coder:7b"] });
    expect(classAvailability(ov, undefined)).toMatchObject({ state: "available", online: 12 });
    expect(availabilityLine(classAvailability(ov, "apple"))).toBe("2 online · qwen3-coder:30b");
  });

  it("a class with nothing online is none; a restricted model doesn't count", () => {
    const noDc: ComputeOverview = { ...ov, classes: { ...ov.classes, "gpu.dc": { label: "Datacenter GPU", cSatsPerSecondBaseTier: 8, agents: 0 } }, models: ov.models!.map((m) => ({ ...m, classes: m.classes.filter((c) => c !== "gpu.dc") })) };
    expect(classAvailability(noDc, "gpu")).toEqual({ state: "none" });
    expect(classAvailability(noDc, "gpu.dc")).toEqual({ state: "none" });
    expect(availabilityLine({ state: "none" })).toBe("None online");
    expect(unavailableTitle("gpu")).toBe("No GPU machines on the network right now");
    expect(unavailableWarning("gpu.dc")).toBe("No Datacenter GPU machines online: runs will fail until one is back. Choose another option.");
  });

  it("with a model chosen: machines of the class serving that model", () => {
    expect(classAvailability(ov, "apple", "network/qwen3-coder:30b")).toEqual({ state: "available", online: 2, models: ["qwen3-coder:30b"] });
    expect(classAvailability(ov, "cpu", "network/qwen3-coder:30b")).toEqual({ state: "none" });
    expect(modelsInClass(ov, "gpu")).toEqual(["qwen3-coder:30b"]);
    expect(modelsInClass(ov, "cpu")).toEqual(["qwen2.5-coder:7b"]);
    expect(modelsInClass(ov, undefined)).toBeNull();
  });

  it("offline, not signed in or no answer: unknown, never 'none'", () => {
    expect(classAvailability(null, "gpu")).toEqual({ state: "unknown" });
    expect(classAvailability({ connected: false }, "gpu")).toEqual({ state: "unknown" });
    expect(classAvailability({ connected: true }, "gpu")).toEqual({ state: "unknown" });
    expect(availabilityLine({ state: "unknown" })).toBe("Availability unknown");
  });

  it("an older coordinator without counts: online, count unknown", () => {
    const old: ComputeOverview = { connected: true, models: [{ model: "qwen3-coder:30b", agents: 3, classes: ["gpu.dc", "apple"] }] };
    expect(classAvailability(old, "gpu")).toEqual({ state: "available", online: null, models: ["qwen3-coder:30b"] });
    expect(availabilityLine(classAvailability(old, "gpu"))).toBe("Online · qwen3-coder:30b");
    expect(classAvailability(old, "cpu")).toEqual({ state: "none" });
  });
});

describe("Buy cSats", () => {
  it("suggests about a day of the budget or the step × 20, rounded up to 5k / 20k / 100k", () => {
    expect(suggestedTopUpSats()).toBe(5_000);
    expect(suggestedTopUpSats({ budgetCSatsPerDay: 100 })).toBe(5_000);
    expect(suggestedTopUpSats({ budgetCSatsPerDay: 8_000 })).toBe(20_000);
    expect(suggestedTopUpSats({ stepCSats: 2_000 })).toBe(100_000);
    expect(suggestedTopUpSats({ budgetCSatsPerDay: 1_000_000 })).toBe(100_000);
    expect(neededCSatsIn("This step needs about 0.4 cSats on a Datacenter GPU.")).toBe(0.4);
  });

  it("a request opens the Wallet with the amount and where to go back to", () => {
    const before = get(openWalletRequest);
    requestBuy({ amountSats: 20_000, returnTo: "Harry" });
    expect(get(buyRequest)).toEqual({ amountSats: 20_000, returnTo: "Harry" });
    expect(get(openWalletRequest)).toBe(before + 1);
    buyRequest.set(null);
  });

  it("low: under about ten typical calls (under 1 cSat without prices); zero is out, not low", () => {
    expect(lowBalance(0.5)).toBe(true);
    expect(lowBalance(5)).toBe(false);
    expect(lowBalance(0)).toBe(false);
    expect(lowBalance(null)).toBe(false);
  });
});

describe("failures: one error, one place", () => {
  it("kinds", () => {
    expect(failureKind("Not enough cSats: your balance is 0.01 cSats.")).toBe("csats");
    expect(failureKind("No model on the network fits this request: every fitting model costs more than the 0.012 cSats ceiling.")).toBe("csats");
    expect(failureKind("No GPU machines online. Available now: CPU (9).")).toBe("class");
    expect(failureKind("Network GPU only: no cSats left today (budget 100).")).toBe("budget");
    expect(failureKind("This computer isn't connected to the network")).toBe("offline");
    expect(failureKind("boom")).toBe("other");
  });

  it("splits the model error off a reply", () => {
    expect(splitModelError("Error contacting model: Not enough cSats: x.")).toEqual({ text: "", error: "Not enough cSats: x." });
    expect(splitModelError("I read the file.\n\nError contacting model: boom\n\n(edited a.ts.)")).toEqual({ text: "I read the file.", error: "boom" });
    expect(splitModelError("Error: Not enough cSats: y")).toEqual({ text: "", error: "Not enough cSats: y" });
    expect(splitModelError("All good.")).toEqual({ text: "All good." });
  });

  it("collapses the same failure run after run into one line with a count", () => {
    type M = { id: string; role: "event" | "assistant" | "user"; content: string };
    const msgs: M[] = [
      { id: "e1", role: "event", content: "Check-in" },
      { id: "a1", role: "assistant", content: "Error contacting model: Not enough cSats: a" },
      { id: "e2", role: "event", content: "Check-in" },
      { id: "a2", role: "assistant", content: "Error contacting model: Not enough cSats: b" },
      { id: "e3", role: "event", content: "Check-in" },
      { id: "a3", role: "assistant", content: "Error contacting model: Not enough cSats: c" },
      { id: "u1", role: "user", content: "hi" },
      { id: "a4", role: "assistant", content: "Error contacting model: No GPU machines online." },
    ];
    const rows = collapseFailures(
      msgs,
      (m) => (m.role === "assistant" && splitModelError(m.content).error ? { id: m.id, error: splitModelError(m.content).error! } : null),
      (m) => m.role === "event",
    );
    expect(rows.map((r) => (r.kind === "item" ? r.item.id : `${FAILURE_LINE[r.failure]} ×${r.count}`))).toEqual([
      "e1",
      "Couldn't run: out of cSats ×3",
      "u1",
      "Couldn't run: no machines of that class online ×1",
    ]);
  });
});
