// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Simulated buyers. Everything a buyer does goes through the same front doors a real one uses:
 *   - top-up: portal POST /v1/account/topup (API key) -> coordinator invoice on the hub LND; the
 *     payee LND pays it; GET /v1/account/topup/:id until settled.
 *   - inference: portal POST /v1/chat/completions (API key, model network/<model>).
 *   - reservations: portal /v1/account/reservations (+ /cancel).
 *   - code tasks: a signed POST /submit from an agent identity the buyer enrolled under its own
 *     account (the coordinator bills the signer's owner), results read with the mesh token.
 *   - market: signed POST /economy/market/orders for the buyer's own account.
 *   - withdrawals (providers, local only): coordinator POST /economy/payouts/withdraw with the
 *     portal service token, i.e. what the portal sends after its emailed-code step.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { SimAgent, newSharedState, type AgentSharedState } from "./agent.js";
import { call, sleep, type CallResult } from "./http.js";
import type { LndClient } from "./lnd.js";
import type { Recorder } from "./metrics.js";
import type { AccountCred, CoordinatorTarget } from "./target.js";

export interface TaskOutcome {
  taskId: string;
  coordinatorId: string;
  submittedAtMs: number;
  subtaskIds: string[];
  status: "submitted" | "rejected" | "completed" | "failed" | "timeout";
  submitOutcome: string;
  completedAtMs?: number;
  /** Error a failed subtask reported ("simulated_failure" = injected by the harness). */
  error?: string;
}

export class SimBuyer {
  private submitters = new Map<string, SimAgent>();
  private submitterStarts = new Map<string, Promise<SimAgent | null>>();
  readonly tasks: TaskOutcome[] = [];
  readonly topups: Array<{ intentId?: string; amountSats: number; outcome: string; paid: boolean; settled: boolean; settleMs?: number; paymentHashHex?: string }> = [];

  constructor(
    readonly account: AccountCred,
    private readonly portalUrl: string,
    private readonly coordinators: CoordinatorTarget[],
    private readonly rec: Recorder,
    private readonly runId: string,
    private readonly index: number,
    private readonly shared: AgentSharedState = newSharedState()
  ) {}

  private portal(path: string): string {
    return `${this.portalUrl.replace(/\/$/, "")}${path}`;
  }

  private auth(): Record<string, string> {
    return { authorization: `Bearer ${this.account.apiKey}` };
  }

  /** The buyer's signed identity on one coordinator (enrolled under the buyer's account, never pulls). */
  async submitter(coordinator: CoordinatorTarget): Promise<SimAgent | null> {
    // One start per coordinator even when many calls race (each enrolment rotates the token).
    let p = this.submitterStarts.get(coordinator.id);
    if (!p) {
      p = this.startSubmitter(coordinator);
      this.submitterStarts.set(coordinator.id, p);
    }
    return p;
  }

  private async startSubmitter(coordinator: CoordinatorTarget): Promise<SimAgent | null> {
    const a = new SimAgent(
      {
        runId: this.runId,
        index: 9000 + this.index * 10 + this.coordinators.indexOf(coordinator),
        owner: this.account,
        coordinator,
        portalUrl: this.portalUrl,
        behaviour: "honest",
        sandboxMode: "none",
        models: [],
        latency: { medianMs: 0, sigma: 0 },
        failureRate: 0,
        heartbeatMs: 20_000,
        idlePollMs: 1_000,
        pulls: false
      },
      this.rec,
      this.shared
    );
    if (!(await a.start())) return null;
    this.submitters.set(coordinator.id, a);
    return a;
  }

  stop(): void {
    for (const a of this.submitters.values()) a.stop();
  }

  async balance(): Promise<number | undefined> {
    const r = await call(this.rec, "GET /v1/account [portal]", this.portal("/v1/account"), { headers: this.auth() });
    return r.status === 200 ? Number(r.json?.cSats ?? 0) : undefined;
  }

  /** Buy cSats over Lightning: invoice from the coordinator, paid by the payee node, polled to settled. */
  async topup(amountSats: number, payer: LndClient, opts: { pollMs?: number; timeoutMs?: number } = {}): Promise<boolean> {
    const r = await call(this.rec, "POST /v1/account/topup [portal]", this.portal("/v1/account/topup"), { body: { amountSats }, headers: this.auth() });
    const entry: (typeof this.topups)[number] = { amountSats, outcome: r.outcome, paid: false, settled: false };
    this.topups.push(entry);
    if (r.status !== 200 || !r.json?.invoice) return false;
    entry.intentId = r.json.intentId;
    const started = Date.now();
    const pay = await payer.payInvoice(r.json.invoice);
    entry.paid = pay.ok;
    entry.paymentHashHex = pay.paymentHashHex;
    if (!pay.ok) {
      this.rec.addEvidence({ endpoint: "lnd pay (topup)", outcome: "failed", note: `payee could not pay top-up invoice for ${amountSats} sats: ${pay.error}` });
      return false;
    }
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
    while (Date.now() < deadline) {
      const s = await call(this.rec, "GET /v1/account/topup/:id [portal]", this.portal(`/v1/account/topup/${encodeURIComponent(entry.intentId!)}`), { headers: this.auth() });
      if (s.json?.status === "settled") {
        entry.settled = true;
        entry.settleMs = Date.now() - started;
        this.rec.record("topup settle (paid -> settled)", entry.settleMs, "200");
        return true;
      }
      await sleep(opts.pollMs ?? 1_000);
    }
    this.rec.record("topup settle (paid -> settled)", Date.now() - started, "0:timeout", { note: `intent ${entry.intentId} paid but not settled within the timeout` });
    return false;
  }

  /** A code task through the buyer's signed identity on `coordinator`. */
  async submitTask(coordinator: CoordinatorTarget, prompt: string, extra: Record<string, unknown> = {}): Promise<TaskOutcome> {
    const taskId = `stress-${this.runId}-t-${randomUUID().slice(0, 12)}`;
    const outcome: TaskOutcome = { taskId, coordinatorId: coordinator.id, submittedAtMs: Date.now(), subtaskIds: [], status: "submitted", submitOutcome: "" };
    this.tasks.push(outcome);
    const sub = await this.submitter(coordinator);
    if (!sub) {
      outcome.status = "rejected";
      outcome.submitOutcome = "submitter_unavailable";
      return outcome;
    }
    const body = {
      taskId,
      prompt,
      language: "python",
      snapshotRef: randomBytes(20).toString("hex"),
      submitterAccountId: this.account.accountId,
      resourceClass: "cpu",
      computeClass: "any",
      ...extra
    };
    let r = await sub.signedPost("/submit", body);
    if (r.status === 401) {
      // The coordinator restarted and forgot this identity: register again (as a real client would) and retry once.
      this.rec.count("submitter.reregister");
      if (await sub.register(true)) r = await sub.signedPost("/submit", body);
    }
    outcome.submitOutcome = r.outcome;
    if (r.status !== 200) {
      outcome.status = "rejected";
      return outcome;
    }
    outcome.subtaskIds = r.json?.subtasks ?? [];
    return outcome;
  }

  /** Poll each subtask's result until it is published, failed or the deadline passes. */
  async awaitTask(t: TaskOutcome, deadlineMs: number, pollMs = 2_000): Promise<void> {
    const coordinator = this.coordinators.find((c) => c.id === t.coordinatorId)!;
    const sub = await this.submitter(coordinator);
    if (!sub || t.status !== "submitted") return;
    const pending = new Set(t.subtaskIds);
    let failed = false;
    while (pending.size && Date.now() < deadlineMs) {
      for (const id of [...pending]) {
        const r = await sub.meshGet(`/tasks/${encodeURIComponent(t.taskId)}/subtasks/${encodeURIComponent(id)}/result`, `GET /tasks/:t/subtasks/:s/result [${coordinator.id}]`, [404]);
        if (r.status === 200 && r.json && (r.json.result || r.json.ok !== undefined || r.json.output !== undefined)) {
          const res = r.json.result ?? r.json;
          if (res.ok === false) {
            failed = true;
            t.error = String(res.error ?? "failed");
          }
          pending.delete(id);
        }
      }
      if (pending.size) await sleep(pollMs);
    }
    if (pending.size) t.status = "timeout";
    else {
      t.status = failed ? "failed" : "completed";
      t.completedAtMs = Date.now();
      this.rec.record("task end-to-end (submit -> result)", t.completedAtMs - t.submittedAtMs, !failed ? "200" : t.error === "simulated_failure" ? "expected:500:simulated_failure" : `500:${(t.error ?? "subtask_failed").slice(0, 60)}`);
    }
  }

  /** OpenAI-compatible chat completion through the portal (billed to the key's account). */
  async inference(model: string, prompt: string): Promise<CallResult> {
    return call(this.rec, "POST /v1/chat/completions [portal]", this.portal("/v1/chat/completions"), {
      body: { model: model.includes("/") ? model : `network/${model}`, messages: [{ role: "user", content: prompt }], max_tokens: 32 },
      headers: this.auth(),
      timeoutMs: 120_000
    });
  }

  async reserve(computeClass: string, minutes: number, model?: string): Promise<CallResult> {
    return call(this.rec, "POST /v1/account/reservations [portal]", this.portal("/v1/account/reservations"), { body: { computeClass, minutes, ...(model ? { model } : {}) }, headers: this.auth(), expected: [409] });
  }

  async cancelReservation(reservationId: string): Promise<CallResult> {
    return call(this.rec, "POST /v1/account/reservations/cancel [portal]", this.portal("/v1/account/reservations/cancel"), { body: { reservationId }, headers: this.auth() });
  }

  async listReservations(): Promise<CallResult> {
    return call(this.rec, "GET /v1/account/reservations [portal]", this.portal("/v1/account/reservations"), { headers: this.auth() });
  }

  /** Standing market order for the buyer's own account (signed by its identity). */
  async marketOrder(coordinator: CoordinatorTarget, side: "buy" | "sell", msatPerCredit: number, computeClass = "any"): Promise<CallResult | null> {
    const sub = await this.submitter(coordinator);
    if (!sub) return null;
    return sub.signedPost("/economy/market/orders", { accountId: this.account.accountId, side, computeClass, msatPerCredit });
  }
}

/** Provider withdrawal straight to the coordinator payout route (local: portal service token). */
export async function withdraw(rec: Recorder, coordinator: CoordinatorTarget, portalServiceToken: string, accountId: string, bolt11: string, label = ""): Promise<CallResult> {
  return call(rec, `POST /economy/payouts/withdraw [${coordinator.id}]${label}`, `${coordinator.url.replace(/\/$/, "")}/economy/payouts/withdraw`, {
    body: { accountId, bolt11 },
    headers: { "x-portal-service-token": portalServiceToken },
    timeoutMs: 120_000
  });
}

export async function payoutBalance(rec: Recorder, coordinator: CoordinatorTarget, portalServiceToken: string, accountId: string): Promise<CallResult> {
  return call(rec, `GET /economy/payouts/:account [${coordinator.id}]`, `${coordinator.url.replace(/\/$/, "")}/economy/payouts/${encodeURIComponent(accountId)}`, {
    headers: { "x-portal-service-token": portalServiceToken }
  });
}
