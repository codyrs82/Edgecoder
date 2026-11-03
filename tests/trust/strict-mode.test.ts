import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { PinnedKeyStore, checkCoordinatorTrust, fingerprint, type IdentityFetch } from "../../src/trust/pinned-keys.js";
import { selectCoordinator, selectOptionsFromEnv } from "../../src/discovery/index.js";
import { signAnnouncement } from "../../src/discovery/types.js";
import type { FetchLike } from "../../src/discovery/selector.js";
import { coordinatorFetch } from "./coordinator-fetch.js";

// Pentest #6: EDGECODER_TRUST_MODE stays tofu by default; strict must be correct before production flips it.
const listed = createPeerKeys("coord-listed");
const unlisted = createPeerKeys("coord-unlisted");
const entry = (k: ReturnType<typeof createPeerKeys>) => `${k.peerId}:${fingerprint(k.publicKeyPem)}`;

const identityFetch = (k: ReturnType<typeof createPeerKeys>): IdentityFetch => coordinatorFetch(k);

describe("strict trust mode", () => {
  it("strict with nothing listed is a startup error; tofu (the default) and listed strict are fine", () => {
    expect(new PinnedKeyStore({ mode: "strict", pinFile: null }).configProblem()).toMatch(/TRUSTED_COORDINATOR_KEYS/);
    expect(new PinnedKeyStore({ mode: "strict", entries: entry(listed), pinFile: null }).configProblem()).toBeNull();
    expect(PinnedKeyStore.fromEnv({}, { pinFile: "/nonexistent/trust" }).mode).toBe("tofu");
    expect(PinnedKeyStore.fromEnv({}, { pinFile: "/nonexistent/trust" }).configProblem()).toBeNull();
  });

  it("trusts exactly the listed keys over /identity and never pins anything", async () => {
    const pinFile = join(mkdtempSync(join(tmpdir(), "ec-strict-")), "trusted-coordinators");
    const store = new PinnedKeyStore({ mode: "strict", entries: entry(listed), pinFile });
    expect(await checkCoordinatorTrust("https://a", { store, fetch: identityFetch(listed) })).toMatchObject({ trusted: true, decision: { reason: "pinned_match" } });
    expect(await checkCoordinatorTrust("https://b", { store, fetch: identityFetch(unlisted) })).toMatchObject({ trusted: false, decision: { reason: "strict_unlisted" } });
    // An unlisted coordinator presenting a listed peerId with its own key is a mismatch, not a pass.
    const impostor: IdentityFetch = coordinatorFetch({ ...unlisted, peerId: listed.peerId });
    expect(await checkCoordinatorTrust("https://c", { store, fetch: impostor })).toMatchObject({ trusted: false, decision: { reason: "pinned_mismatch" } });
    expect(existsSync(pinFile)).toBe(false);
  });

  it("entries from the trust file count as listed, including pre-unification PEM fingerprints", () => {
    const dir = mkdtempSync(join(tmpdir(), "ec-strict-file-"));
    const pinFile = join(dir, "trusted-coordinators");
    // What a tofu agent built before the fingerprint unification wrote.
    const legacy = createHash("sha256").update(listed.publicKeyPem.trim() + "\n").digest("hex");
    const tofu = new PinnedKeyStore({ mode: "tofu", pinFile });
    tofu.isTrusted(unlisted.peerId, unlisted.publicKeyPem);
    expect(readFileSync(pinFile, "utf8")).toContain(entry(unlisted));
    const strict = new PinnedKeyStore({ mode: "strict", entries: `${listed.peerId}:${legacy}`, pinFile });
    expect(strict.isTrusted(listed.peerId, listed.publicKeyPem).trusted).toBe(true);
    expect(strict.isTrusted(unlisted.peerId, unlisted.publicKeyPem).trusted).toBe(true); // pinned in the file during tofu
    expect(strict.isTrusted("coord-new", createPeerKeys("coord-new").publicKeyPem)).toMatchObject({ trusted: false, reason: "strict_unlisted" });
  });

  it("wouldTrust filters candidates without side effects", () => {
    const strict = new PinnedKeyStore({ mode: "strict", entries: entry(listed), pinFile: null });
    expect(strict.wouldTrust(listed.peerId, listed.publicKeyPem)).toBe(true);
    expect(strict.wouldTrust(unlisted.peerId, unlisted.publicKeyPem)).toBe(false);
    expect(strict.wouldTrust(listed.peerId, unlisted.publicKeyPem)).toBe(false);
    expect(strict.wouldTrust(undefined, undefined)).toBe(false);
    const tofu = new PinnedKeyStore({ mode: "tofu", pinFile: null });
    expect(tofu.wouldTrust(unlisted.peerId, unlisted.publicKeyPem)).toBe(true);
    expect(tofu.knownFingerprint(unlisted.peerId)).toBeUndefined();
  });

  it("discovery in strict mode only selects coordinators whose announced key is listed", async () => {
    const NOW = Date.now();
    const ann = (k: ReturnType<typeof createPeerKeys>, url: string) =>
      signAnnouncement({ peerId: k.peerId, publicKeyPem: k.publicKeyPem, url, region: "ord", services: ["swarm"], computeClasses: ["cpu.std"], version: "1", announcedAtMs: NOW }, k.privateKeyPem);
    const fetch: FetchLike = async (url) => {
      const u = new URL(url);
      if (u.pathname === "/discovery/peers" && u.host === "seed.example") return { status: 200, json: async () => ({ peers: [ann(listed, "https://listed.example"), ann(unlisted, "https://unlisted.example")] }) };
      if (u.pathname === "/health/runtime") return { status: 200, json: async () => ({ ok: true, coordinator: { queued: u.host === "listed.example" ? 40 : 0, agents: 2 } }) };
      return { status: 404, json: async () => ({}) };
    };
    const strict = new PinnedKeyStore({ mode: "strict", entries: entry(listed), pinFile: null });
    const base = { staticUrls: ["https://seed.example"], domain: false as const, relays: false as const, expandPeers: true, fetch };
    // Without the filter the idle, unlisted coordinator wins on load.
    expect((await selectCoordinator(base))?.url).not.toBe("https://listed.example");
    const picked = await selectCoordinator({ ...base, acceptCandidate: (c) => strict.wouldTrust(c.peerId, c.publicKeyPem) });
    expect(picked?.url).toBe("https://listed.example");
    // The env builder passes the filter through.
    expect(selectOptionsFromEnv({ env: {}, acceptCandidate: () => false }).acceptCandidate?.({ url: "x", source: "static" })).toBe(false);
  });
});
