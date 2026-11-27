import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request } from "undici";
import { routeLabel, type RouteInputs, type Route } from "../../src/inference-api/auto-route.js";
import { NETWORK_FAILOVER_WHY, autoBackend } from "../../src/inference-api/backends.js";
import {
  BLUETOOTH_FAILOVER_WHY,
  bluetoothCandidates,
  bluetoothPrompt,
  forwarderBluetoothLink,
  overBluetooth,
  type BluetoothLink,
  type BluetoothPeer,
} from "../../src/inference-api/bluetooth-failover.js";
import { NetworkInferenceError } from "../../src/apps/ide/network-inference.js";
import { ChatBackendError, type ChatBackend, type ChatPiece } from "../../src/inference-api/types.js";
import { allowedBlePeers, loadBleOfflineConsent, parseBleOfflineConsent, saveBleOfflineConsent, type BleOfflineConsent } from "../../src/mesh/ble/ble-offline-consent.js";
import { bleOfflineLink } from "../../src/mesh/ble/ble-offline-link.js";
import { createLocalForwarder } from "../../src/swarm/local-forwarder.js";
import type { BLEPeerEntry, BLETaskRequest, BLETaskResponse } from "../../src/common/types.js";
import { routeChoiceNote } from "../../src/apps/ide/bots.js";

/*
 * A bit on Network only with the network out of reach: this computer first (#640), then a nearby
 * device the user allowed, over Bluetooth, then the bot's own retry. No real Bluetooth here: the
 * transport and the link are fakes.
 */

const price = { input: 100, output: 400 };
const inputs: RouteInputs = {
  localModels: ["qwen2.5-coder:14b"],
  myModels: [],
  leases: [],
  networkModels: [{ model: "qwen3-coder:30b", classes: ["gpu"], cSatsPerMTokens: price }],
  classPrice: { cpu: 0.009, apple: 0.052, gpu: 0.043, "gpu.dc": 0.304 },
  balanceCSats: 500,
};
const req = { model: "auto", messages: [{ role: "system" as const, content: "You are Trader Boy." }, { role: "user" as const, content: "What moved the market today?" }] };
async function collect(b: ChatBackend): Promise<ChatPiece[]> {
  const out: ChatPiece[] = [];
  for await (const p of b(req as never)) out.push(p);
  return out;
}
const NOT_CONNECTED = new NetworkInferenceError("This computer's agent isn't connected to the network right now (it is starting or reconnecting). Nothing was charged; try again shortly.", 502);
const OLLAMA_DOWN = new ChatBackendError("Ollama isn't running on this computer. Open EdgeCoder to start it.", 503);

const phone: BluetoothPeer = { agentId: "ios-aaaa1111", name: "Cody's iPhone", model: "qwen2.5-coder:7b", modelParamSize: 7, deviceType: "phone", rssi: -60 };
const laptop: BluetoothPeer = { agentId: "mac-bbbb2222", name: "Studio Mac", model: "qwen2.5-coder:14b", modelParamSize: 14, deviceType: "laptop", rssi: -75 };

function fakeLink(peers: BluetoothPeer[], fail: string[] = []): BluetoothLink & { sent: Array<{ agentId: string; prompt: string }> } {
  const sent: Array<{ agentId: string; prompt: string }> = [];
  return {
    sent,
    peers: async () => peers,
    run: async (agentId, prompt) => {
      sent.push({ agentId, prompt });
      if (fail.includes(agentId)) throw new Error("timed out");
      return { output: `answer from ${agentId}`, ms: 1200 };
    },
  };
}

function backend(o: { network?: () => AsyncGenerator<ChatPiece>; local?: "ok" | "down"; localModels?: string[]; bluetooth?: BluetoothLink; routes?: Route[] } = {}) {
  const tried: string[] = [];
  const routes: Route[] = o.routes ?? [];
  const network = o.network ?? (async function* () {
    throw NOT_CONNECTED;
  });
  const b = autoBackend({
    inputs: async () => ({ ...inputs, ...(o.localModels ? { localModels: o.localModels } : {}) }),
    policy: "network_only",
    plan: () => ({ allowanceCSats: 50 }),
    onRoute: (r) => routes.push(r),
    run: (r) =>
      r.placement === "local"
        ? async function* () {
            tried.push(`local:${r.model}`);
            if (o.local === "down") throw OLLAMA_DOWN;
            yield { delta: "Futures are up." };
            yield { done: true, cSatsSpent: 0 };
          }
        : async function* () {
            tried.push(`network:${r.model}`);
            yield* network();
          },
    networkBestFit: () =>
      async function* () {
        tried.push("bestfit");
        yield* network();
      },
    ...(o.bluetooth ? { bluetooth: o.bluetooth } : {}),
  });
  return { b, tried, routes };
}

