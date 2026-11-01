import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPeerKeys } from "../../src/mesh/peer.js";
import {
  CoordinatorTrustGate,
  PinnedKeyStore,
  checkCoordinatorTrust,
  describeTrustFailure,
  fingerprint,
  isTrusted,
  parseTrustEntries,
  parseTrustMode,
  type IdentityFetch
} from "../../src/trust/pinned-keys.js";

const coordA = createPeerKeys("coord-a");
const coordA2 = createPeerKeys("coord-a"); // same id, rotated/forged key
const coordB = createPeerKeys("coord-b");
const fpA = fingerprint(coordA.publicKeyPem);

let dir: string;
let pinFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "edgecoder-trust-"));
  pinFile = join(dir, "nested", "trusted-coordinators");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fingerprint / parsing", () => {
  it("fingerprint is a sha256 hex that ignores line-ending and whitespace differences", () => {
    expect(fpA).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint(coordA.publicKeyPem.replace(/\n/g, "\r\n"))).toBe(fpA);
    expect(fingerprint(`  ${coordA.publicKeyPem}\n\n`)).toBe(fpA);
    expect(fingerprint(coordB.publicKeyPem)).not.toBe(fpA);
  });

  it("parses comma and newline separated entries with comments", () => {
    const fpB = fingerprint(coordB.publicKeyPem);
    const entries = parseTrustEntries(`coord-a:${fpA.toUpperCase()}, \n# comment\ncoord-b:${fpB} # pinned 2025\n\n`);
    expect([...entries]).toEqual([
      ["coord-a", fpA],
      ["coord-b", fpB]
    ]);
    expect(parseTrustEntries(undefined).size).toBe(0);
    expect(() => parseTrustEntries("coord-a:nothex")).toThrow(/invalid trusted coordinator entry/);
    expect(() => parseTrustEntries("coord-a")).toThrow(/invalid trusted coordinator entry/);
  });

  it("parses the mode with a tofu default and rejects unknown values", () => {
    expect(parseTrustMode(undefined)).toBe("tofu");
    expect(parseTrustMode("")).toBe("tofu");
    expect(parseTrustMode("STRICT")).toBe("strict");
    expect(parseTrustMode("open")).toBe("open");
    expect(() => parseTrustMode("maybe")).toThrow(/EDGECODER_TRUST_MODE/);
  });
});

describe("tofu mode", () => {
  it("pins the first key seen, persists it and refuses a different key afterwards", () => {
    const store = new PinnedKeyStore({ mode: "tofu", pinFile, now: () => 0 });
    const first = store.isTrusted(coordA.peerId, coordA.publicKeyPem);
    expect(first).toMatchObject({ trusted: true, reason: "tofu_pinned", persisted: true, fingerprint: fpA });
    expect(existsSync(pinFile)).toBe(true);
    expect(readFileSync(pinFile, "utf8")).toContain(`coord-a:${fpA}`);

    expect(store.isTrusted(coordA.peerId, coordA.publicKeyPem)).toMatchObject({ trusted: true, reason: "pinned_match" });
    expect(store.isTrusted(coordA.peerId, coordA2.publicKeyPem)).toMatchObject({
      trusted: false,
      reason: "pinned_mismatch",
      pinnedFingerprint: fpA
    });
    // Another coordinator id is pinned independently.
    expect(store.isTrusted(coordB.peerId, coordB.publicKeyPem)).toMatchObject({ trusted: true, reason: "tofu_pinned" });

    // A fresh store reads the pins back from the file.
    const reloaded = new PinnedKeyStore({ mode: "tofu", pinFile });
    expect(reloaded.isTrusted(coordA.peerId, coordA2.publicKeyPem).trusted).toBe(false);
    expect(reloaded.isTrusted(coordA.peerId, coordA.publicKeyPem).reason).toBe("pinned_match");
    expect(reloaded.list()).toEqual([
      { peerId: "coord-a", fingerprint: fpA, source: "pinned" },
      { peerId: "coord-b", fingerprint: fingerprint(coordB.publicKeyPem), source: "pinned" }
    ]);
  });

  it("static entries win over the file and are enforced in tofu mode", () => {
    writeFileSync(pinFile.replace("/nested", ""), `coord-a:${fingerprint(coordA2.publicKeyPem)}\n`);
    const store = new PinnedKeyStore({ mode: "tofu", entries: `coord-a:${fpA}`, pinFile: pinFile.replace("/nested", "") });
    expect(store.isTrusted(coordA.peerId, coordA.publicKeyPem)).toMatchObject({ trusted: true, reason: "pinned_match" });
    expect(store.isTrusted(coordA.peerId, coordA2.publicKeyPem)).toMatchObject({ trusted: false, reason: "pinned_mismatch" });
    expect(store.list()[0]).toEqual({ peerId: "coord-a", fingerprint: fpA, source: "static" });
  });

  it("reports when the pin could not be persisted but still trusts in-memory", () => {
    const store = new PinnedKeyStore({ mode: "tofu", pinFile: null });
    expect(store.isTrusted(coordA.peerId, coordA.publicKeyPem)).toMatchObject({ trusted: true, reason: "tofu_pinned", persisted: false });
    expect(store.isTrusted(coordA.peerId, coordA2.publicKeyPem).trusted).toBe(false);
  });
});

describe("strict mode", () => {
  it("trusts only listed keys and never pins", () => {
    const store = new PinnedKeyStore({ mode: "strict", entries: new Map([[coordA.peerId, fpA]]), pinFile });
    expect(store.isTrusted(coordA.peerId, coordA.publicKeyPem)).toMatchObject({ trusted: true, reason: "pinned_match" });
    expect(store.isTrusted(coordA.peerId, coordA2.publicKeyPem)).toMatchObject({ trusted: false, reason: "pinned_mismatch" });
    expect(store.isTrusted(coordB.peerId, coordB.publicKeyPem)).toMatchObject({ trusted: false, reason: "strict_unlisted" });
    expect(existsSync(pinFile)).toBe(false);
  });
});

