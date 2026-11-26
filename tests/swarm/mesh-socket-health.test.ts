import { describe, expect, test } from "vitest";
import {
  IDLE_WAIT_LATE_REPORT_MS,
  IdleWaitLateness,
  MESH_SOCKET_CONFIRM_GRACE_MS,
  MESH_SOCKET_REOPEN_MAX_INTERVAL_MS,
  MESH_SOCKET_REOPEN_MIN_INTERVAL_MS,
  MeshSocketConfirmation
} from "../../src/swarm/mesh-socket-health.js";

/*
 * Network run 12: the owner's Mac believed its mesh socket was open (it sent the model-state report
 * only an open socket sends) while the coordinator never counted one, so it got no nudges and idled
 * at the slower with-nudges poll. The heartbeat reply now says whether the coordinator counts it.
 */

const OPENED = 1_000_000;
const past = OPENED + MESH_SOCKET_CONFIRM_GRACE_MS + 1;

describe("MeshSocketConfirmation", () => {
  test("an older coordinator that does not say changes nothing", () => {
    const c = new MeshSocketConfirmation();
    for (let i = 0; i < 5; i++) expect(c.observe({ localOpen: true, openedAtMs: OPENED, coordinatorSays: undefined, nowMs: past + i * 3000 })).toBe("ok");
    expect(c.nudgesExpected(true)).toBe(true);
    expect(c.nudgesExpected(false)).toBe(false);
  });

  test("a confirmed socket keeps the nudge pace", () => {
    const c = new MeshSocketConfirmation();
    expect(c.observe({ localOpen: true, openedAtMs: OPENED, coordinatorSays: true, nowMs: past })).toBe("ok");
    expect(c.nudgesExpected(true)).toBe(true);
  });

  test("a denied socket polls fast at once, and is reopened after two denials past the grace", () => {
    const c = new MeshSocketConfirmation();
    // Just opened: the bind may still be in flight. Poll fast, but do not count it.
    expect(c.observe({ localOpen: true, openedAtMs: OPENED, coordinatorSays: false, nowMs: OPENED + 1000 })).toBe("ok");
    expect(c.nudgesExpected(true)).toBe(false);
    expect(c.observe({ localOpen: true, openedAtMs: OPENED, coordinatorSays: false, nowMs: past })).toBe("ok");
    expect(c.observe({ localOpen: true, openedAtMs: OPENED, coordinatorSays: false, nowMs: past + 3000 })).toBe("reopen");
  });

  test("a confirmation in between resets the count", () => {
    const c = new MeshSocketConfirmation();
    expect(c.observe({ localOpen: true, openedAtMs: OPENED, coordinatorSays: false, nowMs: past })).toBe("ok");
    expect(c.observe({ localOpen: true, openedAtMs: OPENED, coordinatorSays: true, nowMs: past + 3000 })).toBe("ok");
    expect(c.nudgesExpected(true)).toBe(true);
    expect(c.observe({ localOpen: true, openedAtMs: OPENED, coordinatorSays: false, nowMs: past + 6000 })).toBe("ok");
  });

  test("no local socket: nothing to reopen, and the fast poll", () => {
    const c = new MeshSocketConfirmation();
    for (let i = 0; i < 4; i++) expect(c.observe({ localOpen: false, openedAtMs: null, coordinatorSays: false, nowMs: past + i * 3000 })).toBe("ok");
    expect(c.nudgesExpected(false)).toBe(false);
  });

  test("a new socket forgets the old verdict", () => {
    const c = new MeshSocketConfirmation();
    c.observe({ localOpen: true, openedAtMs: OPENED, coordinatorSays: false, nowMs: past });
    expect(c.nudgesExpected(true)).toBe(false);
    c.socketChanged();
    expect(c.nudgesExpected(true)).toBe(true);
  });

  test("reopens that are never confirmed back off, up to the max", () => {
    const c = new MeshSocketConfirmation();
    let now = past;
    const reopenAt: number[] = [];
    // A heartbeat every 3 s; each reopen gives a fresh socket that is denied again.
    let opened = OPENED;
    for (let i = 0; i < 2000 && reopenAt.length < 8; i++) {
      now += 3000;
      if (c.observe({ localOpen: true, openedAtMs: opened, coordinatorSays: false, nowMs: now }) === "reopen") {
        reopenAt.push(now);
        c.socketChanged();
        opened = now + 1000;
      }
    }
    const gaps = reopenAt.slice(1).map((t, i) => t - reopenAt[i]);
    expect(gaps[0]).toBeGreaterThanOrEqual(MESH_SOCKET_REOPEN_MIN_INTERVAL_MS);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(MESH_SOCKET_REOPEN_MAX_INTERVAL_MS + 30_000);
    expect(Math.max(...gaps)).toBeGreaterThanOrEqual(MESH_SOCKET_REOPEN_MAX_INTERVAL_MS);
    // Confirmed once: the next trouble is acted on quickly again.
    c.observe({ localOpen: true, openedAtMs: opened, coordinatorSays: true, nowMs: now + 3000 });
    now += MESH_SOCKET_REOPEN_MIN_INTERVAL_MS + 6000;
    c.observe({ localOpen: true, openedAtMs: opened, coordinatorSays: false, nowMs: now });
    expect(c.observe({ localOpen: true, openedAtMs: opened, coordinatorSays: false, nowMs: now + 3000 })).toBe("reopen");
  });
});

describe("IdleWaitLateness", () => {
  test("on-time waits say nothing", () => {
    const l = new IdleWaitLateness();
    for (let i = 0; i < 100; i++) expect(l.note(3000, 3100, i * 3000)).toBeNull();
  });

  test("late waits are reported at most once a minute, with the count and the worst", () => {
    const l = new IdleWaitLateness();
    const first = l.note(3000, 21_300, 0);
    expect(first).toMatch(/ran late 1x/);
    expect(first).toMatch(/18300 ms late/);
    expect(l.note(3000, 9000, 10_000)).toBeNull();
    expect(l.note(3000, 7000, 20_000)).toBeNull();
    const next = l.note(3000, 3000, IDLE_WAIT_LATE_REPORT_MS);
    expect(next).toMatch(/ran late 2x/);
    expect(next).toMatch(/6000 ms late/);
    expect(l.note(3000, 3000, 2 * IDLE_WAIT_LATE_REPORT_MS + 1)).toBeNull();
  });
});