describe("Network only: this computer, then Bluetooth, then the retry", () => {
  it("this computer can take it: Bluetooth is never asked", async () => {
    const link = fakeLink([phone]);
    const { b, tried } = backend({ local: "ok", bluetooth: link });
    const out = await collect(b);
    expect(tried.at(-1)).toBe("local:qwen2.5-coder:14b");
    expect(String((out.at(-1) as { where?: string }).where)).toContain(NETWORK_FAILOVER_WHY);
    expect(link.sent).toEqual([]);
  });

  it("Ollama not running: an allowed nearby device runs it over Bluetooth, free, and says so", async () => {
    const link = fakeLink([phone]);
    const { b, tried, routes } = backend({ local: "down", bluetooth: link });
    const out = await collect(b);
    expect(tried).toEqual(["bestfit", "network:qwen3-coder:30b", "local:qwen2.5-coder:14b"]);
    expect(link.sent.map((s) => s.agentId)).toEqual([phone.agentId]);
    expect(out[0]).toEqual({ delta: `answer from ${phone.agentId}` });
    const done = out.at(-1) as Extract<ChatPiece, { done: true }>;
    expect(done.cSatsSpent).toBe(0);
    expect(done.where).toContain(BLUETOOTH_FAILOVER_WHY);
    expect(done.served).toMatchObject({ label: "Over Bluetooth: Cody's iPhone", hardware: "Over Bluetooth: Cody's iPhone", computeClass: "bluetooth", own: false, genMs: 1200 });
    // The bot view's "Running on" and per-step lines.
    expect(routeLabel(routes.at(-1)!)).toBe("Over Bluetooth: Cody's iPhone · qwen2.5-coder:7b");
    expect(routeChoiceNote(routes.at(-1)!, "network_only")).toBe(`Network only → qwen2.5-coder:7b on Cody's iPhone over Bluetooth (${BLUETOOTH_FAILOVER_WHY})`);
  });

  it("no model on this computer at all: straight to Bluetooth", async () => {
    const link = fakeLink([phone]);
    const { b, tried } = backend({ localModels: [], bluetooth: link });
    await collect(b);
    expect(tried.some((t) => t.startsWith("local:"))).toBe(false);
    expect(link.sent).toHaveLength(1);
  });

  it("one device fails: the next is tried; every device fails: the network's error, for the bot's retry", async () => {
    // A quick step: the smallest model that fits (the phone's 7B) first, as on this computer.
    const link = fakeLink([laptop, phone], [phone.agentId]);
    const { b } = backend({ local: "down", bluetooth: link });
    const out = await collect(b);
    expect(link.sent.map((s) => s.agentId)).toEqual([phone.agentId, laptop.agentId]);
    expect((out.at(-1) as { served?: { label: string } }).served?.label).toBe("Over Bluetooth: Studio Mac");

    const none = fakeLink([phone, laptop], [phone.agentId, laptop.agentId]);
    await expect(collect(backend({ local: "down", bluetooth: none }).b)).rejects.toBe(NOT_CONNECTED);
  });

  it("no allowed device nearby: the network's error, as before", async () => {
    await expect(collect(backend({ local: "down", bluetooth: fakeLink([]) }).b)).rejects.toBe(NOT_CONNECTED);
  });

  it("money is not the network being out of reach: no Bluetooth", async () => {
    const link = fakeLink([phone]);
    const { b } = backend({
      local: "down",
      bluetooth: link,
      network: async function* () {
        throw new ChatBackendError("Not enough cSats", 402, undefined, { code: "insufficient_credits" });
      },
    });
    await expect(collect(b)).rejects.toThrow();
    expect(link.sent).toEqual([]);
  });

  it("the network back: the next call goes to the network, not Bluetooth", async () => {
    let up = false;
    const link = fakeLink([phone]);
    const { b, tried } = backend({
      local: "down",
      bluetooth: link,
      network: async function* () {
        if (!up) throw NOT_CONNECTED;
        yield { delta: "from the network" };
        yield { done: true, cSatsSpent: 0.4 };
      },
    });
    await collect(b);
    expect(link.sent).toHaveLength(1);
    up = true;
    tried.length = 0;
    const out = await collect(b);
    expect(tried).toEqual(["bestfit"]);
    expect(out[0]).toEqual({ delta: "from the network" });
    expect(link.sent).toHaveLength(1);
  });

  it("only Network only fails over (Local only never reaches Bluetooth)", async () => {
    const link = fakeLink([phone]);
    const b = autoBackend({
      inputs: async () => inputs,
      policy: "local_only",
      run: () =>
        async function* () {
          throw OLLAMA_DOWN;
        },
      bluetooth: link,
    });
    await expect(collect(b)).rejects.toThrow();
    expect(link.sent).toEqual([]);
  });
});