describe("open mode", () => {
  it("trusts everything but still reports a mismatch against a listed key", () => {
    const store = new PinnedKeyStore({ mode: "open", entries: new Map([[coordA.peerId, fpA]]), pinFile });
    expect(store.isTrusted(coordB.peerId, coordB.publicKeyPem)).toMatchObject({ trusted: true, reason: "open" });
    expect(store.isTrusted(coordA.peerId, coordA2.publicKeyPem)).toMatchObject({ trusted: true, reason: "open_mismatch", pinnedFingerprint: fpA });
    expect(existsSync(pinFile)).toBe(false);
  });
});

describe("fromEnv / isTrusted", () => {
  it("reads mode, list and file from the environment", () => {
    writeFileSync(join(dir, "file.txt"), `coord-b:${fingerprint(coordB.publicKeyPem)}\n`);
    const store = PinnedKeyStore.fromEnv({
      EDGECODER_TRUST_MODE: "strict",
      TRUSTED_COORDINATOR_KEYS: `coord-a:${fpA}`,
      EDGECODER_TRUST_FILE: join(dir, "file.txt")
    } as NodeJS.ProcessEnv);
    expect(store.mode).toBe("strict");
    expect(isTrusted(coordA.peerId, coordA.publicKeyPem, store).trusted).toBe(true);
    expect(isTrusted(coordB.peerId, coordB.publicKeyPem, store).trusted).toBe(true);
    expect(isTrusted("coord-c", coordA2.publicKeyPem, store).trusted).toBe(false);
  });

  it("uses the supplied default pin file when EDGECODER_TRUST_FILE is unset", () => {
    const store = PinnedKeyStore.fromEnv({} as NodeJS.ProcessEnv, { pinFile });
    expect(store.pinFile).toBe(pinFile);
    expect(store.mode).toBe("tofu");
  });

  it("fails fast on a bad mode or a bad entry", () => {
    expect(() => PinnedKeyStore.fromEnv({ EDGECODER_TRUST_MODE: "yes" } as NodeJS.ProcessEnv)).toThrow(/EDGECODER_TRUST_MODE/);
    expect(() => PinnedKeyStore.fromEnv({ TRUSTED_COORDINATOR_KEYS: "garbage" } as NodeJS.ProcessEnv)).toThrow(/invalid trusted coordinator entry/);
  });
});

describe("checkCoordinatorTrust / CoordinatorTrustGate", () => {
  const identityFetch = (identity: unknown, status = 200): IdentityFetch & { calls: string[] } => {
    const calls: string[] = [];
    const fn = (async (url: string) => {
      calls.push(url);
      return { ok: status < 300, status, json: async () => identity };
    }) as IdentityFetch & { calls: string[] };
    fn.calls = calls;
    return fn;
  };

  it("fetches /identity and applies the store", async () => {
    const store = new PinnedKeyStore({ mode: "strict", entries: new Map([[coordA.peerId, fpA]]), pinFile: null });
    const ok = identityFetch({ peerId: coordA.peerId, publicKeyPem: coordA.publicKeyPem });
    const res = await checkCoordinatorTrust("http://coord.test/", { store, fetch: ok });
    expect(res).toMatchObject({ trusted: true, peerId: coordA.peerId, decision: { reason: "pinned_match" } });
    expect(ok.calls).toEqual(["http://coord.test/identity"]);

    const mismatch = await checkCoordinatorTrust("http://coord.test", {
      store,
      fetch: identityFetch({ peerId: coordA.peerId, publicKeyPem: coordA2.publicKeyPem })
    });
    expect(mismatch.trusted).toBe(false);
    expect(describeTrustFailure(mismatch)).toContain("key mismatch for coord-a");

    const unlisted = await checkCoordinatorTrust("http://coord.test", {
      store,
      fetch: identityFetch({ peerId: coordB.peerId, publicKeyPem: coordB.publicKeyPem })
    });
    expect(describeTrustFailure(unlisted)).toContain("not in TRUSTED_COORDINATOR_KEYS");
  });

  it("treats transport errors and malformed identities as untrusted with an error, not a decision", async () => {
    const store = new PinnedKeyStore({ mode: "open", pinFile: null });
    expect(await checkCoordinatorTrust("http://c", { store, fetch: identityFetch({}, 503) })).toMatchObject({ trusted: false, error: "identity_http_503" });
    expect(await checkCoordinatorTrust("http://c", { store, fetch: identityFetch({ peerId: "x" }) })).toMatchObject({ trusted: false, error: "identity_malformed" });
    const failing: IdentityFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const res = await checkCoordinatorTrust("http://c", { store, fetch: failing });
    expect(res.trusted).toBe(false);
    expect(res.decision).toBeUndefined();
    expect(describeTrustFailure(res)).toContain("ECONNREFUSED");
  });

  it("the gate verifies a URL once and re-checks after forget()", async () => {
    const store = new PinnedKeyStore({ mode: "tofu", pinFile: null });
    const fetch = identityFetch({ peerId: coordA.peerId, publicKeyPem: coordA.publicKeyPem });
    const gate = new CoordinatorTrustGate({ store, fetch });
    expect((await gate.check("http://coord.test/")).trusted).toBe(true);
    expect((await gate.check("http://coord.test")).trusted).toBe(true);
    expect(fetch.calls).toHaveLength(1);
    gate.forget("http://coord.test");
    expect((await gate.check("http://coord.test")).trusted).toBe(true);
    expect(fetch.calls).toHaveLength(2);
  });
});
