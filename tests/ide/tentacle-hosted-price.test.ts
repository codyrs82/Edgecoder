// Network run 13: helpers on the hosted endpoint (`edgecoder code` with an API key) wait for room in
// the session's budget when the network refuses a call for its price ceiling, as network helpers do
// (run 12). Helper tc4ce121 was refused with "every fitting model costs more than the 1.237 cSats
// ceiling (the cheapest, deepseek-v4.1-flash on cloud, is about 3.901 cSats)" while the other
// helpers' calls held the rest of the 100 cSat budget, and failed: the hosted error carried only its
// message, so the wait never started.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "../../src/apps/ide/checkpoints.js";
import { hostedBackend, hostedErrorInfo } from "../../src/apps/ide/hosted-backend.js";
import { SessionHub, type ClientRef } from "../../src/apps/ide/sessions.js";
import { priceRefusalNeed } from "../../src/apps/ide/tentacle-reserve.js";
import { TentacleManager } from "../../src/apps/ide/tentacles.js";
import { ChatBackendError } from "../../src/inference-api/types.js";

const TERM: ClientRef = { clientId: "term-1", kind: "terminal", label: "Terminal" };
const RUN13 = "No model on the network fits this request: every fitting model costs more than the 1.237 cSats ceiling (the cheapest, deepseek-v4.1-flash on cloud, is about 3.901 cSats).";
let root: string;
let tmp: string;
let server: Server | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "thp-proj-"));
  tmp = mkdtempSync(join(tmpdir(), "thp-ws-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a]);
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "alpha\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
afterEach(() => {
  server?.close();
  server = null;
  rmSync(root, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

describe("hosted price refusals as data", () => {
  it("reads the run-13 refusal from the message of an endpoint that sends only that", () => {
    const info = hostedErrorInfo(undefined, RUN13);
    expect(info).toEqual({ code: "no_route_fits", reason: "price", neededCSats: 3.901, computeClass: "cloud" });
    expect(priceRefusalNeed(new ChatBackendError(RUN13, 404, undefined, info))).toBe(3.901);
    expect(hostedErrorInfo(undefined, "No machine on the network can run qwen3:8b")).toBeUndefined();
  });

  it("takes the endpoint's own data first", () => {
    expect(hostedErrorInfo({ code: "no_route_fits", reason: "price", neededCSats: 4.2, computeClass: "gpu" }, RUN13)).toEqual({ code: "no_route_fits", reason: "price", neededCSats: 4.2, computeClass: "gpu" });
  });
});

describe("run 13: a hosted helper refused for its ceiling waits for the other helpers' holds", { timeout: 60_000 }, () => {
  for (const sendsData of [false, true]) {
    it(sendsData ? "endpoint sends the refusal as data" : "endpoint sends only the message (the portal in run 13)", async () => {
      const ceilings: Record<string, number[]> = {};
      server = createServer((req, res) => {
        let raw = "";
        req.on("data", (d) => (raw += d));
        req.on("end", async () => {
          const body = JSON.parse(raw) as { messages: Array<{ role: string; content: unknown }>; edgecoder?: { maxCSats?: number } };
          const task = /# Task\n(.*)/.exec(String(body.messages.find((m) => m.role === "user")?.content ?? ""))?.[1] ?? "";
          const ceiling = body.edgecoder?.maxCSats ?? 0;
          (ceilings[task] ??= []).push(ceiling);
          if (ceiling < 3.901) {
            res.writeHead(404, { "content-type": "application/json" });
            const message = RUN13.replace("1.237", String(ceiling));
            res.end(JSON.stringify({ error: { message, type: "api_error", code: 404, ...(sendsData ? { edgecoder: { code: "no_route_fits", reason: "price", neededCSats: 3.901, computeClass: "cloud" } } : {}) } }));
            return;
          }
          const first = !body.messages.some((m) => m.role === "assistant");
          // The first helper's first call runs a while, holding 25 of the session's 28 cSats.
          if (first && task === "slow") await new Promise((r) => setTimeout(r, 4_000));
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
          if (first) chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "write_file", arguments: JSON.stringify({ path: `${task}.txt`, content: "x\n" }) } }] }, finish_reason: "tool_calls" }], edgecoder: { cSatsSpent: 0.5 } });
          else chunk({ choices: [{ delta: { content: `wrote ${task}` }, finish_reason: "stop" }], edgecoder: { cSatsSpent: 0.5 } });
          res.end("data: [DONE]\n\n");
        });
      });
      await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
      const port = (server.address() as { port: number }).port;
      const hub = new SessionHub({ chat: () => async () => ({ content: "", toolCalls: [] }), systemPrompt: async () => "s", checkpoints: new CheckpointStore(), branch: () => "main" } as never, { dir: null, permissionsFile: null });
      const tentacles = new TentacleManager({
        host: { session: (id) => hub.peek(id), publishEvent: (id, ev) => hub.publishEvent(id, ev), recordNote: (id, note) => hub.recordNote(id, note) },
        workerBackend: (model) => hostedBackend({ baseUrl: `http://127.0.0.1:${port}`, apiKey: () => "eck_test" }, model),
        checkpoints: new CheckpointStore(),
        tmpRoot: tmp,
        config: { enabled: true, maxParallel: 4, budgetCSats: 28, perTentacleCSats: 25, workerModel: "network/deepseek-v4.1-flash", maxContextChars: 20_000, localFirst: false },
      });
      const s = hub.create({ projectRoot: root, client: TERM, autoApprove: "edits" });
      const a = tentacles.delegate(s.id, { task: "slow", kind: "code_edit", files: [], instructions: "" });
      await new Promise((r) => setTimeout(r, 50));
      const b = tentacles.delegate(s.id, { task: "second", kind: "code_edit", files: [], instructions: "" });
      await tentacles.idle(s.id);
      expect(tentacles.get(s.id, a.id)!.status).toBe("passed");
      const t = tentacles.get(s.id, b.id)!;
      // Before: "error", the run-13 message, and the lead wrote the file itself.
      expect(t.status, t.result?.error).toBe("passed");
      expect(ceilings.second[0]).toBeLessThan(3.901);
      expect(ceilings.second[1]).toBeGreaterThanOrEqual(3.901 * 1.05 - 1e-9);
    });
  }
});

describe("run 13: the delegate note says what the session's budget left covers", () => {
  it("before any helper finished: at each helper's own budget (8 helpers × 25 against 100)", async () => {
    const { budgetCoverage } = await import("../../src/apps/ide/delegate.js");
    // The 4th of 8: 4 × 25 fits 100, nothing to say.
    expect(budgetCoverage({ left: 100, open: 4, perTentacle: 25 })).toBeNull();
    // The 8th: 8 × 25 = 200 against 100.
    const note = budgetCoverage({ left: 100, open: 8, perTentacle: 25 })!;
    expect(note).toMatch(/The 8 helpers not finished may each spend up to 25 cSats \(200 cSats in all\): the budget left covers 4 at that most/);
    expect(note).toMatch(/budget reached/);
  });

  it("with helpers finished: at their average (run 13's seven averaged ~9.1 cSats; 8 fit 100)", async () => {
    const { budgetCoverage } = await import("../../src/apps/ide/delegate.js");
    expect(budgetCoverage({ left: 36, open: 1, perTentacle: 25, average: 9.1 })).toBeNull();
    expect(budgetCoverage({ left: 20, open: 4, perTentacle: 25, average: 9.1 })).toMatch(/covers about 2 of the 4 helpers not finished/);
  });
});
