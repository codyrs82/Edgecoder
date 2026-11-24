import { afterEach, describe, expect, it, vi } from "vitest";
import { IN_MACHINE_SCRIPT, SEED_APPS, fetchSnapshots, parseInMachineOutput } from "../../scripts/loadgen/capacity.mjs";
import { balanceAction, pinWeights } from "../../scripts/loadgen/planner.mjs";
import { snapshotLedger } from "../../scripts/loadgen/money.mjs";

/*
 * #513: /admin/network is internal-only (403 admin_internal_only on public URLs), so capacity.mjs
 * reads it inside the seed machines over fly ssh and fails loudly otherwise; a buyer is not stopped
 * for low_balance because of its own in-flight reserves; --model pins the mix.
 */

const snap = { models: [{ model: "qwen2.5-coder:1.5b", slots: 4, freeSlots: 2, agents: 1 }], agents: [] };
const forbidden = () => new Response(JSON.stringify({ error: "admin_internal_only", reason: "public_ingress" }), { status: 403 });

afterEach(() => vi.unstubAllGlobals());

describe("capacity over fly ssh", () => {
  it("falls back to the seed app on 403, with the script on stdin and no token in the command", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => forbidden()));
    const calls: Array<{ args: string[]; input: string }> = [];
    const run = vi.fn((cmd: string, args: string[], o: { input?: string }) => {
      if (args[0] === "auth") return "";
      calls.push({ args, input: o.input ?? "" });
      return `Connecting...\nEDGECODER_SNAPSHOT ${JSON.stringify(snap)}\n`;
    });
    const out = await fetchSnapshots("tok", Object.keys(SEED_APPS), { run });
    expect(out.map((s) => s.models[0].slots)).toEqual([4, 4]);
    expect(calls.map((c) => c.args[c.args.indexOf("-a") + 1])).toEqual(["edgecoder-seed", "edgecoder-seed-eu"]);
    for (const c of calls) {
      expect(c.input).toBe(IN_MACHINE_SCRIPT);
      expect(c.args.join(" ")).not.toContain("tok");
    }
  });

  it("throws with the reason and the fix instead of returning nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => forbidden()));
    const run = vi.fn(() => { throw new Error("Error: verify: root banned"); });
    await expect(fetchSnapshots("tok", ["https://coordinator.edgecoder.io"], { run })).rejects.toThrow(/admin_internal_only.*root banned.*fly auth login/);
    await expect(fetchSnapshots("tok", ["https://coordinator.edgecoder.io"], { viaFly: false })).rejects.toThrow(/http_403 admin_internal_only/);
  });

  it("parses the in-machine output and its errors; the script never prints the token", () => {
    expect(parseInMachineOutput(`x\nEDGECODER_SNAPSHOT ${JSON.stringify(snap)}`)).toEqual(snap);
    expect(() => parseInMachineOutput("EDGECODER_ERROR http_401 unauthorized")).toThrow(/http_401/);
    expect(() => parseInMachineOutput("nothing")).toThrow(/no snapshot/);
    expect(IN_MACHINE_SCRIPT).not.toMatch(/console\.log\([^)]*\bt\b\s*\)/);
  });

  it("ledger snapshots record why hosting is unknown", async () => {
    const s = await snapshotLedger({ url: "http://x", accounts: [], fetchSnapshots: async () => { throw new Error("boom"); }, adminToken: "" });
    expect(s.hosts).toBeNull();
    expect(s.hostsError).toBe("boom");
  });
});

describe("low_balance", () => {
  it("pauses, not stops, while the buyer's own calls are in flight", () => {
    expect(balanceAction({ balance: 90, spent: 0, inflight: 3, minBalance: 100 })).toBe("pause");
    expect(balanceAction({ balance: 90, spent: 0, inflight: 0, minBalance: 100 })).toBe("stop");
    expect(balanceAction({ balance: 250, spent: 3, inflight: 5, minBalance: 100 })).toBe("ok");
    expect(balanceAction({ balance: null, inflight: 0, minBalance: 100 })).toBe("ok");
  });
  it("honours --min-balance", () => {
    expect(balanceAction({ balance: 120, spent: 0, inflight: 0, minBalance: 100 })).toBe("ok");
    expect(balanceAction({ balance: 120, spent: 0, inflight: 0, minBalance: 1500 })).toBe("stop");
  });
});

describe("--model", () => {
  it("pins the mix to one model", () => {
    const mix = { "network/qwen2.5-coder:7b": 2, auto: 1 };
    expect(pinWeights(mix, "")).toBe(mix);
    expect(pinWeights(mix, "qwen2.5-coder:1.5b")).toEqual({ "network/qwen2.5-coder:1.5b": 1 });
    expect(pinWeights(mix, "network/qwen3-coder:30b")).toEqual({ "network/qwen3-coder:30b": 1 });
  });
});
