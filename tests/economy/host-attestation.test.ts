import { createHash, hkdfSync } from "node:crypto";
import { createServer, type AddressInfo, type Server } from "node:net";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import {
  HostServiceAttestor,
  attestSelfServices,
  heartbeatCounts,
  signHostHeartbeat,
  verifyHostHeartbeat,
  type ServiceProbes
} from "../../src/economy/host-attestation.js";
import {
  bitcoinMessage,
  bitcoinVersionPayload,
  isPrivateAddress,
  noiseDecrypt,
  noiseEncrypt,
  noiseInit,
  probeBitcoind,
  probeCoordinatorIdentity,
  probeElectrum,
  probeLightning,
  resolveProbeTarget
} from "../../src/economy/service-probes.js";
import { PostgresStore, SCHEMA_SQL } from "../../src/db/postgres.js";
import { distributeFeePool } from "../../src/economy/payouts.js";

const host = createPeerKeys("coord-host");
const intruder = createPeerKeys("coord-evil");

describe("signed host heartbeats (pentest: host weight self-reported)", () => {
  const fields = { hostId: "coord-host", accountId: "host:coord-host", services: ["coordinator", "bitcoind"], coordinatorUrl: "https://host.example" };

  it("verifies against the key the mesh holds for the host", () => {
    const hb = signHostHeartbeat(fields, host.privateKeyPem);
    expect(verifyHostHeartbeat(hb, host.publicKeyPem)).toEqual({ ok: true });
  });

  it("a mesh-token holder cannot heartbeat for another host", () => {
    const forged = signHostHeartbeat(fields, intruder.privateKeyPem);
    expect(verifyHostHeartbeat(forged, host.publicKeyPem)).toEqual({ ok: false, reason: "invalid_signature" });
    expect(verifyHostHeartbeat(forged, undefined)).toEqual({ ok: false, reason: "host_unknown" });
  });

  it("covers services, payee and node id: editing any of them breaks the signature", () => {
    const hb = signHostHeartbeat({ ...fields, lightningNodeId: "02" + "ab".repeat(32) }, host.privateKeyPem);
    expect(verifyHostHeartbeat({ ...hb, services: [...hb.services, "lightning"] }, host.publicKeyPem).ok).toBe(false);
    expect(verifyHostHeartbeat({ ...hb, accountId: "attacker" }, host.publicKeyPem).ok).toBe(false);
    expect(verifyHostHeartbeat({ ...hb, lightningNodeId: "03" + "ab".repeat(32) }, host.publicKeyPem).ok).toBe(false);
    expect(verifyHostHeartbeat({ ...hb, ports: { bitcoind: 1 } }, host.publicKeyPem).ok).toBe(false);
    // Service order and case do not matter (normalized before signing).
    expect(verifyHostHeartbeat({ ...hb, services: ["BITCOIND", "coordinator"] }, host.publicKeyPem).ok).toBe(true);
  });

  it("rejects stale heartbeats and reserved payee accounts", () => {
    const old = signHostHeartbeat(fields, host.privateKeyPem, Date.now() - 10 * 60_000);
    expect(verifyHostHeartbeat(old, host.publicKeyPem)).toEqual({ ok: false, reason: "stale_heartbeat" });
    const pool = signHostHeartbeat({ ...fields, accountId: "network:fee_pool" }, host.privateKeyPem);
    expect(verifyHostHeartbeat(pool, host.publicKeyPem, { reservedAccounts: ["network:fee_pool"] })).toEqual({ ok: false, reason: "reserved_account" });
  });

  it("counts at most one heartbeat per interval (20% jitter allowed)", () => {
    expect(heartbeatCounts(undefined, 1_000, 60_000)).toBe(true);
    expect(heartbeatCounts(0, 30_000, 60_000)).toBe(false);
    expect(heartbeatCounts(0, 48_000, 60_000)).toBe(true);
  });

  it("a heartbeat flood no longer buys a full-uptime share", () => {
    // 1,440 heartbeats in under 30 s: only the first counts.
    let last: number | undefined;
    let counted = 0;
    for (let i = 0; i < 1_440; i += 1) {
      const now = 1_000 + i * 20;
      if (heartbeatCounts(last, now, 60_000)) {
        counted += 1;
        last = now;
      }
    }
    expect(counted).toBe(1);
    const shares = distributeFeePool(1_000_000, [
      { hostId: "spammer", accountId: "a", heartbeatsInWindow: counted, services: ["coordinator"] },
      { hostId: "honest", accountId: "b", heartbeatsInWindow: 1_440, services: ["coordinator"] }
    ], 1_440);
    expect(shares.map((s) => s.hostId)).toEqual(["honest"]);
  });
});

