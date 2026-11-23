import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AlertRunner } from "../../src/alerting/runner.js";
import { SHARED_SOURCE } from "../../src/alerting/manager.js";
import {
  SecurityEventMonitor,
  backupMonitor,
  capacityMonitor,
  databaseMonitor,
  healthWatchMonitor,
  LN_INBOUND_RULE,
  ledgerMonitor,
  lightningInboundMonitor,
  lightningMonitor,
  lnInboundKey,
  orderingChainMonitor,
  payoutMonitor,
  probeHealth,
  purchaseMonitor,
  PurchaseSignals,
  type CapacityView,
  type LightningHealth,
  type LedgerVerification,
  type Monitor,
  type PayoutAlertQueries,
  type ProbeResult
} from "../../src/alerting/monitors.js";
import { interpretLndNodeHealth } from "../../src/economy/lightning.js";
import { SecurityEventLogger } from "../../src/audit/security-events.js";
import { harness } from "./helpers.js";

const MIN = 60_000;

/** Run one monitor every `stepMs` for `rounds` rounds against a harness with a fake clock. */
function driver(monitor: Monitor, h = harness()) {
  const runner = new AlertRunner(h.manager, [monitor], { intervalMs: 30_000, now: () => h.clock.now });
  return {
    h,
    async tick(stepMs = 30_000) {
      await runner.runOnce(monitor);
      h.advance(stepMs);
    },
    async active() {
      return (await h.manager.list()).active.map((a) => a.key).sort();
    }
  };
}

