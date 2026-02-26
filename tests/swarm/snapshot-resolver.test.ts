import { describe, expect, test, beforeEach } from "vitest";
import {
  resolveSnapshot,
  isValidSnapshotRef,
  clearSnapshotCache,
  snapshotCacheSize,
  type ResolvedSnapshot,
} from "../../src/swarm/snapshot-resolver.js";

beforeEach(() => {
  clearSnapshotCache();
});

describe("isValidSnapshotRef", () => {
  test("accepts a 40-char lowercase hex commit hash", () => {
    expect(isValidSnapshotRef("a".repeat(40))).toBe(true);
    expect(isValidSnapshotRef("0123456789abcdef0123456789abcdef01234567")).toBe(true);
  });

  test("accepts a 40-char uppercase hex commit hash", () => {
    expect(isValidSnapshotRef("A".repeat(40))).toBe(true);
    expect(isValidSnapshotRef("0123456789ABCDEF0123456789ABCDEF01234567")).toBe(true);
  });

  test("accepts a 40-char mixed-case hex commit hash", () => {
    expect(isValidSnapshotRef("aAbBcCdDeEfF0123456789aAbBcCdDeEfF012345")).toBe(true);
  });

  test("accepts an HTTPS tarball URL", () => {
    expect(isValidSnapshotRef("https://example.com/snapshot.tar.gz")).toBe(true);
    expect(isValidSnapshotRef("https://github.com/org/repo/archive/abc123.tar.gz")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidSnapshotRef("")).toBe(false);
  });

  test("rejects too-short hex string", () => {
    expect(isValidSnapshotRef("abcdef1234")).toBe(false);
  });

  test("rejects 39-char hex string (one short)", () => {
    expect(isValidSnapshotRef("a".repeat(39))).toBe(false);
  });

  test("rejects 41-char hex string (one too many)", () => {
    expect(isValidSnapshotRef("a".repeat(41))).toBe(false);
  });

  test("rejects non-hex 40-char string", () => {
    expect(isValidSnapshotRef("g".repeat(40))).toBe(false);
    expect(isValidSnapshotRef("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBe(false);
  });

  test("rejects HTTP (non-HTTPS) URL", () => {
    expect(isValidSnapshotRef("http://example.com/snapshot.tar.gz")).toBe(false);
  });

  test("rejects plain words", () => {
    expect(isValidSnapshotRef("debug")).toBe(false);
    expect(isValidSnapshotRef("latest")).toBe(false);
    expect(isValidSnapshotRef("main")).toBe(false);
  });

  test("rejects null and undefined coerced to string", () => {
    expect(isValidSnapshotRef(null as unknown as string)).toBe(false);
    expect(isValidSnapshotRef(undefined as unknown as string)).toBe(false);
  });
});

describe("resolveSnapshot", () => {
  test("resolves 40-char hex as git_commit", async () => {
    const hash = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    const result = await resolveSnapshot(hash);
    expect(result.type).toBe("git_commit");
    expect(result.ref).toBe(hash);
    expect(result.resolvedAtMs).toBeGreaterThan(0);
  });

  test("resolves HTTPS URL as tarball", async () => {
    const url = "https://storage.example.com/snapshots/v1.2.3.tar.gz";
    const result = await resolveSnapshot(url);
    expect(result.type).toBe("tarball");
    expect(result.ref).toBe(url);
    expect(result.resolvedAtMs).toBeGreaterThan(0);
  });

  test("throws on empty string", async () => {
    await expect(resolveSnapshot("")).rejects.toThrow("non-empty string");
  });

  test("throws on invalid ref (too short)", async () => {
    await expect(resolveSnapshot("abc123")).rejects.toThrow("Invalid snapshotRef");
  });

  test("throws on invalid ref (plain word)", async () => {
    await expect(resolveSnapshot("debug")).rejects.toThrow("Invalid snapshotRef");
  });

  test("throws on HTTP (non-HTTPS) URL", async () => {
    await expect(resolveSnapshot("http://example.com/snap.tar.gz")).rejects.toThrow("Invalid snapshotRef");
  });

  test("caching: same ref returns cached result", async () => {
    const hash = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    expect(snapshotCacheSize()).toBe(0);

    const first = await resolveSnapshot(hash);
    expect(snapshotCacheSize()).toBe(1);

    const second = await resolveSnapshot(hash);
    expect(snapshotCacheSize()).toBe(1);

    // Same object reference (cache hit)
    expect(second).toBe(first);
    expect(second.resolvedAtMs).toBe(first.resolvedAtMs);
  });

  test("caching: different refs are cached independently", async () => {
    const hash1 = "1111111111111111111111111111111111111111";
    const hash2 = "2222222222222222222222222222222222222222";

    await resolveSnapshot(hash1);
    await resolveSnapshot(hash2);
    expect(snapshotCacheSize()).toBe(2);
  });

  test("clearSnapshotCache resets the cache", async () => {
    await resolveSnapshot("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(snapshotCacheSize()).toBe(1);
    clearSnapshotCache();
    expect(snapshotCacheSize()).toBe(0);
  });
});

describe("coordinator taskSchema snapshot validation", () => {
  // These tests validate the regex patterns used by the coordinator's
  // taskSchema.snapshotRef.refine(isValidSnapshotRef) without importing the
  // full coordinator (which has heavy side-effects). The isValidSnapshotRef
  // function is the same one wired into the Zod refine.

  test("valid commit hash passes validation", () => {
    expect(isValidSnapshotRef("0123456789abcdef0123456789abcdef01234567")).toBe(true);
  });

  test("valid HTTPS URL passes validation", () => {
    expect(isValidSnapshotRef("https://cdn.edgecoder.io/snapshots/abc.tar.gz")).toBe(true);
  });

  test("rejects tasks without valid snapshotRef (empty)", () => {
    expect(isValidSnapshotRef("")).toBe(false);
  });

  test("rejects tasks with invalid snapshotRef (random string)", () => {
    expect(isValidSnapshotRef("not-a-valid-ref")).toBe(false);
  });

  test("rejects tasks with 'debug' snapshotRef", () => {
    // The debug endpoint uses snapshotRef: "debug" which should fail validation
    // on the production /submit endpoint
    expect(isValidSnapshotRef("debug")).toBe(false);
  });
});
