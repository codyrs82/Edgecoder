import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request } from "undici";
import { forwarderBluetoothLink } from "../../src/inference-api/bluetooth-failover.js";
import { allowedBlePeers, loadBleOfflineConsent, parseBleOfflineConsent, saveBleOfflineConsent, type BleOfflineConsent } from "../../src/mesh/ble/ble-offline-consent.js";
import { bleOfflineLink } from "../../src/mesh/ble/ble-offline-link.js";
import { bleSealKeyPairFromPem, generateSealKeyPair, openBleResult, openBleTask, sealBleResult, sealBleTask, sealKeyPairFromPrivate, type SealKeyPair } from "../../src/mesh/ble/ble-seal.js";
import { bleSealedResponder } from "../../src/mesh/ble/ble-sealed-responder.js";
import { MockBLETransport } from "../../src/mesh/ble/ble-transport.js";
import { createLocalForwarder } from "../../src/swarm/local-forwarder.js";
import type { BLETaskRequest, BLETaskResponse } from "../../src/common/types.js";

/*
 * Bluetooth failover only ever reaches the device the user allowed: its seal key is pinned when it
 * is allowed, the prompt is sealed to that key before any byte goes out, and only a reply sealed
 * back with it counts. No real Bluetooth: MockBLETransport and fakes.
 */

const b64 = (k: SealKeyPair) => k.publicKey.toString("base64");

describe("the seal (edgecoder-ble-seal/v1)", () => {
  it("reproduces the shared vectors the iOS app is checked against", () => {
    const f = JSON.parse(readFileSync(new URL("../security/fixtures/ble-seal-vectors.json", import.meta.url), "utf8"));
    const responder = sealKeyPairFromPrivate(Buffer.from(f.responderPrivateHex, "hex"));
    const sender = sealKeyPairFromPrivate(Buffer.from(f.senderPrivateHex, "hex"));
    const ephemeral = sealKeyPairFromPrivate(Buffer.from(f.ephemeralPrivateHex, "hex"));
    expect(b64(responder)).toBe(f.responderPublicB64);
    const { task, issuedAtMs } = JSON.parse(f.requestPlaintext);
    const { message, replyKey } = sealBleTask({ responderKey: responder.publicKey, sender, requestId: f.requestId, requesterId: f.requesterId, task, issuedAtMs, ephemeral, nonce: Buffer.from(f.requestNonceB64, "base64") });
    expect(message).toEqual(f.request);
    expect(replyKey.toString("hex")).toBe(f.replyKeyHex);
    expect(sealBleResult(replyKey, f.requestId, f.providerId, JSON.parse(f.replyPlaintext), Buffer.from(f.replyNonceB64, "base64"))).toEqual(f.reply);
    expect(openBleResult(f.reply, replyKey, f.requestId)).toEqual(JSON.parse(f.replyPlaintext));
  });

  it("only the pinned key opens it; the reply only opens for that request; tampering is refused", () => {
    const responder = generateSealKeyPair();
    const sender = generateSealKeyPair();
    const { message, replyKey } = sealBleTask({ responderKey: responder.publicKey, sender, requestId: "r1", requesterId: "mac-1", task: "secret prompt", issuedAtMs: 1 });
    expect(JSON.stringify(message)).not.toContain("secret prompt");
    const opened = openBleTask(message, responder);
    expect(opened).toMatchObject({ task: "secret prompt", requesterId: "mac-1" });
    expect(opened.senderKey.equals(sender.publicKey)).toBe(true);
    expect(() => openBleTask(message, generateSealKeyPair())).toThrow(/key_mismatch/);
    // An impostor that copies the pinned public key but lacks its private key can't open it.
    const impostor = { publicKey: responder.publicKey, privateKey: generateSealKeyPair().privateKey };
    expect(() => openBleTask(message, impostor)).toThrow(/seal_invalid/);
    expect(() => openBleTask({ ...message, requesterId: "mac-2" }, responder)).toThrow(/seal_invalid/);
    const reply = sealBleResult(opened.replyKey, "r1", "ios-1", { status: "completed", output: "ok", cpuSeconds: 1 });
    expect(openBleResult(reply, replyKey, "r1")).toEqual({ status: "completed", output: "ok", cpuSeconds: 1 });
    expect(openBleResult(reply, replyKey, "r2")).toBeNull();
    expect(openBleResult({ requestId: "r1", status: "completed", output: "plain text" }, replyKey, "r1")).toBeNull();
  });

  it("a device's seal key is stable: derived from its agent key", () => {
    const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(b64(bleSealKeyPairFromPem(pem))).toBe(b64(bleSealKeyPairFromPem(pem)));
  });
});