describe("1, 2. health watches: N consecutive failures, cross-watching", () => {
  it("a coordinator watching its peer alerts after 3 failed checks and resolves when it answers", async () => {
    let peerUp = false;
    const probe = async (): Promise<ProbeResult> => (peerUp ? { ok: true } : { ok: false, error: "ECONNREFUSED" });
    const d = driver(healthWatchMonitor({ name: "peer_health", what: "coordinator", targets: async () => [{ url: "https://seed-eu.example/health/runtime", label: "seed-eu.example" }], probe, failures: 3, observer: "coordinator seed-ord" }), harness({ sourceId: "coord-ord" }));
    await d.tick();
    await d.tick();
    expect(await d.active()).toEqual([]);
    await d.tick();
    expect(await d.active()).toEqual(["coordinator_down:seed-eu.example"]);
    const fired = d.h.sent[0]!;
    expect(fired.alert.title).toBe("Coordinator seed-eu.example is down or unhealthy");
    expect(fired.alert.summary).toContain("Seen from coordinator seed-ord");
    // "Since" is the first failed check, not the third.
    expect(fired.alert.firstSeenMs).toBe(d.h.clock.now - 3 * 30_000);
    peerUp = true;
    await d.tick();
    expect(await d.active()).toEqual([]);
    expect(d.h.kinds()).toEqual(["firing:coordinator_down:seed-eu.example", "resolved:coordinator_down:seed-eu.example"]);
  });

  it("with minDownMs, a deploy restart (down about a minute) never alerts; a longer outage does", async () => {
    let up = false;
    const probe = async (): Promise<ProbeResult> => (up ? { ok: true } : { ok: false, error: "ENOTFOUND" });
    const d = driver(healthWatchMonitor({ name: "peer_health", what: "coordinator", targets: async () => [{ url: "https://seed-eu.example/health/runtime", label: "seed-eu.example" }], probe, failures: 3, minDownMs: 3 * MIN, observer: "the portal" }));
    for (let i = 0; i < 3; i++) await d.tick(); // three failures over a minute: a restart
    expect(await d.active()).toEqual([]);
    up = true;
    await d.tick();
    up = false;
    for (let i = 0; i < 6; i++) await d.tick(); // first failure at t, sixth at t + 2.5 min
    expect(await d.active()).toEqual([]);
    await d.tick(); // t + 3 min
    expect(await d.active()).toEqual(["coordinator_down:seed-eu.example"]);
    expect(d.h.sent).toHaveLength(1);
  });

  it("keeps watching a peer that dropped out of the mesh list (down peers are pruned)", async () => {
    let listed = true;
    const d = driver(healthWatchMonitor({ name: "peer_health", what: "coordinator", targets: async () => (listed ? [{ url: "https://p/health/runtime", label: "p" }] : []), probe: async () => ({ ok: false, error: "timeout" }), failures: 3, observer: "x" }));
    await d.tick();
    listed = false;
    await d.tick();
    await d.tick();
    expect(await d.active()).toEqual(["coordinator_down:p"]);
  });

  it("the coordinators watch the portal and the portal watches every coordinator", async () => {
    const up = new Set(["https://seed-ord/health/runtime"]);
    const probe = async (url: string): Promise<ProbeResult> => (up.has(url) ? { ok: true } : { ok: false, error: "http_502" });
    const portalSide = driver(healthWatchMonitor({ name: "coordinator_health", what: "coordinator", targets: async () => ["https://seed-ord", "https://seed-eu"].map((u) => ({ url: `${u}/health/runtime`, label: u.slice(8) })), probe, failures: 3, observer: "the portal" }));
    const coordSide = driver(healthWatchMonitor({ name: "portal_health", what: "portal", targets: async () => [{ url: "https://portal/health", label: "portal" }], probe, failures: 3, observer: "coordinator seed-ord" }), harness({ sourceId: "coord-ord" }));
    for (let i = 0; i < 3; i++) {
      await portalSide.tick();
      await coordSide.tick();
    }
    expect(await portalSide.active()).toEqual(["coordinator_down:seed-eu"]);
    expect(await coordSide.active()).toEqual(["portal_down:portal"]);
    expect(coordSide.h.sent[0]!.alert.title).toBe("Portal is down or unhealthy");
  });

  describe("probeHealth against a real server", () => {
    let srv: FastifyInstance;
    let base = "";
    let mode: "ok" | "unhealthy" | "500" = "ok";
    beforeAll(async () => {
      srv = Fastify();
      srv.get("/health/runtime", async (_req, reply) => (mode === "500" ? reply.code(500).send({}) : { ok: mode === "ok" }));
      await srv.listen({ port: 0, host: "127.0.0.1" });
      const a = srv.server.address();
      base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    });
    afterAll(async () => srv.close());
    it("ok, ok:false, 5xx and unreachable", async () => {
      expect(await probeHealth(`${base}/health/runtime`)).toEqual({ ok: true });
      mode = "unhealthy";
      expect(await probeHealth(`${base}/health/runtime`)).toEqual({ ok: false, error: "reported_unhealthy" });
      mode = "500";
      expect(await probeHealth(`${base}/health/runtime`)).toEqual({ ok: false, error: "http_500" });
      expect((await probeHealth("http://127.0.0.1:1/health", 1_000)).ok).toBe(false);
    });
  });
});