function fakeProbes(overrides: Partial<Record<keyof ServiceProbes, unknown>> = {}) {
  const calls: string[] = [];
  const ok = async () => ({ ok: true });
  const probes: ServiceProbes = {
    coordinator: async (...a) => (calls.push(`coordinator:${a[0]}`), ((overrides.coordinator as ServiceProbes["coordinator"]) ?? ok)(...a)),
    bitcoind: async (...a) => (calls.push(`bitcoind:${a[0]}:${a[1]}`), ((overrides.bitcoind as ServiceProbes["bitcoind"]) ?? ok)(...a)),
    lightning: async (...a) => (calls.push(`lightning:${a[0]}:${a[1]}:${a[2]}`), ((overrides.lightning as ServiceProbes["lightning"]) ?? ok)(...a)),
    electrs: async (...a) => (calls.push(`electrs:${a[0]}:${a[1]}`), ((overrides.electrs as ServiceProbes["electrs"]) ?? ok)(...a)),
    resolve: (overrides.resolve as ServiceProbes["resolve"]) ?? (async () => ({ ok: true as const, address: "203.0.113.7" }))
  };
  return { probes, calls };
}

describe("HostServiceAttestor", () => {
  const target = {
    hostId: "coord-host",
    publicKeyPem: host.publicKeyPem,
    coordinatorUrl: "https://host.example:4301",
    services: ["coordinator", "bitcoind", "lightning", "electrs"],
    lightningNodeId: "02" + "cd".repeat(32)
  };

  it("probes declared services on the mesh-known host, with network default ports", async () => {
    const { probes, calls } = fakeProbes();
    const r = await new HostServiceAttestor({ network: "signet", probes }).attest(target);
    expect(r.attested).toEqual(["bitcoind", "coordinator", "electrs", "lightning"]);
    expect(calls).toEqual(expect.arrayContaining([
      "coordinator:https://host.example:4301",
      "bitcoind:203.0.113.7:38333",
      `lightning:203.0.113.7:9735:${target.lightningNodeId}`,
      "electrs:203.0.113.7:50001"
    ]));
  });

  it("a declared service that does not answer does not count", async () => {
    const { probes } = fakeProbes({ bitcoind: async () => ({ ok: false, detail: "timeout" }) });
    const r = await new HostServiceAttestor({ network: "bitcoin", probes }).attest(target);
    expect(r.attested).toEqual(["coordinator", "electrs", "lightning"]);
    expect(r.results.bitcoind).toEqual({ ok: false, detail: "timeout" });
  });

  it("lightning needs a node id; without a passing coordinator probe nothing is attested", async () => {
    const a = await new HostServiceAttestor({ network: "testnet", probes: fakeProbes().probes }).attest({ ...target, lightningNodeId: undefined });
    expect(a.attested).not.toContain("lightning");
    const b = await new HostServiceAttestor({ network: "testnet", probes: fakeProbes({ coordinator: async () => ({ ok: false, detail: "identity_key_mismatch" }) }).probes }).attest(target);
    expect(b.attested).toEqual([]);
  });

  it("refuses to probe private addresses (the default resolver policy)", async () => {
    expect(await resolveProbeTarget("127.0.0.1", false)).toEqual({ ok: false, detail: "private_address" });
    expect(await resolveProbeTarget("10.1.2.3", true)).toEqual({ ok: true, address: "10.1.2.3" });
    for (const ip of ["10.0.0.1", "192.168.1.1", "172.20.0.1", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "::ffff:127.0.0.1"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["203.0.113.7", "8.8.8.8", "2001:db8::1"]) expect(isPrivateAddress(ip)).toBe(false);
    const { probes } = fakeProbes({ resolve: async () => ({ ok: false as const, detail: "private_address" }) });
    const r = await new HostServiceAttestor({ network: "signet", probes }).attest(target);
    expect(r.attested).toEqual(["coordinator"]);
    expect(r.results.bitcoind.detail).toBe("private_address");
  });

  it("caches a pass, retries a failure later, and re-probes at once when the declaration changes", async () => {
    let now = 0;
    const { probes, calls } = fakeProbes({ electrs: async () => ({ ok: false }) });
    const att = new HostServiceAttestor({ network: "signet", probes, ttlMs: 1_000_000, retryMs: 100, now: () => now });
    await att.attest(target);
    const n = calls.length;
    await att.attest(target);
    expect(calls.length).toBe(n);
    now = 200;
    await att.attest(target);
    expect(calls.length).toBeGreaterThan(n);
    const m = calls.length;
    await att.attest({ ...target, services: ["coordinator"] });
    expect(calls.length).toBeGreaterThan(m);
  });

  it("own services count only when the local backend answers", async () => {
    const r = await attestSelfServices(["coordinator", "bitcoind", "lightning", "electrs"], {
      lightning: async () => ({ ok: true }),
      bitcoind: async () => {
        throw new Error("rpc down");
      }
    });
    expect(r.attested).toEqual(["coordinator", "lightning"]);
    expect(r.results.bitcoind).toEqual({ ok: false, detail: "rpc down" });
    expect(r.results.electrs).toEqual({ ok: false, detail: "no_local_check" });
  });
});

/* ---- protocol probes against local fake services ---- */

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function listen(onData: (data: Buffer, write: (b: Buffer) => void) => void): Promise<number> {
  const server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      onData(buf, (b) => sock.write(b));
    });
    sock.on("error", () => undefined);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

