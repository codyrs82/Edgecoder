import { describe, expect, it } from "vitest";
import type { RouteInputs } from "../../src/inference-api/auto-route.js";
import { NETWORK_FAILOVER_WHY, autoBackend, networkUnreachableError } from "../../src/inference-api/backends.js";
import { NetworkInferenceError } from "../../src/apps/ide/network-inference.js";
import { ChatBackendError, type ChatBackend, type ChatPiece } from "../../src/inference-api/types.js";

/*
 * Network only is a preference: when the network can't be reached right now (this computer's agent
 * not connected, a coordinator restarting, every machine busy), the call runs on this computer's own
 * model instead and says so; money problems still stop it; the next call tries the network first.
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
const req = { model: "auto", messages: [{ role: "user" as const, content: "What moved the market today?" }] };
async function collect(b: ChatBackend): Promise<ChatPiece[]> {
  const out: ChatPiece[] = [];
  for await (const p of b(req as never)) out.push(p);
  return out;
}
const NOT_CONNECTED = new NetworkInferenceError("This computer's agent isn't connected to the network right now (it is starting or reconnecting). Nothing was charged; try again shortly.", 502);

function backend(network: () => AsyncGenerator<ChatPiece>, opts: { localModels?: string[]; routes?: string[] } = {}) {
  const tried: string[] = opts.routes ?? [];
  const b = autoBackend({
    inputs: async () => ({ ...inputs, ...(opts.localModels ? { localModels: opts.localModels } : {}) }),
    policy: "network_only",
    plan: () => ({ allowanceCSats: 50 }),
    run: (r) =>
      r.placement === "local"
        ? async function* () {
            tried.push(`local:${r.model}`);
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
  });
  return { b, tried };
}

describe("Network only fails over to this computer while the network is out of reach", () => {
  it("this computer's agent not connected: runs on the local model and says so", async () => {
    const { b, tried } = backend(async function* () {
      throw NOT_CONNECTED;
    });
    const out = await collect(b);
    expect(tried).toEqual(["bestfit", "network:qwen3-coder:30b", "local:qwen2.5-coder:14b"]);
    expect(out[0]).toEqual({ delta: "Futures are up." });
    expect(String((out[1] as { where?: string }).where)).toContain(NETWORK_FAILOVER_WHY);
  });

  it("a coordinator restarting, or every machine busy: the same", async () => {
    for (const e of [new ChatBackendError("The coordinator is restarting for an update. Nothing was charged; try again in a few seconds.", 503), new NetworkInferenceError("Every machine that runs auto is busy and none could start this request in time. Nothing was charged; try again in 15 s.", 503, 15)]) {
      const { b, tried } = backend(async function* () {
        throw e;
      });
      await collect(b);
      expect(tried.at(-1)).toBe("local:qwen2.5-coder:14b");
    }
  });

  it("the network back: the next call goes to the network again", async () => {
    let up = false;
    const { b, tried } = backend(async function* () {
      if (!up) throw NOT_CONNECTED;
      yield { delta: "from the network" };
      yield { done: true, cSatsSpent: 1, where: "routed to qwen3-coder:30b on gpu" };
    });
    await collect(b);
    up = true;
    const out = await collect(b);
    expect(tried.at(-1)).toBe("bestfit");
    expect(out[0]).toEqual({ delta: "from the network" });
  });

  it("no local model: the network's error stands (the bot waits and retries)", async () => {
    const { b } = backend(
      async function* () {
        throw NOT_CONNECTED;
      },
      { localModels: [] },
    );
    await expect(collect(b)).rejects.toThrow(/isn't connected to the network/);
  });

  it("money or a real refusal never fails over", async () => {
    const { b, tried } = backend(async function* () {
      throw new ChatBackendError("Not enough cSats for this request.", 402);
    });
    await expect(collect(b)).rejects.toThrow(/Not enough cSats/);
    expect(tried.some((t) => t.startsWith("local:"))).toBe(false);
    expect(networkUnreachableError(new ChatBackendError("No machine on the network has x right now.", 404))).toBe(false);
    expect(networkUnreachableError(NOT_CONNECTED)).toBe(true);
  });
});