describe("which device and model", () => {
  const workload = { heavy: true, promptTokens: 2000, needsTools: true };
  it("the model this computer's failover would pick first (the best fit), then the fallback; strongest signal first", () => {
    const near: BluetoothPeer = { ...laptop, agentId: "mac-near", rssi: -40 };
    const order = bluetoothCandidates([phone, laptop, near], workload, inputs).map((c) => c.peer.agentId);
    expect(order).toEqual(["mac-near", laptop.agentId, phone.agentId]);
  });
  it("tools aren't needed over Bluetooth, so a model without tool support is still picked", () => {
    const r1 = bluetoothCandidates([{ ...phone, model: "deepseek-r1:14b" }], workload, inputs);
    expect(r1.map((c) => c.peer.model)).toEqual(["deepseek-r1:14b"]);
  });
  it("an embedding model is never used", () => {
    expect(bluetoothCandidates([{ ...phone, model: "nomic-embed-text" }], workload, inputs)).toEqual([]);
  });
});

describe("served-by label", () => {
  it("Over Bluetooth: <device name>", () => {
    expect(overBluetooth("Cody's iPhone", { genMs: 812.6 })).toEqual({ label: "Over Bluetooth: Cody's iPhone", own: false, computeClass: "bluetooth", tier: null, hardware: "Over Bluetooth: Cody's iPhone", region: null, country: null, genMs: 813 });
  });
});

describe("the prompt over Bluetooth", () => {
  it("fits the device's limit, keeps the system prompt and the latest message", () => {
    const messages = [
      { role: "system" as const, content: "You are Trader Boy." },
      ...Array.from({ length: 50 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: `message ${i} ${"x".repeat(1000)}` })),
      { role: "tool" as const, tool_name: "web_search", content: "S&P 500 +0.4%" },
    ];
    const p = bluetoothPrompt(messages, 15_000);
    expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(15_000);
    expect(p.startsWith("System: You are Trader Boy.")).toBe(true);
    expect(p).toContain("Tool result (web_search): S&P 500 +0.4%");
    expect(p).not.toContain("message 0 ");
    expect(p.endsWith("Assistant:")).toBe(true);
  });
});

describe("consent: only devices the user allowed", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const consent: BleOfflineConsent = { enabled: true, devices: [{ agentId: phone.agentId, name: "Cody's iPhone" }] };

  it("on by default, with no device allowed (nothing is sent until the user allows one)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ble-consent-"));
    dirs.push(dir);
    expect(loadBleOfflineConsent(join(dir, "missing.json"))).toEqual({ enabled: true, devices: [] });
    expect(allowedBlePeers([phone, laptop], loadBleOfflineConsent(join(dir, "missing.json")))).toEqual([]);
  });

  it("filters to allowed devices, with the user's name; none when turned off", () => {
    expect(allowedBlePeers([{ ...phone, name: "EC-ios-aaaa" }, laptop], consent).map((p) => [p.agentId, p.name])).toEqual([[phone.agentId, "Cody's iPhone"]]);
    expect(allowedBlePeers([phone, laptop], { ...consent, enabled: false })).toEqual([]);
  });

  it("a malformed file never widens the list; saving round-trips", () => {
    expect(parseBleOfflineConsent({ enabled: "yes", devices: [{ agentId: "" }, { agentId: "bad id with spaces" }, { agentId: "ok-1", name: "\u0007Phone\n" }, { agentId: "ok-1" }, null] })).toEqual({ enabled: true, devices: [{ agentId: "ok-1", name: "Phone" }] });
    const dir = mkdtempSync(join(tmpdir(), "ble-consent-"));
    dirs.push(dir);
    const file = join(dir, "ble-offline.json");
    saveBleOfflineConsent({ enabled: false, devices: [{ agentId: "ios-1" }] }, file);
    expect(loadBleOfflineConsent(file)).toEqual({ enabled: false, devices: [{ agentId: "ios-1", name: "EC-ios-1" }] });
  });
});