describe("3. lightning", () => {
  const healthy = (over: Partial<LightningHealth> = {}): LightningHealth => ({ supported: true, syncedToChain: true, syncedToGraph: true, blockHeight: 900_000, activeChannels: 3, inactiveChannels: 0, pendingChannels: 0, localSats: 2_000_000, remoteSats: 2_000_000, receivableSats: 1_980_000, nodePubkey: "02aa11bb22cc33dd44ee55ff66", inactive: [], ...over });

  it("unreachable after N failures, then resolves", async () => {
    let fail = true;
    const d = driver(lightningMonitor({ getHealth: async () => { if (fail) throw new Error("lnd_http_503:/v1/getinfo"); return healthy(); }, failures: 3, minOutboundSats: 0, label: "seed-ord" }));
    await d.tick();
    await d.tick();
    expect(await d.active()).toEqual([]);
    await d.tick();
    expect(await d.active()).toEqual(["ln_unreachable"]);
    fail = false;
    await d.tick();
    expect(await d.active()).toEqual([]);
  });

  it("not synced only after 10 minutes; low liquidity at once; inactive channels after 10 minutes", async () => {
    let h = healthy({ syncedToGraph: false, localSats: 50_000, remoteSats: 0, inactiveChannels: 1, activeChannels: 2, inactive: [{ chanId: "1x2x3", remotePubkey: "02abc", localSats: 10 }] });
    const d = driver(lightningMonitor({ getHealth: async () => h, failures: 3, minOutboundSats: 100_000, label: "seed-ord" }));
    await d.tick(5 * MIN);
    expect(await d.active()).toEqual(["ln_low_outbound"]); // inbound is its own rule (lightningInboundMonitor)
    await d.tick(6 * MIN);
    await d.tick();
    expect(await d.active()).toEqual(["ln_channels_inactive", "ln_low_outbound", "ln_not_synced"]);
    const list = (await d.h.manager.list()).active;
    expect(list.find((a) => a.key === "ln_not_synced")!.title).toContain("graph");
    h = healthy();
    await d.tick();
    expect(await d.active()).toEqual([]);
  });

  it("LND getinfo + channels: liquidity counts active channels only", () => {
    const r = interpretLndNodeHealth(
      { synced_to_chain: true, synced_to_graph: false, block_height: 870_000 },
      { channels: [{ active: true, local_balance: "1000", remote_balance: "500", chan_id: "1" }, { active: false, local_balance: "7000", remote_balance: "9000", chan_id: "2", remote_pubkey: "03ff" }] }
    );
    expect(r).toMatchObject({ syncedToChain: true, syncedToGraph: false, activeChannels: 1, inactiveChannels: 1, localSats: 1000, remoteSats: 500, inactive: [{ chanId: "2", remotePubkey: "03ff", localSats: 7000 }] });
    expect(() => interpretLndNodeHealth({}, { channels: [] })).toThrow("getinfo_malformed");
  });

  it("LND channels: receivable subtracts the peer's channel reserve, never below 0", () => {
    const r = interpretLndNodeHealth(
      { synced_to_chain: true, synced_to_graph: true, identity_pubkey: "03abcdef0123456789abcdef" },
      {
        channels: [
          { active: true, remote_balance: "200000", remote_constraints: { chan_reserve_sat: "10000" } },
          { active: true, remote_balance: "50000", remote_chan_reserve_sat: "5000" }, // deprecated field as fallback
          { active: true, remote_balance: "3000", remote_constraints: { chan_reserve_sat: "10000" } }, // below reserve: 0
          { active: false, remote_balance: "900000", remote_constraints: { chan_reserve_sat: "1000" } } // inactive: excluded
        ]
      }
    );
    expect(r).toMatchObject({ remoteSats: 253_000, receivableSats: 235_000, activeChannels: 3, nodePubkey: "03abcdef0123456789abcdef" });
  });
});