describe("consent: devices pinned by key", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const key = b64(generateSealKeyPair());

  it("on by default with nothing allowed; a device without a pinned key is never kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "ble-consent-"));
    dirs.push(dir);
    expect(loadBleOfflineConsent(join(dir, "missing.json"))).toEqual({ enabled: true, devices: [] });
    expect(parseBleOfflineConsent({ enabled: "yes", devices: [{ agentId: "ok-1", name: "Phone" }, { agentId: "bad id", sealKey: key }, { agentId: "ok-2", name: "\u0007Phone\n", sealKey: key }, { agentId: "ok-2", sealKey: key }, null] })).toEqual({ enabled: true, devices: [{ agentId: "ok-2", name: "Phone", sealKey: key }] });
    const file = join(dir, "ble-offline.json");
    saveBleOfflineConsent({ enabled: false, devices: [{ agentId: "ios-1", sealKey: key }] }, file);
    expect(loadBleOfflineConsent(file)).toEqual({ enabled: false, devices: [{ agentId: "ios-1", name: "EC-ios-1", sealKey: key }] });
  });

  it("filters to allowed devices advertising the pinned key; none when turned off", () => {
    const consent: BleOfflineConsent = { enabled: true, devices: [{ agentId: "ios-1", name: "My iPhone", sealKey: key }] };
    const other = b64(generateSealKeyPair());
    expect(allowedBlePeers([{ agentId: "ios-1", sealKey: key }, { agentId: "mac-2", sealKey: key }], consent)).toEqual([{ agentId: "ios-1", sealKey: key, name: "My iPhone" }]);
    expect(allowedBlePeers([{ agentId: "ios-1", sealKey: other }], consent)).toEqual([]);
    expect(allowedBlePeers([{ agentId: "ios-1" }], consent)).toEqual([]);
    expect(allowedBlePeers([{ agentId: "ios-1", sealKey: key }], { ...consent, enabled: false })).toEqual([]);
  });
});

/** Two devices on a mock BLE network: this Mac (requester) and a nearby device (responder). */
function mesh(o: { responderKey?: SealKeyPair; advertisedKey?: string; pinnedKey?: string; responderAllows?: boolean; plainOnly?: boolean } = {}) {
  const net = new Map<string, MockBLETransport>();
  const mac = new MockBLETransport("mac-self", net);
  const phone = new MockBLETransport("ios-1", net);
  const macKey = generateSealKeyPair();
  const phoneKey = o.responderKey ?? generateSealKeyPair();
  const advertised = o.advertisedKey ?? b64(phoneKey);
  phone.startAdvertising({ agentId: "ios-1", model: "qwen2.5-coder:7b", modelParamSize: 7, memoryMB: 0, batteryPct: 100, currentLoad: 0, deviceType: "phone", sealKey: advertised });
  mac.startAdvertising({ agentId: "mac-self", model: "", modelParamSize: 0, memoryMB: 0, batteryPct: 100, currentLoad: 0, deviceType: "laptop", sealKey: b64(macKey) });
  const received: unknown[] = [];
  const ran: string[] = [];
  const answer = bleSealedResponder({
    agentId: "ios-1",
    ownKey: phoneKey,
    senderAllowed: (id, k) => (o.responderAllows ?? true) && id === "mac-self" && k.equals(macKey.publicKey),
    run: async (task) => {
      ran.push(task);
      return { ok: true, output: "Futures are up.", durationMs: 900 };
    },
  });
  phone.onTaskRequest(async (req: BLETaskRequest) => {
    received.push(JSON.parse(JSON.stringify(req)));
    if (o.plainOnly || (req as { type?: string }).type !== "sealed_task") return { requestId: req.requestId, providerId: "ios-1", status: "completed", output: "plain answer", cpuSeconds: 1, providerSignature: "" } as BLETaskResponse;
    return (await answer(req)) as unknown as BLETaskResponse;
  });
  const consent: BleOfflineConsent = { enabled: true, devices: [{ agentId: "ios-1", name: "My iPhone", sealKey: o.pinnedKey ?? b64(phoneKey) }] };
  const logs: string[] = [];
  const link = bleOfflineLink({ agentId: "mac-self", transport: mac, ownKey: macKey, consent: () => consent, log: (l) => logs.push(l) });
  return { link, received, ran, logs, phoneKey };
}