describe("the agent's side: nothing goes to a device that isn't allowed", () => {
  function transport() {
    const sent: Array<{ peerId: string; req: BLETaskRequest & { requesterProof?: string } }> = [];
    const peers: BLEPeerEntry[] = [phone, laptop].map((p) => ({ agentId: p.agentId, meshTokenHash: "", accountId: p.agentId, model: p.model, modelParamSize: p.modelParamSize, memoryMB: 0, batteryPct: 100, currentLoad: 0, deviceType: p.deviceType, rssi: p.rssi, lastSeenMs: Date.now() }));
    return {
      sent,
      discoveredPeers: () => peers,
      sendTaskRequest: async (peerId: string, req: BLETaskRequest): Promise<BLETaskResponse> => {
        sent.push({ peerId, req });
        return { requestId: req.requestId, providerId: peerId, status: "completed", output: "Futures are up.", cpuSeconds: 1, providerSignature: "" };
      },
    };
  }
  const consent = (): BleOfflineConsent => ({ enabled: true, devices: [{ agentId: phone.agentId, name: "Cody's iPhone" }] });

  it("refuses a device not on the list before sending anything; runs on an allowed one, signed, without a co-sign", async () => {
    const t = transport();
    const link = bleOfflineLink({ agentId: "mac-self", transport: t, meshToken: () => "mesh-secret", sign: () => "sig", consent });
    expect(await link.run(laptop.agentId, "hello")).toEqual({ ok: false, error: "not_allowed" });
    expect(t.sent).toEqual([]);
    const r = await link.run(phone.agentId, "hello");
    expect(r).toMatchObject({ ok: true, output: "Futures are up." });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].req).toMatchObject({ requesterId: "mac-self", task: "hello", requesterSignature: "sig" });
    expect(t.sent[0].req.requesterProof).toMatch(/^[0-9a-f]{64}$/);
    // The fake transport has no co-sign method: a co-sign attempt would have thrown.
    expect(link.nearby().map((p) => [p.agentId, p.allowed, p.name])).toEqual([[phone.agentId, true, "Cody's iPhone"], [laptop.agentId, false, "EC-mac-bbbb"]]);
  });

  it("turned off: nothing is allowed", async () => {
    const t = transport();
    const link = bleOfflineLink({ agentId: "mac-self", transport: t, meshToken: () => "", sign: () => "sig", consent: () => ({ ...consent(), enabled: false }) });
    expect(await link.run(phone.agentId, "hello")).toEqual({ ok: false, error: "not_allowed" });
    expect(t.sent).toEqual([]);
  });

  it("the forwarder serves /forward/ble while the agent isn't registered, and the app's link reads it", async () => {
    const t = transport();
    const ble = bleOfflineLink({ agentId: "mac-self", transport: t, meshToken: () => "", sign: () => "sig", consent });
    const forwarder: Server = createLocalForwarder({ token: () => "secret-token", coordinatorUrl: () => null, meshHeaders: () => ({}), signedHeaders: () => ({}), agentId: "mac-self", registrationWaitMs: 1, ble: () => ble });
    await new Promise<void>((r) => forwarder.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(forwarder.address() as AddressInfo).port}`;
    try {
      const link = forwarderBluetoothLink({ forwarder: url, token: () => "secret-token" });
      expect((await link.peers()).map((p) => p.agentId)).toEqual([phone.agentId]);
      expect(await link.run(phone.agentId, "hello")).toMatchObject({ output: "Futures are up." });
      await expect(link.run(laptop.agentId, "hello")).rejects.toThrow(/not_allowed/);
      const nearby = await request(`${url}/forward/ble/nearby`, { headers: { authorization: "Bearer secret-token" } });
      expect(((await nearby.body.json()) as { peers: unknown[] }).peers).toHaveLength(2);
      const noAuth = await request(`${url}/forward/ble/peers`);
      expect(noAuth.statusCode).toBe(401);
      await noAuth.body.dump();
    } finally {
      forwarder.close();
    }
  });
});