describe("3b. lightning inbound capacity", () => {
  const PUBKEY = "02aa11bb22cc33dd44ee55ff66";
  const KEY = lnInboundKey(PUBKEY);
  const health = (receivableSats: number, over: Partial<LightningHealth> = {}): LightningHealth => ({ supported: true, syncedToChain: true, syncedToGraph: true, blockHeight: 900_000, activeChannels: 2, inactiveChannels: 0, pendingChannels: 0, localSats: 1_000_000, remoteSats: receivableSats + 20_000, receivableSats, nodePubkey: PUBKEY, inactive: [], ...over });

  /** A coordinator's inbound monitor on a harness; isActive reads the shared incident like production. */
  function inbound(getHealth: () => Promise<LightningHealth | { supported: false; reason: string }>, h = harness({ sourceId: "seed-a", renotifyMs: 4 * 3_600_000 }), over: { thresholdSats?: number } = {}) {
    const monitor = lightningInboundMonitor({
      getHealth,
      thresholdSats: over.thresholdSats ?? 300_000,
      hysteresisSats: 25_000,
      intervalMs: 10 * MIN,
      renotifyMs: 12 * 3_600_000,
      isActive: async (key) => (await h.store.get(SHARED_SOURCE, key))?.status === "active",
      label: "seed-a"
    });
    return { monitor, ...driver(monitor, h) };
  }

  it("alerts once below the threshold with inbound, threshold and channel count; reminds only after the 12 h cooldown", async () => {
    let sats = 400_000;
    const d = inbound(async () => health(sats));
    expect(d.monitor).toMatchObject({ name: LN_INBOUND_RULE, scope: "shared", intervalMs: 10 * MIN });
    await d.tick(10 * MIN);
    expect(d.h.kinds()).toEqual([]);
    sats = 120_000;
    await d.tick(10 * MIN);
    expect(d.h.kinds()).toEqual([`firing:${KEY}`]);
    const n = d.h.sent[0]!;
    expect(n.alert.severity).toBe("warning");
    expect(n.alert.title).toBe("Lightning inbound capacity low");
    expect(n.alert.summary).toContain("120,000 sats");
    expect(n.alert.summary).toContain("300,000 sats");
    expect(n.alert.summary).toContain("2 active channels");
    expect(n.alert.details).toMatchObject({ inboundSats: 120_000, thresholdSats: 300_000, activeChannels: 2 });
    // Still low for 11 h 50 m (well past the global 4 h reminder): nothing more.
    for (let i = 0; i < 71; i++) await d.tick(10 * MIN);
    expect(d.h.kinds()).toEqual([`firing:${KEY}`]);
    await d.tick(10 * MIN);
    await d.tick(10 * MIN);
    expect(d.h.kinds()).toEqual([`firing:${KEY}`, `renotify:${KEY}`]);
  });

  it("recovers only above threshold + hysteresis, with one recovered notice; critical at 0", async () => {
    let sats = 0;
    const d = inbound(async () => health(sats));
    await d.tick();
    expect(d.h.sent[0]!.alert.severity).toBe("critical");
    sats = 310_000; // above the threshold but inside the hysteresis band: still active
    await d.tick();
    expect(await d.active()).toEqual([KEY]);
    expect(d.h.kinds()).toEqual([`firing:${KEY}`]);
    sats = 325_000;
    await d.tick();
    expect(await d.active()).toEqual([]);
    expect(d.h.kinds()).toEqual([`firing:${KEY}`, `resolved:${KEY}`]);
    sats = 310_000; // inside the band but not active: no new alert
    await d.tick();
    expect(d.h.kinds()).toEqual([`firing:${KEY}`, `resolved:${KEY}`]);
  });

  it("two coordinators on one LND and one database notify once and resolve once", async () => {
    let sats = 100_000;
    const a = inbound(async () => health(sats));
    const b = inbound(async () => health(sats), harness({ sourceId: "seed-b", store: a.h.store }));
    await a.tick(0);
    await b.tick(0);
    expect([...a.h.kinds(), ...b.h.kinds()]).toEqual([`firing:${KEY}`]);
    sats = 500_000;
    await b.tick(0);
    await a.tick(0);
    expect([...a.h.kinds(), ...b.h.kinds()].sort()).toEqual([`firing:${KEY}`, `resolved:${KEY}`]);
  });

  it("LND unreachable: no alert from this rule, the incident is kept, the runner does not throw", async () => {
    let down = false;
    const d = inbound(async () => {
      if (down) throw new Error("lnd_http_503:/v1/channels");
      return health(50_000);
    });
    await d.tick();
    down = true;
    await d.tick();
    await d.tick();
    expect(await d.active()).toEqual([KEY]);
    expect(d.h.kinds()).toEqual([`firing:${KEY}`]);
  });

  it("0 disables; a provider without node health is ignored", async () => {
    const off = inbound(async () => health(0), undefined, { thresholdSats: 0 });
    await off.tick();
    expect(off.h.kinds()).toEqual([]);
    const unsupported = inbound(async () => ({ supported: false, reason: "mock" }));
    await unsupported.tick();
    expect(unsupported.h.kinds()).toEqual([]);
  });
});

