import { describe, expect, test } from "vitest";
import { RemoteGrantBook, REMOTE_GRANT_SLACK_MS, remoteGrantTtlMs } from "../../src/swarm/remote-grants.js";
import type { Subtask } from "../../src/common/types.js";

const sub = (id: string, taskId = "t1"): Subtask => ({
  id, taskId, kind: "single_step", language: "python", input: "x", timeoutMs: 30_000, snapshotRef: "s",
  projectMeta: { projectId: "p", resourceClass: "cpu", priority: 1 }
});

describe("RemoteGrantBook", () => {
  test("one peer holds a grant; its result is admitted once and settles it", () => {
    const b = new RemoteGrantBook();
    b.grant(sub("s1"), "peer-a", 0, 1_000);
    expect(b.regrant("s1", "peer-a", 10)).toEqual({ granted: true, ttlMs: 990 });
    expect(b.regrant("s1", "peer-b", 10)).toEqual({ granted: false, reason: "granted_elsewhere" });
    expect(b.openCountForTask("t1")).toBe(1);
    expect(b.admitForward("s1", "peer-b", 20).kind).toBe("not_granted");
    expect(b.admitForward("s1", "peer-a", 20).kind).toBe("accept");
    expect(b.admitForward("s1", "peer-a", 21).kind).toBe("in_progress");
    b.settle("s1", 42, 30);
    expect(b.openCountForTask("t1")).toBe(0);
    expect(b.admitForward("s1", "peer-a", 40)).toEqual({ kind: "duplicate", chargedMsat: 42 });
    expect(b.settledCharge("s1", "peer-a", 40)).toBe(42);
    expect(b.settledCharge("s1", "peer-b", 40)).toBeUndefined();
    expect(b.regrant("s1", "peer-a", 40)).toEqual({ granted: false, reason: "already_settled" });
  });

  test("a released forward may be sent again; expired grants are returned once and then refused", () => {
    const b = new RemoteGrantBook();
    b.grant(sub("s2"), "peer-a", 0, 1_000);
    expect(b.admitForward("s2", "peer-a", 1).kind).toBe("accept");
    expect(b.expire(5_000)).toEqual([]); // in progress: not expired under it
    b.release("s2");
    const expired = b.expire(5_000);
    expect(expired.map((g) => g.subtask.id)).toEqual(["s2"]);
    expect(b.expire(6_000)).toEqual([]);
    expect(b.admitForward("s2", "peer-a", 6_000).kind).toBe("not_granted");
  });

  test("ttl covers the subtask's limit (capped) plus the slack", () => {
    expect(remoteGrantTtlMs(30_000, 60_000)).toBe(30_000 + REMOTE_GRANT_SLACK_MS);
    expect(remoteGrantTtlMs(10 * 60_000, 60_000)).toBe(60_000 + REMOTE_GRANT_SLACK_MS);
  });
});