const sha = (...p: Buffer[]) => createHash("sha256").update(Buffer.concat(p)).digest();
const hkdf = (salt: Buffer, ikm: Buffer) => {
  const o = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.alloc(0), 64));
  return [o.subarray(0, 32), o.subarray(32)];
};
const ecdh = (priv: Uint8Array, pub: Buffer) => sha(Buffer.from(secp256k1.getSharedSecret(priv, pub, true)));

/** Minimal BOLT 8 responder: checks act one with its static key and answers act two. */
function bolt8Responder(staticPriv: Uint8Array) {
  const sPub = Buffer.from(secp256k1.getPublicKey(staticPriv, true));
  return (buf: Buffer, write: (b: Buffer) => void) => {
    if (buf.length < 50) return;
    let { h, ck } = noiseInit(sPub);
    const re = buf.subarray(1, 34);
    h = sha(h, re);
    const [ck1, k1] = hkdf(ck, ecdh(staticPriv, re));
    if (!noiseDecrypt(k1, 0, h, buf.subarray(34, 50))) return write(Buffer.from("nope"));
    h = sha(h, buf.subarray(34, 50));
    const e = secp256k1.utils.randomSecretKey();
    const ePub = Buffer.from(secp256k1.getPublicKey(e, true));
    h = sha(h, ePub);
    const [, k2] = hkdf(ck1, ecdh(e, re));
    write(Buffer.concat([Buffer.from([0]), ePub, noiseEncrypt(k2, 0, h, Buffer.alloc(0))]));
  };
}