describe("this Mac sending: only to the pinned key, sealed", () => {
  it("allowed and the key matches: the prompt goes sealed, the sealed reply is used", async () => {
    const m = mesh();
    expect(await m.link.run("ios-1", "secret prompt")).toMatchObject({ ok: true, output: "Futures are up." });
    expect(m.ran).toEqual(["secret prompt"]);
    expect(m.received).toHaveLength(1);
    expect(JSON.stringify(m.received[0])).not.toContain("secret prompt");
    expect(m.received[0]).toMatchObject({ type: "sealed_task", requesterId: "mac-self" });
    expect(m.link.nearby()).toEqual([expect.objectContaining({ agentId: "ios-1", allowed: true, pinned: true, keyMatches: true })]);
  });

  it("a device advertising another key than the pinned one: skipped, nothing sent, logged once", async () => {
    const m = mesh({ pinnedKey: b64(generateSealKeyPair()) });
    expect(await m.link.run("ios-1", "secret prompt")).toEqual({ ok: false, error: "key_mismatch" });
    expect(await m.link.run("ios-1", "secret prompt")).toEqual({ ok: false, error: "key_mismatch" });
    expect(m.received).toEqual([]);
    expect(m.logs).toHaveLength(1);
    expect(m.link.nearby()).toEqual([expect.objectContaining({ allowed: false, pinned: true, keyMatches: false })]);
  });

  it("an impostor advertising the pinned key without holding it: it can't read the prompt or answer", async () => {
    const real = generateSealKeyPair();
    const fake = generateSealKeyPair();
    const m = mesh({ responderKey: fake, advertisedKey: b64(real), pinnedKey: b64(real) });
    const r = await m.link.run("ios-1", "secret prompt");
    expect(r.ok).toBe(false);
    expect(m.ran).toEqual([]);
    expect(JSON.stringify(m.received)).not.toContain("secret prompt");
  });

  it("an older device without a seal key: never sent plain text", async () => {
    const net = new Map<string, MockBLETransport>();
    const mac = new MockBLETransport("mac-self", net);
    const phone = new MockBLETransport("ios-1", net);
    phone.startAdvertising({ agentId: "ios-1", model: "m:7b", modelParamSize: 7, memoryMB: 0, batteryPct: 100, currentLoad: 0, deviceType: "phone" });
    const sent: unknown[] = [];
    phone.onTaskRequest(async (req) => {
      sent.push(req);
      return { requestId: req.requestId, providerId: "ios-1", status: "completed", output: "x", cpuSeconds: 0, providerSignature: "" };
    });
    const link = bleOfflineLink({ agentId: "mac-self", transport: mac, ownKey: generateSealKeyPair(), consent: () => ({ enabled: true, devices: [{ agentId: "ios-1", name: "Old", sealKey: b64(generateSealKeyPair()) }] }), log: () => {} });
    expect(await link.run("ios-1", "secret prompt")).toMatchObject({ ok: false, error: "key_mismatch" });
    expect(sent).toEqual([]);
  });

  it("a plain-text reply is never taken as an answer", async () => {
    const m = mesh({ plainOnly: true });
    expect(await m.link.run("ios-1", "secret prompt")).toMatchObject({ ok: false, error: "failed" });
  });

  it("not on the list, or the setting off: refused before anything is sent", async () => {
    const m = mesh();
    expect(await m.link.run("mac-other", "x")).toEqual({ ok: false, error: "not_allowed" });
    expect(m.received).toEqual([]);
  });
});

describe("a Mac answering sealed requests (no mesh token needed)", () => {
  it("answers a device on its own list whose key the request proves; refuses others, replays and stale ones", async () => {
    const own = generateSealKeyPair();
    const friend = generateSealKeyPair();
    const stranger = generateSealKeyPair();
    let now = 1_000_000;
    const answer = bleSealedResponder({ agentId: "mac-2", ownKey: own, senderAllowed: (id, k) => id === "mac-1" && k.equals(friend.publicKey), run: async (t) => ({ ok: true, output: `ran ${t.length}`, durationMs: 5 }), now: () => now });
    const send = (sender: SealKeyPair, requesterId = "mac-1", requestId = `r-${Math.random()}`, issuedAtMs = now) => sealBleTask({ responderKey: own.publicKey, sender, requestId, requesterId, task: "hello", issuedAtMs });

    const ok = send(friend);
    expect(openBleResult(await answer(ok.message), ok.replyKey, ok.message.requestId)).toMatchObject({ status: "completed", output: "ran 5" });
    expect(await answer(ok.message)).toMatchObject({ status: "failed", output: "request_replayed" });
    // Someone claiming mac-1 with another key: the request opens, but the key isn't the pinned one.
    expect(await answer(send(stranger).message)).toMatchObject({ status: "failed", output: "not_allowed" });
    expect(await answer(send(friend, "mac-1", "old", now - 10 * 60_000).message)).toMatchObject({ status: "failed", output: "proof_expired" });
    expect(await answer(sealBleTask({ responderKey: generateSealKeyPair().publicKey, sender: friend, requestId: "x", requesterId: "mac-1", task: "t", issuedAtMs: now }).message)).toMatchObject({ status: "failed", output: "key_mismatch" });
    now += 1;
  });
});

describe("the forwarder: /forward/ble works while the agent isn't registered", () => {
  it("lists allowed devices and runs a sealed call through the app's link", async () => {
    const m = mesh();
    const forwarder: Server = createLocalForwarder({ token: () => "secret-token", coordinatorUrl: () => null, meshHeaders: () => ({}), signedHeaders: () => ({}), agentId: "mac-self", registrationWaitMs: 1, ble: () => m.link });
    await new Promise<void>((r) => forwarder.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(forwarder.address() as AddressInfo).port}`;
    try {
      const link = forwarderBluetoothLink({ forwarder: url, token: () => "secret-token" });
      expect((await link.peers()).map((p) => p.agentId)).toEqual(["ios-1"]);
      expect(await link.run("ios-1", "hello")).toMatchObject({ output: "Futures are up." });
      await expect(link.run("mac-other", "hello")).rejects.toThrow(/not_allowed/);
      const noAuth = await request(`${url}/forward/ble/peers`);
      expect(noAuth.statusCode).toBe(401);
      await noAuth.body.dump();
    } finally {
      forwarder.close();
    }
  });
});