describe("4. payouts and purchases", () => {
  it("any failure warns, more than N an hour is critical, stuck pending and the kill switch alert, all resolve", async () => {
    let failed: Array<{ payoutId: string; kind: string; amountMsat: number; error: string | null; settledAtMs: number }> = [];
    let pending = { count: 0, oldestMs: null as number | null };
    let paused = false;
    const q: PayoutAlertQueries = {
      failedSince: async (since) => {
        const rows = failed.filter((f) => f.settledAtMs >= since);
        return { count: rows.length, recent: rows.slice(0, 5) };
      },
      pendingBefore: async () => pending,
      paused: async () => ({ paused, reason: paused ? "reconciliation mismatch" : null })
    };
    const d = driver(payoutMonitor({ queries: q, failuresPerHour: 3, pendingMaxMs: 60 * MIN }));
    await d.tick();
    expect(await d.active()).toEqual([]);
    failed = [{ payoutId: "p1", kind: "auto", amountMsat: 21_000_000, error: "lnd_pay_failed:NO_ROUTE", settledAtMs: d.h.clock.now }];
    await d.tick();
    expect(await d.active()).toEqual(["payout_failed"]);
    expect(d.h.sent[0]!.alert.summary).toContain("NO_ROUTE");
    failed = [1, 2, 3, 4].map((i) => ({ payoutId: `p${i}`, kind: "auto", amountMsat: 1000, error: "x", settledAtMs: d.h.clock.now }));
    pending = { count: 2, oldestMs: d.h.clock.now - 2 * 60 * MIN };
    paused = true;
    await d.tick();
    expect(await d.active()).toEqual(["payout_failures_high", "payout_pending_stuck", "payouts_paused"]);
    expect((await d.h.manager.list()).active.find((a) => a.key === "payout_failures_high")!.source).toBe("shared");
    pending = { count: 0, oldestMs: null };
    paused = false;
    await d.tick(61 * MIN);
    await d.tick();
    expect(await d.active()).toEqual([]);
  });

  it("purchase invoice failure rate over the minimum attempts", async () => {
    const signals = new PurchaseSignals();
    const d = driver(purchaseMonitor({ signals: { stats: (since) => signals.stats(since) }, failureRate: 0.5, minAttempts: 4, label: "seed-ord" }));
    signals.note(false, d.h.clock.now, "lnd_http_503");
    signals.note(false, d.h.clock.now, "lnd_http_503");
    await d.tick();
    expect(await d.active()).toEqual([]); // 2 attempts < 4
    signals.note(true, d.h.clock.now);
    signals.note(false, d.h.clock.now, "lnd_http_503");
    await d.tick();
    expect(await d.active()).toEqual(["purchase_failure_rate"]);
    expect(d.h.sent[0]!.alert.summary).toContain("3 of 4");
    d.h.advance(61 * MIN);
    await d.tick();
    expect(await d.active()).toEqual([]);
  });
});

describe("5. ledger integrity", () => {
  it("a failed reconciliation alerts until a later run passes; a stalled run warns", async () => {
    let rows: LedgerVerification[] = [];
    const d = driver(ledgerMonitor({ latest: async () => rows, stallMs: 2 * 60 * MIN }));
    const t = d.h.clock.now;
    rows = [{ windowStartMs: t, startedAtMs: t, finishedAtMs: t + 1000, ok: false, mismatches: 2 }];
    await d.tick();
    expect(await d.active()).toEqual(["ledger_verify_failed"]);
    rows = [{ windowStartMs: t + 1, startedAtMs: t - 3 * 60 * MIN, finishedAtMs: null, ok: null, mismatches: null }, { windowStartMs: t - 99, startedAtMs: t - 4 * 60 * MIN, finishedAtMs: t, ok: true, mismatches: 0 }];
    await d.tick();
    expect(await d.active()).toEqual(["ledger_verify_stalled"]);
    rows = [{ windowStartMs: t + 2, startedAtMs: t, finishedAtMs: t + 5, ok: true, mismatches: 0 }];
    await d.tick();
    expect(await d.active()).toEqual([]);
  });

  it("the ordering chain check", async () => {
    let r: { ok: boolean; reason?: string } = { ok: false, reason: "hash_mismatch" };
    const d = driver(orderingChainMonitor({ verify: () => r, label: "seed-ord" }));
    await d.tick();
    expect(await d.active()).toEqual(["ledger_chain_invalid"]);
    r = { ok: true };
    await d.tick();
    expect(await d.active()).toEqual([]);
  });
});

