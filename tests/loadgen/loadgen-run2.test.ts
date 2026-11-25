import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { IN_MACHINE_SCRIPT, fetchServerSeries, flyEnv, inMachineScript } from "../../scripts/loadgen/capacity.mjs";
import { recentDecisions, recordPlacement } from "../../src/swarm/coordinator/routing.js";

/*
 * Load-test run 2: report.mjs reads the server-side series inside the seeds (internal-only route)
 * with fly.sh's auth order; fly.sh lets buyers call any model unless --self-avoid; named calls
 * without a portal coordinator choice still leave a routing decision.
 */

const here = (p: string) => readFileSync(new URL(`../../scripts/loadgen/${p}`, import.meta.url), "utf8");

describe("report.mjs server side", () => {
  it("builds a series script for the range; the default script is unchanged", () => {
    expect(inMachineScript()).toBe(IN_MACHINE_SCRIPT);
    const s = inMachineScript({ range: "6h", series: true });
    expect(s).toContain("/admin/network?range=6h");
    expect(s).toContain("j.series");
    expect(s).not.toMatch(/console\.log\([^)]*\bt\b\s*\)/);
    expect(() => inMachineScript({ range: "1h;rm" })).toThrow(/bad range/);
  });

  it("fetches each coordinator's series over fly ssh, script on stdin, and reports errors per coordinator", () => {
    const series = { bucketMs: 15000, points: [{ atMs: 1, totalSlots: 4, freeSlots: 2 }] };
    const inputs: string[] = [];
    const run = vi.fn((_cmd: string, args: string[], o: { input?: string }) => {
      if (args[0] === "auth") return "";
      const app = args[args.indexOf("-a") + 1];
      if (app === "edgecoder-seed-eu") throw new Error("Error: no machines");
      inputs.push(o.input ?? "");
      return `EDGECODER_SNAPSHOT ${JSON.stringify({ coordinator: { region: "iad", uptimeSeconds: 9 }, series })}\n`;
    });
    const out = fetchServerSeries(["https://coordinator.edgecoder.io", "https://coordinator-eu.edgecoder.io"], "1h", { run });
    expect(out["https://coordinator.edgecoder.io"]).toEqual({ region: "iad", uptimeSeconds: 9, bucketMs: 15000, points: series.points });
    expect(out["https://coordinator-eu.edgecoder.io"].error).toMatch(/edgecoder-seed-eu.*no machines/);
    expect(inputs[0]).toContain("range=1h");
  });

  it("report.mjs uses capacity.mjs's fly auth and never queries /admin/network over public ingress", () => {
    const src = here("report.mjs");
    expect(src).not.toContain('".config/edgecoder/fly.token"');
    expect(src).toContain("flyEnv }");
    expect(src).not.toMatch(/fetch\(`\$\{c\}\/admin\/network/);
    expect(src).toContain("fetchServerSeries(");
  });

  it("flyEnv keeps a working fly login over the token file", () => {
    const prev = process.env.FLY_API_TOKEN;
    delete process.env.FLY_API_TOKEN;
    try {
      const e = flyEnv(vi.fn(() => "") as never);
      expect(e.FLY_API_TOKEN).toBeUndefined();
    } finally { if (prev !== undefined) process.env.FLY_API_TOKEN = prev; }
  });
});

describe("fly.sh buyers", () => {
  it("does not make buyers avoid their own models unless --self-avoid", () => {
    const src = here("fly.sh");
    expect(src).toContain("--self-avoid) self_avoid=1");
    expect(src).toMatch(/avoid="\{\}"\n[\s\S]*if \[ -n "\$self_avoid" \]; then\n\s*avoid=\$\(/);
  });
});

describe("named-call routing decisions", () => {
  it("records a decision without a portal coordinator choice", () => {
    const d = recordPlacement("task-run2", "sub-run2", { model: "qwen2.5-coder:1.5b", computeClass: null });
    expect(d.pinned).toBe(true);
    expect(d.coordinatorChoice).toBeUndefined();
    expect(d.reason).toMatch(/no portal coordinator choice/);
    expect(recentDecisions(50).some((x) => x.taskId === "task-run2")).toBe(true);
  });
});
