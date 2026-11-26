import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUALITY_FLOOR, classFamily, classOnline, classUnavailableMessage, noRouteMessage, notEnoughCSatsMessage, planRoutes, routeInputsFrom, sizeWorkload, type RouteInputs,
} from "../../src/inference-api/auto-route.js";
import { autoBackend } from "../../src/inference-api/backends.js";
import { noRouteInfo } from "../../src/apps/ide/network-inference.js";
import { ChatBackendError, type ChatBackend } from "../../src/inference-api/types.js";

/*
 * "Network <class> only" against what the network has: GPU means any GPU (consumer or datacenter),
 * a class with no machine says so and what is there instead, and a run that can't be paid for says
 * "Not enough cSats" with the balance, the budget left and what the step needs.
 */

const heavy = sizeWorkload({ messages: [{ role: "user", content: "fix the bug" }], tools: [{ type: "function", function: { name: "edit_file" } }] }, DEFAULT_QUALITY_FLOOR);
const price = { input: 100, output: 400 };
/** The network on the day of the report: one A100 (gpu.dc), two Macs, nine CPU machines, no consumer GPU. */
const today: RouteInputs = {
  localModels: [],
  myModels: [],
  leases: [],
  networkModels: [
    { model: "qwen3-coder:30b", classes: ["gpu.dc", "apple", "cpu"], cSatsPerMTokens: price },
    { model: "qwen2.5-coder:7b", classes: ["cpu"], cSatsPerMTokens: price },
  ],
  classPrice: { cpu: 0.009, apple: 0.052, gpu: 0.043, "gpu.dc": 0.304 },
  balanceCSats: 500,
  classAgents: { cpu: 9, apple: 2, gpu: 0, "gpu.dc": 1 },
};

describe("the GPU family", () => {
  it("GPU is consumer and datacenter GPUs; every other class is itself", () => {
    expect(classFamily("gpu")).toEqual(["gpu", "gpu.dc"]);
    expect(classFamily("gpu.dc")).toEqual(["gpu.dc"]);
    expect(classFamily("apple")).toEqual(["apple"]);
  });

  it("Network GPU only runs on the A100 when it is the only GPU online", () => {
    const rs = planRoutes(heavy, today, "network_only", { allowanceCSats: 100, computeClass: "gpu" });
    expect(rs.map((r) => r.computeClass)).toEqual(["gpu.dc"]);
    expect(classOnline(today, "gpu")).toBe(true);
    expect(classOnline(today, "gpu.dc")).toBe(true);
  });

  it("the coordinator's machine counts come through the compute overview", () => {
    const inp = routeInputsFrom({ localModels: [], classes: { cpu: { cSatsPerSecondBaseTier: 1, agents: 9 }, gpu: { cSatsPerSecondBaseTier: 4, agents: 0 } } });
    expect(inp.classAgents).toEqual({ cpu: 9, gpu: 0 });
    // Your own machines don't count: the network leg never runs on them.
    const own = routeInputsFrom({ localModels: [], machines: [{ agentId: "mine", online: true, models: ["qwen3-coder:30b"], computeClass: "gpu" }, { agentId: "off", online: false, models: ["x"], computeClass: "cpu" }], classes: { cpu: { cSatsPerSecondBaseTier: 1, agents: 9 }, gpu: { cSatsPerSecondBaseTier: 4, agents: 1 } } });
    expect(own.classAgents).toEqual({ cpu: 9, gpu: 0 });
    // An older coordinator: no counts.
    expect(routeInputsFrom({ localModels: [], classes: { cpu: { cSatsPerSecondBaseTier: 1 } } }).classAgents).toBeUndefined();
  });
});

describe("a class with no machine", () => {
  const noGpu: RouteInputs = { ...today, networkModels: today.networkModels.map((m) => ({ ...m, classes: m.classes.filter((c) => c !== "gpu.dc") })), classAgents: { ...today.classAgents, "gpu.dc": 0 } };

  it("says which class and what is online instead", () => {
    expect(classOnline(noGpu, "gpu")).toBe(false);
    expect(classUnavailableMessage("gpu", noGpu)).toBe("No GPU machines online. Available now: Apple (2), CPU (9). Choose another compute option, or try again when one is back.");
    expect(classUnavailableMessage("gpu.dc", noGpu)).toMatch(/^No Datacenter GPU machines online\. Available now: Apple \(2\), CPU \(9\)\./);
    // With a model chosen: machines serving that model.
    expect(classUnavailableMessage("apple", today, "qwen2.5-coder:7b")).toMatch(/^No Apple machines online with qwen2\.5-coder:7b\. Available now: CPU\./);
    expect(noRouteMessage("network_only", noGpu, { computeClass: "gpu", allowanceCSats: 100 }, heavy)).toMatch(/^No GPU machines online\./);
  });

  it("the coordinator's 'no machine' (reason none) becomes that message, not 'No model on the network fits'", async () => {
    const b = autoBackend({
      inputs: async () => noGpu,
      policy: "network_only",
      plan: () => ({ allowanceCSats: 100, computeClass: "gpu" }),
      run: () => async function* () { throw new ChatBackendError("never", 502); },
      networkBestFit: () =>
        async function* () {
          throw new ChatBackendError("No model on the network fits this request: no agent with a model is online.", 404, undefined, noRouteInfo({ detail: "no agent with a model is online" }));
        },
    });
    const err = await drain(b).catch((e) => e as ChatBackendError);
    expect(err.message).toMatch(/^No GPU machines online\. Available now: Apple \(2\), CPU \(9\)\./);
    expect(err.info).toMatchObject({ code: "class_unavailable", computeClass: "gpu" });
  });

  it("unknown availability (not connected) is not called empty", () => {
    expect(classOnline({ ...today, networkModels: [], classAgents: undefined, balanceCSats: undefined }, "gpu")).toBeUndefined();
  });
});