describe("service probes speak the real protocols", () => {
  it("bitcoind: a version answered on the right network passes; wrong magic or a silent port fails", async () => {
    const port = await listen((buf, write) => {
      if (buf.length >= 24) write(bitcoinMessage("signet", "version", bitcoinVersionPayload()));
    });
    expect(await probeBitcoind("127.0.0.1", port, "signet", 2_000)).toMatchObject({ ok: true });
    expect(await probeBitcoind("127.0.0.1", port, "bitcoin", 2_000)).toMatchObject({ ok: false });
    const silent = await listen(() => undefined);
    expect(await probeBitcoind("127.0.0.1", silent, "signet", 300)).toEqual({ ok: false, detail: "timeout" });
  });

  it("lightning: only the holder of the declared node key completes act two", async () => {
    const nodePriv = secp256k1.utils.randomSecretKey();
    const nodeId = Buffer.from(secp256k1.getPublicKey(nodePriv, true)).toString("hex");
    const port = await listen(bolt8Responder(nodePriv));
    expect(await probeLightning("127.0.0.1", port, nodeId, 2_000)).toEqual({ ok: true, detail: "bolt8_act_two_valid" });
    // A listener holding a different key (an impostor, or a proxy to someone else's node id).
    const other = secp256k1.utils.randomSecretKey();
    const impostor = await listen(bolt8Responder(other));
    expect((await probeLightning("127.0.0.1", impostor, nodeId, 500)).ok).toBe(false);
    // An open port that answers with arbitrary bytes.
    const garbage = await listen((_b, write) => write(Buffer.alloc(50, 7)));
    expect((await probeLightning("127.0.0.1", garbage, nodeId, 2_000)).ok).toBe(false);
    expect(await probeLightning("127.0.0.1", port, "not-a-node-id")).toEqual({ ok: false, detail: "no_node_id" });
  });

  it("electrs: server.version must return a result", async () => {
    const port = await listen((buf, write) => {
      if (buf.includes(0x0a)) write(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: ["electrs/0.10.10", "1.4"] }) + "\n"));
    });
    expect(await probeElectrum("127.0.0.1", port, 2_000)).toEqual({ ok: true, detail: "electrs/0.10.10" });
    const bad = await listen((buf, write) => {
      if (buf.includes(0x0a)) write(Buffer.from("HTTP/1.1 400 Bad Request\n"));
    });
    expect((await probeElectrum("127.0.0.1", bad, 2_000)).ok).toBe(false);
  });

  it("coordinator: /identity must name the host with the signing key", async () => {
    const fetcher = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });
    expect(await probeCoordinatorIdentity("https://h", "coord-host", host.publicKeyPem, fetcher({ peerId: "coord-host", publicKeyPem: host.publicKeyPem }))).toEqual({ ok: true });
    expect(await probeCoordinatorIdentity("https://h", "coord-host", host.publicKeyPem, fetcher({ peerId: "coord-host", publicKeyPem: intruder.publicKeyPem }))).toEqual({ ok: false, detail: "identity_key_mismatch" });
    expect(await probeCoordinatorIdentity("https://h", "coord-host", host.publicKeyPem, fetcher({ peerId: "coord-other", publicKeyPem: host.publicKeyPem }))).toEqual({ ok: false, detail: "identity_peer_mismatch" });
  });
});

// Real Postgres (CI sets TEST_DATABASE_URL): counting is atomic per host row.
const PG_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("recordAttestedHostHeartbeat against real Postgres", () => {
  it("concurrent heartbeats inside one interval count once; attested services are what is stored", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL, max: 10 });
    try {
      await pool.query(SCHEMA_SQL);
      const store = new PostgresStore(pool);
      const hostId = `host-${Math.random().toString(36).slice(2)}`;
      const base = { hostId, accountId: `host:${hostId}`, services: ["coordinator"], declaredServices: ["bitcoind", "coordinator"], firstSeenMs: 0, lastSeenMs: 0, heartbeatsInWindow: 1, attestedAtMs: 1 };
      const t0 = 1_000_000;
      const first = await store.recordAttestedHostHeartbeat({ ...base }, t0, 48_000);
      expect(first).toEqual({ counted: true, heartbeatsInWindow: 1 });
      const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => store.recordAttestedHostHeartbeat({ ...base }, t0 + 1_000 + i, 48_000)));
      expect(burst.filter((r) => r.counted)).toHaveLength(0);
      const next = await store.recordAttestedHostHeartbeat({ ...base }, t0 + 60_000, 48_000);
      expect(next).toEqual({ counted: true, heartbeatsInWindow: 2 });
      const row = (await store.listInfrastructureHosts()).find((h) => h.hostId === hostId);
      expect(row).toMatchObject({ services: ["coordinator"], declaredServices: ["bitcoind", "coordinator"], heartbeatsInWindow: 2, lastCountedMs: t0 + 60_000 });
    } finally {
      await pool.end();
    }
  });
});
