import { describe, expect, it } from "vitest";
import { MemoryAlertStore, ResilientAlertStore, type AlertStore } from "../../src/alerting/store.js";
import { SHARED_SOURCE } from "../../src/alerting/manager.js";
import type { AlertInput } from "../../src/alerting/types.js";
import { harness } from "./helpers.js";

const MIN = 60_000;
const down = (over: Partial<AlertInput> = {}): AlertInput => ({ key: "coordinator_down:seed-eu", severity: "critical", title: "Coordinator seed-eu is down", summary: "3 failed checks", ...over });

describe("AlertManager: incidents, de-duplication and rate limits", () => {
  it("notifies once per incident however often the condition is reported", async () => {
    const h = harness();
    for (let i = 0; i < 10; i++) {
      await h.manager.apply("local", "coordinator_health", [down()]);
      h.advance(30_000);
    }
    expect(h.kinds()).toEqual(["firing:coordinator_down:seed-eu"]);
    const { active, history } = await h.manager.list();
    expect(active).toHaveLength(1);
    expect(history.map((e) => e.kind).sort()).toEqual(["notified", "raised"]);
  });

  it("sends a resolution notice when the condition clears, with the incident's duration", async () => {
    const h = harness();
    await h.manager.apply("local", "coordinator_health", [down({ sinceMs: h.clock.now - 90_000 })]);
    h.advance(10 * MIN);
    await h.manager.apply("local", "coordinator_health", []);
    expect(h.kinds()).toEqual(["firing:coordinator_down:seed-eu", "resolved:coordinator_down:seed-eu"]);
    const resolved = h.sent[1]!;
    expect(resolved.alert.status).toBe("resolved");
    expect(resolved.alert.resolvedAtMs! - resolved.alert.firstSeenMs).toBe(10 * MIN + 90_000);
    expect((await h.manager.list()).active).toEqual([]);
  });

  it("rate-limits a flapping key to one notification per 15 minutes", async () => {
    const h = harness();
    // Raise, clear, raise, clear ... every minute for 14 minutes.
    for (let i = 0; i < 14; i++) {
      await h.manager.apply("local", "coordinator_health", i % 2 === 0 ? [down()] : []);
      h.advance(MIN);
    }
    // The first incident notified and resolved; the re-raises inside 15 min stay silent, and their
    // clears send nothing because nobody was told.
    expect(h.kinds()).toEqual(["firing:coordinator_down:seed-eu", "resolved:coordinator_down:seed-eu"]);
    // Still active at 16 min: the held-back incident is told now.
    h.advance(2 * MIN);
    await h.manager.apply("local", "coordinator_health", [down()]);
    expect(h.kinds()).toEqual(["firing:coordinator_down:seed-eu", "resolved:coordinator_down:seed-eu", "firing:coordinator_down:seed-eu"]);
  });

  it("re-notifies quietly while active, and acknowledging stops the reminders but not the resolution", async () => {
    const h = harness({ renotifyMs: 60 * MIN });
    await h.manager.apply("local", "lightning", [down({ key: "ln_low_outbound", severity: "warning" })]);
    h.advance(59 * MIN);
    await h.manager.apply("local", "lightning", [down({ key: "ln_low_outbound", severity: "warning" })]);
    h.advance(2 * MIN);
    await h.manager.apply("local", "lightning", [down({ key: "ln_low_outbound", severity: "warning" })]);
    expect(h.kinds()).toEqual(["firing:ln_low_outbound", "renotify:ln_low_outbound"]);
    expect(await h.manager.acknowledge("portal", "ln_low_outbound", "owner@example.test")).not.toBeNull();
    h.advance(3 * 60 * MIN);
    await h.manager.apply("local", "lightning", [down({ key: "ln_low_outbound", severity: "warning" })]);
    expect(h.kinds()).toHaveLength(2);
    const { active } = await h.manager.list();
    expect(active[0]!.acknowledgedBy).toBe("owner@example.test");
    await h.manager.apply("local", "lightning", []);
    expect(h.kinds().at(-1)).toBe("resolved:ln_low_outbound");
  });

  it("a new incident after resolution starts unacknowledged", async () => {
    const h = harness();
    await h.manager.apply("local", "r", [down()]);
    await h.manager.acknowledge("portal", down().key, "a@b.c");
    await h.manager.apply("local", "r", []);
    h.advance(20 * MIN);
    await h.manager.apply("local", "r", [down()]);
    const [a] = (await h.manager.list()).active;
    expect(a!.acknowledgedAtMs).toBeNull();
    expect(a!.notifyCount).toBe(1);
  });

  it("escalating warning to critical notifies again (outside the rate limit)", async () => {
    const h = harness();
    await h.manager.apply("local", "payouts", [down({ key: "x", severity: "warning" })]);
    h.advance(16 * MIN);
    await h.manager.apply("local", "payouts", [down({ key: "x", severity: "critical" })]);
    expect(h.sent.map((n) => `${n.kind}:${n.alert.severity}`)).toEqual(["firing:warning", "firing:critical"]);
  });

  it("only resolves incidents of the rule being applied", async () => {
    const h = harness();
    await h.manager.apply("local", "a", [down({ key: "k1" })]);
    await h.manager.apply("local", "b", [down({ key: "k2" })]);
    await h.manager.apply("local", "a", []);
    expect((await h.manager.list()).active.map((r) => r.key)).toEqual(["k2"]);
  });

  it("shared incidents on one database notify once across coordinators", async () => {
    const store = new MemoryAlertStore();
    const a = harness({ store, sourceId: "coord-a" });
    const b = harness({ store, sourceId: "coord-b" });
    b.clock.now = a.clock.now;
    const failed = down({ key: "payout_failed", severity: "warning" });
    await Promise.all([a.manager.apply("shared", "payouts", [failed]), b.manager.apply("shared", "payouts", [failed])]);
    expect(a.sent.length + b.sent.length).toBe(1);
    expect((await store.listActive([SHARED_SOURCE])).map((r) => r.key)).toEqual(["payout_failed"]);
    // Local incidents stay apart: each coordinator's view of the portal is its own.
    await a.manager.apply("local", "portal_health", [down({ key: "portal_down:p" })]);
    await b.manager.apply("local", "portal_health", [down({ key: "portal_down:p" })]);
    expect(a.sent.length + b.sent.length).toBe(3);
    // Resolution of the shared incident is announced once too.
    await Promise.all([a.manager.apply("shared", "payouts", []), b.manager.apply("shared", "payouts", [])]);
    expect([...a.sent, ...b.sent].filter((n) => n.kind === "resolved")).toHaveLength(1);
  });

  it("acknowledge refuses another process's source", async () => {
    const h = harness({ sourceId: "coord-a" });
    await h.manager.apply("local", "r", [down()]);
    expect(await h.manager.acknowledge("coord-b", down().key, "x")).toBeNull();
    expect(await h.manager.acknowledge("coord-a", down().key, "x")).not.toBeNull();
  });

  it("records a failed channel in history and keeps going", async () => {
    const h = harness({ failChannel: true });
    await h.manager.apply("local", "r", [down()]);
    const { history } = await h.manager.list();
    expect(history.map((e) => e.kind)).toContain("notify_failed");
  });

  it("a test alert goes to every channel at once and is not an incident", async () => {
    const h = harness();
    const results = await h.manager.sendTest("owner@example.test");
    expect(results).toEqual([{ channel: "recorder", ok: true }]);
    expect(h.sent[0]!.kind).toBe("test");
    expect(h.sent[0]!.alert.summary).toContain("owner@example.test");
    expect(h.sent[0]!.url).toBe("https://portal.example.test/portal/settings/network#alerts");
    expect((await h.manager.list()).active).toEqual([]);
  });

  it("keeps alerting when the database store fails (memory fallback)", async () => {
    const broken: AlertStore = new Proxy({} as AlertStore, { get: () => async () => { throw new Error("connection refused"); } });
    const errors: string[] = [];
    const store = new ResilientAlertStore(broken, new MemoryAlertStore(), (_e, op) => errors.push(op));
    const h = harness({ store });
    await h.manager.apply("local", "database", [down({ key: "db_errors" })]);
    expect(h.kinds()).toEqual(["firing:db_errors"]);
    expect(errors).toContain("open");
  });
});
