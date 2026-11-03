import { describe, expect, it } from "vitest";
import { checkSnapshotPolicy, envelopeResultPayload, parseSnapshotEnforcement } from "../../src/swarm/execution-policy.js";
import type { SubtaskResult } from "../../src/common/types.js";
import type { TaskEnvelope } from "../../src/security/envelope.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

describe("snapshot policy for every subtask source", () => {
  it("strict refuses mesh task_offer and peer-direct synthetic refs, and missing refs", () => {
    expect(checkSnapshotPolicy({ id: "m1", kind: "single_step", snapshotRef: "mesh" }, "strict")).toMatchObject({ run: false, error: expect.stringMatching(/snapshot_invalid/) });
    expect(checkSnapshotPolicy({ id: "p1", kind: "single_step", snapshotRef: "peer-direct" }, "strict")).toMatchObject({ run: false });
    expect(checkSnapshotPolicy({ id: "x", kind: "single_step" }, "strict")).toMatchObject({ run: false });
  });

  it("strict runs valid snapshots and inference; warn runs with a warning", () => {
    expect(checkSnapshotPolicy({ id: "a", kind: "single_step", snapshotRef: COMMIT }, "strict")).toEqual({ run: true, verified: true });
    expect(checkSnapshotPolicy({ id: "a", kind: "single_step", snapshotRef: "https://example.com/s.tgz" }, "strict")).toMatchObject({ run: true });
    expect(checkSnapshotPolicy({ id: "i", kind: "inference" }, "strict")).toEqual({ run: true });
    expect(checkSnapshotPolicy({ id: "m1", kind: "single_step", snapshotRef: "mesh" }, "warn")).toMatchObject({ run: true, warning: expect.stringMatching(/m1/) });
  });

  it("parses SNAPSHOT_ENFORCEMENT with warn as the default", () => {
    expect(parseSnapshotEnforcement(undefined)).toBe("warn");
    expect(parseSnapshotEnforcement("STRICT")).toBe("strict");
    expect(parseSnapshotEnforcement("bogus")).toBe("warn");
  });
});

describe("envelope results fail closed", () => {
  const result: SubtaskResult = { subtaskId: "s1", taskId: "t1", agentId: "a1", ok: true, output: "SECRET OUTPUT", durationMs: 12, reportNonce: "n0", reportSignature: "sig0" };
  const envelope = { subtaskId: "s1" } as TaskEnvelope;

  it("an encryption failure posts no plaintext, as a re-signed failure", () => {
    const sealed = envelopeResultPayload(result, envelope, () => { throw new Error("bad key"); }, (ok) => ({ reportNonce: "n1", reportSignature: `sig-${ok}` }));
    expect(sealed.encrypted).toBe(false);
    expect(JSON.stringify(sealed.payload)).not.toContain("SECRET OUTPUT");
    expect(sealed.payload).toMatchObject({ subtaskId: "s1", ok: false, output: "", error: "result_encryption_failed", reportNonce: "n1", reportSignature: "sig-false" });
  });

  it("a successful encryption carries only ciphertext", () => {
    const sealed = envelopeResultPayload(result, envelope, () => ({ subtaskId: "s1", encryptedPayload: "Y2lwaGVy", nonce: "00", tag: "11" }));
    expect(sealed.encrypted).toBe(true);
    expect(JSON.stringify(sealed.payload)).not.toContain("SECRET OUTPUT");
    expect(sealed.payload).toMatchObject({ encryptedPayload: "Y2lwaGVy", reportSignature: "sig0" });
  });
});
