import { describe, expect, it } from "vitest";
import { routeLabel, type RouteInputs, type Route } from "../../src/inference-api/auto-route.js";
import { NETWORK_FAILOVER_WHY, autoBackend } from "../../src/inference-api/backends.js";
import {
  BLUETOOTH_FAILOVER_WHY,
  bluetoothCandidates,
  bluetoothPrompt,
  overBluetooth,
  type BluetoothLink,
  type BluetoothPeer,
} from "../../src/inference-api/bluetooth-failover.js";
import { NetworkInferenceError } from "../../src/apps/ide/network-inference.js";
import { ChatBackendError, type ChatBackend, type ChatPiece } from "../../src/inference-api/types.js";
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