describe("6. database and backups", () => {
  it("pool errors over the threshold in 10 minutes, or a probe failing N times", async () => {
    let errors = 0;
    let probeOk = true;
    const d = driver(databaseMonitor({ errorCount: () => errors, probe: async () => { if (!probeOk) throw new Error("ECONNREFUSED"); }, errorsPer10Min: 5, failures: 3, label: "portal" }));
    await d.tick(MIN);
    errors = 4;
    await d.tick(MIN);
    expect(await d.active()).toEqual([]);
    errors = 6;
    await d.tick(MIN);
    expect(await d.active()).toEqual(["db_errors"]);
    // Ten quiet minutes later the growth over the window is 0 again.
    for (let i = 0; i < 11; i++) await d.tick(MIN);
    expect(await d.active()).toEqual([]);
    probeOk = false;
    await d.tick();
    await d.tick();
    await d.tick();
    const [a] = (await d.h.manager.list()).active;
    expect(a!.severity).toBe("critical");
    probeOk = true;
    await d.tick();
    expect(await d.active()).toEqual([]);
  });

  it("a backup older than 26 h is critical; a check that stops reporting warns when expected", async () => {
    const H = 3_600_000;
    let reports: Array<{ app: string; lastSuccessAtMs: number | null; reportedAtMs: number }> = [];
    const h = harness();
    const start = h.clock.now;
    const d = driver(backupMonitor({ reports: async () => reports, maxAgeMs: 26 * H, expected: true, startedAtMs: start }), h);
    await d.tick();
    expect(await d.active()).toEqual([]); // nothing reported yet, but the process just started
    h.advance(27 * H);
    await d.tick();
    expect(await d.active()).toEqual(["pg_backup_unreported:any"]);
    reports = [{ app: "portal-db", lastSuccessAtMs: h.clock.now - 30 * H, reportedAtMs: h.clock.now }];
    await d.tick();
    expect(await d.active()).toEqual(["pg_backup_stale:portal-db"]);
    reports = [{ app: "portal-db", lastSuccessAtMs: h.clock.now - 2 * H, reportedAtMs: h.clock.now }];
    await d.tick();
    expect(await d.active()).toEqual([]);
    h.advance(27 * H);
    await d.tick();
    expect(await d.active()).toEqual(["pg_backup_stale:portal-db", "pg_backup_unreported:portal-db"]);
  });
});

describe("7. capacity and safety", () => {
  it("popular model unserved for 10 min, host at critical memory pressure, no-capacity spike", async () => {
    let v: CapacityView = { models: [{ model: "qwen3:8b", agents: 0, calls24h: 50 }, { model: "rare:1b", agents: 0, calls24h: 2 }], agents: [{ agentId: "mac-1", email: "o@x.test", connected: true, blacklisted: false, memory: { pressure: "critical", fresh: true } }], series: { points: [] } };
    const d = driver(capacityMonitor({ view: async () => v, popularMinCalls24h: 20, gapMs: 10 * MIN, noCapacityRate: 0.25, noCapacityMinCalls: 20 }));
    await d.tick(6 * MIN);
    expect(await d.active()).toEqual([]);
    await d.tick(5 * MIN);
    await d.tick();
    expect(await d.active()).toEqual(["host_memory_critical:mac-1", "model_unserved:qwen3:8b"]);
    const now = d.h.clock.now;
    v = { ...v, models: [{ model: "qwen3:8b", agents: 2, calls24h: 50 }], agents: [], series: { points: [{ atMs: now - 60_000, started: 30, noCapacity: 12 }, { atMs: now - 30 * MIN, started: 1, noCapacity: 900 }] } };
    await d.tick();
    expect(await d.active()).toEqual(["no_capacity_spike"]);
    expect(d.h.sent.find((n) => n.alert.key === "no_capacity_spike")!.alert.summary).toContain("12 of 30");
    expect(d.h.kinds()).toContain("resolved:model_unserved:qwen3:8b");
  });

  it("a failed network fetch keeps the capacity incidents as they are", async () => {
    let fail = false;
    const v: CapacityView = { models: [], agents: [], series: { points: [{ atMs: Date.UTC(2026, 10, 16, 12, 0, 0), started: 40, noCapacity: 40 }] } };
    const d = driver(capacityMonitor({ view: async () => { if (fail) throw new Error("no_coordinator_answered"); return v; }, popularMinCalls24h: 20, gapMs: 10 * MIN, noCapacityRate: 0.25, noCapacityMinCalls: 20 }));
    await d.tick(0);
    expect(await d.active()).toEqual(["no_capacity_spike"]);
    fail = true;
    await d.tick();
    expect(await d.active()).toEqual(["no_capacity_spike"]);
  });
});