describe("not enough cSats", () => {
  it("says the balance, the bot's budget left and about what the step needs", () => {
    const msg = notEnoughCSatsMessage({ ...today, balanceCSats: 0.01 }, { allowanceCSats: 6, budgetOwner: "Harry" }, { cSats: 0.4, computeClass: "gpu.dc" });
    expect(msg).toBe("Not enough cSats: your balance is 0.01 cSats (Harry's budget has 6 left today). This step needs about 0.4 cSats on a Datacenter GPU.");
  });

  it("the coordinator's price ceiling (reason price) is a money message, with its estimate", async () => {
    const b = autoBackend({
      inputs: async () => ({ ...today, balanceCSats: 0.01 }),
      policy: "network_only",
      plan: () => ({ allowanceCSats: 6, budgetOwner: "Harry", computeClass: "gpu.dc" }),
      run: () => async function* () { throw new ChatBackendError("never", 502); },
      networkBestFit: () =>
        async function* () {
          throw new ChatBackendError("No model on the network fits this request: every fitting model costs more than the 0.012 cSats ceiling.", 404, undefined, noRouteInfo({ detail: "every fitting model costs more than the 0.012 cSats ceiling", neededCSats: 0.37 }));
        },
    });
    const err = await drain(b).catch((e) => e as ChatBackendError);
    expect(err.message).toBe("Not enough cSats: your balance is 0.01 cSats (Harry's budget has 6 left today). This step needs about 0.37 cSats on a Datacenter GPU.");
    expect(err.status).toBe(402);
    expect(err.info).toMatchObject({ code: "not_enough_csats", neededCSats: 0.37 });
  });

  it("chat Auto with only the network: the same message, plus that nothing free can take it", async () => {
    const b = autoBackend({
      inputs: async () => ({ ...today, balanceCSats: 0.01 }),
      policy: "auto",
      run: () => async function* () { throw new ChatBackendError("Not enough cSats for this request (it sets aside up to 2 cSats; unused cSats come back).", 402, undefined, { code: "insufficient_credits", neededCSats: 2 }); },
    });
    const err = await drain(b).catch((e) => e as ChatBackendError);
    expect(err.message).toMatch(/^Not enough cSats: your balance is 0\.01 cSats\. This step needs about [0-9.]+ cSats on the network\. No model on this computer or your machines can take it instead/);
  });

  it("chat Auto that a network call failed for money: the same message", async () => {
    const b = autoBackend({
      inputs: async () => ({ ...today, balanceCSats: 50 }),
      policy: "auto",
      run: () => async function* () { throw new ChatBackendError("Not enough cSats for this request (it sets aside up to 2 cSats; unused cSats come back).", 402, undefined, { code: "insufficient_credits", neededCSats: 60 }); },
    });
    const err = await drain(b).catch((e) => e as ChatBackendError);
    expect(err.message).toMatch(/^Not enough cSats: your balance is 50 cSats\. This step needs about 60 cSats on the network\. No model on this computer/);
  });

  it("a named model refused for its reserve: what it sets aside and what it is expected to cost", async () => {
    const b = autoBackend({
      inputs: async () => ({ ...today, balanceCSats: 50 }),
      policy: "network_only",
      run: () => async function* () { throw new ChatBackendError("Not enough cSats for this request (it sets aside up to 88 cSats; expected cost about 9 cSats; unused cSats come back).", 402, undefined, { code: "insufficient_credits", neededCSats: 88, expectedCSats: 9.2 }); },
    });
    const err = await drain(b).catch((e) => e as ChatBackendError);
    expect(err.message).toBe("Not enough cSats: your balance is 50 cSats. This step sets aside up to 88 cSats on the network; expected cost about 9.2 cSats; unused cSats come back.");
    expect(err.status).toBe(402);
    expect(err.info).toMatchObject({ code: "not_enough_csats", neededCSats: 88, expectedCSats: 9.2 });
  });

  it("older coordinators: the reason is read from the detail text", () => {
    expect(noRouteInfo({ detail: "every fitting model costs more than the 0.012 cSats ceiling" })).toEqual({ code: "no_route_fits", reason: "price" });
    expect(noRouteInfo({ detail: "no agent with a model is online" })).toEqual({ code: "no_route_fits", reason: "none" });
    expect(noRouteInfo({ detail: "x", reason: "price", neededCSats: 1.5, computeClass: "gpu" })).toEqual({ code: "no_route_fits", reason: "price", neededCSats: 1.5, computeClass: "gpu" });
  });

  it("capacity problems keep their own words", () => {
    // Plenty of cSats, but no machine with a model at all for this step: not a money message.
    const msg = noRouteMessage("network_only", { ...today, networkModels: [{ model: "nomic-embed-text", classes: ["cpu"] }] }, { computeClass: "cpu", allowanceCSats: 100 }, heavy);
    expect(msg).not.toMatch(/cSats/);
  });
});

async function drain(b: ChatBackend) {
  for await (const _ of b({ messages: [{ role: "user", content: "fix the bug" }], tools: [{ type: "function", function: { name: "edit_file" } }] })) {
    // drain
  }
}