describe("8. security events", () => {
  it("integrity events alert at once, auth failures over a threshold, owned-host auto-blacklists at once; all clear when the window empties", async () => {
    const h = harness({ sourceId: "coord-ord" });
    const mon = new SecurityEventMonitor({ authFailuresPer10Min: 5, isOwnedHost: (id) => id === "mac-owned", label: "seed-ord", now: () => h.clock.now });
    const logger = new SecurityEventLogger(() => undefined);
    logger.addListener((e) => mon.ingest(e));
    const d = driver(mon, h);
    const log = (event: Parameters<typeof logger.log>[0]["event"], details: Record<string, unknown> = {}) => logger.log({ level: "HIGH", event, source: { type: "system", id: "x" }, details, action: "a", coordinatorId: "c" });
    log("bot_control_not_owner", { accountId: "acct-1", agentId: "mac-2" });
    for (let i = 0; i < 4; i++) log("failed_auth");
    log("auto_blacklist_triggered", { agentId: "anon-1" });
    await d.tick();
    expect(await d.active()).toEqual(["security:bot_control_not_owner"]);
    log("failed_auth");
    log("auto_blacklist_triggered", { agentId: "mac-owned", reasonCode: "dos_behavior" });
    log("ledger_chain_break");
    await d.tick();
    expect(await d.active()).toEqual(["security:auth_failures", "security:auto_blacklist_owned_host", "security:bot_control_not_owner", "security:ledger_chain_break"]);
    const owned = (await h.manager.list()).active.find((a) => a.key === "security:auto_blacklist_owned_host")!;
    expect(owned.severity).toBe("critical");
    expect(JSON.stringify(owned.details)).toContain("mac-owned");
    h.advance(11 * MIN);
    await d.tick();
    expect(await d.active()).not.toContain("security:auth_failures");
    h.advance(7 * 60 * MIN);
    await d.tick();
    expect(await d.active()).toEqual([]);
  });

  it("a proven agent over its own request budget (agent_rate_limited) never alerts", async () => {
    const h = harness({ sourceId: "coord-ord" });
    const mon = new SecurityEventMonitor({ authFailuresPer10Min: 5, isOwnedHost: () => false, label: "seed-ord", now: () => h.clock.now });
    const d = driver(mon, h);
    for (let i = 0; i < 200; i++) mon.ingest({ event: "agent_rate_limited", source: { type: "agent", id: "gpu-1" }, details: { route: "/inference/chunks" } } as any);
    await d.tick();
    expect(await d.active()).toEqual([]);
    for (let i = 0; i < 10; i++) mon.ingest({ event: "auth_rate_limit_hit", source: { type: "system", id: "unauthenticated" }, details: {} } as any);
    await d.tick();
    expect(await d.active()).toEqual(["security:auth_rate_limited"]);
  });

  it("a listener that throws never breaks the security log", () => {
    const seen: string[] = [];
    const logger = new SecurityEventLogger((e) => seen.push(e.event));
    logger.addListener(() => {
      throw new Error("boom");
    });
    logger.log({ level: "WARN", event: "failed_auth", source: { type: "system", id: "x" }, action: "a", coordinatorId: "c" });
    expect(seen).toEqual(["failed_auth"]);
  });
});
