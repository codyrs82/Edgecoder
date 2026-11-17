import { describe, expect, it, vi } from "vitest";
import { BLOCKED_SAVE_TEXT, LocalServiceUnreachableError, UNREACHABLE_SAVE_TEXT, fetchLocalService, serviceErrorText } from "../src/lib/local-service";
import { COMPUTE_POLICY_OPTIONS, computeChoiceOf, computeFromChoice, computeText, networkModelId } from "../src/lib/bots";

const loadFailed = () => new TypeError("Load failed");

describe("saving a bot: what the error says", () => {
  it("a 4xx or 5xx shows the server's own message, never 'couldn't reach'", () => {
    expect(serviceErrorText(400, { error: "compute.computeClass: Invalid enum value" })).toBe("compute.computeClass: Invalid enum value");
    expect(serviceErrorText(404, { error: "Bot not found" })).toBe("Bot not found");
    // Fastify's own replies: the message, not the reason phrase.
    expect(serviceErrorText(404, { error: "Not Found", message: "Route PATCH:/v1/ide/bots/x not found", statusCode: 404 } as never)).toBe("Route PATCH:/v1/ide/bots/x not found");
    // A code next to a message (the fs routes): the message.
    expect(serviceErrorText(409, { error: "conflict", message: "The file changed on disk." })).toBe("The file changed on disk.");
    expect(serviceErrorText(500, { error: "Internal Server Error", message: "boom" })).toBe("EdgeCoder's local service hit an error (500): boom");
    expect(serviceErrorText(502)).toBe("EdgeCoder's local service hit an error (502): It answered 502.");
    for (const s of [400, 404, 500]) expect(serviceErrorText(s, { error: "x y" })).not.toMatch(/couldn't reach/i);
  });

  it("the save that failed for Harry: the request is blocked (CORS) while /health answers, so say so at once instead of retrying 'restarting…' and 'couldn't reach'", async () => {
    const send = vi.fn(async () => {
      throw loadFailed();
    });
    const sleep = vi.fn(async () => undefined);
    const save = fetchLocalService(send, { method: "PATCH", sleep, probe: async () => true });
    await expect(save).rejects.toBeInstanceOf(LocalServiceUnreachableError);
    await expect(fetchLocalService(send, { method: "PATCH", sleep, probe: async () => true })).rejects.toThrow(BLOCKED_SAVE_TEXT);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("'couldn't reach' only when nothing answers", async () => {
    const send = vi.fn(async () => {
      throw loadFailed();
    });
    await expect(fetchLocalService(send, { method: "PATCH", sleep: async () => undefined, probe: async () => false })).rejects.toThrow(UNREACHABLE_SAVE_TEXT);
    await expect(fetchLocalService(send, { method: "PATCH", sleep: async () => undefined, probe: async () => Promise.reject(new TypeError("Load failed")) })).rejects.toThrow(UNREACHABLE_SAVE_TEXT);
  });
});

describe("Network only compute choices", () => {
  it("lists Network only and one card per class, each with a one-line description", () => {
    const values = COMPUTE_POLICY_OPTIONS.map((o) => o.value);
    expect(values).toEqual(["auto", "local_first", "local_only", "mine_only", "network_only", "network_only:gpu", "network_only:apple", "network_only:cpu", "network_only:gpu.dc", "model"]);
    for (const o of COMPUTE_POLICY_OPTIONS) {
      expect(o.desc.length).toBeGreaterThan(10);
      expect(o.desc).not.toContain("\n");
    }
    expect(COMPUTE_POLICY_OPTIONS.find((o) => o.value === "network_only:gpu")!.title).toBe("Network GPU only");
  });

  it("maps cards to the saved compute and back", () => {
    expect(computeFromChoice("network_only")).toEqual({ policy: "network_only" });
    expect(computeFromChoice("network_only:gpu.dc")).toEqual({ policy: "network_only", computeClass: "gpu.dc" });
    expect(computeFromChoice("network_only:apple", "mine/qwen3-coder:30b")).toEqual({ policy: "network_only", computeClass: "apple", model: "network/qwen3-coder:30b" });
    expect(computeFromChoice("model", "network/qwen3-coder:30b")).toEqual({ policy: "model", model: "network/qwen3-coder:30b" });
    expect(computeFromChoice("local_first", "x")).toEqual({ policy: "local_first" });
    expect(computeChoiceOf({ policy: "network_only", computeClass: "cpu" })).toBe("network_only:cpu");
    expect(computeChoiceOf({ policy: "mine_only" })).toBe("mine_only");
  });

  it("turns any picker id into a network model id", () => {
    expect(networkModelId("qwen3-coder:30b")).toBe("network/qwen3-coder:30b");
    expect(networkModelId("network/qwen3-coder:30b@gpu")).toBe("network/qwen3-coder:30b");
    expect(networkModelId("reserved/r1/qwen3-coder:30b")).toBe("network/qwen3-coder:30b");
    expect(networkModelId("auto")).toBeUndefined();
    expect(networkModelId("frontier/anthropic/x")).toBeUndefined();
  });

  it("header text", () => {
    expect(computeText({ policy: "network_only" })).toBe("Network only");
    expect(computeText({ policy: "network_only", computeClass: "gpu", model: "network/qwen3-coder:30b" })).toBe("Network GPU only · qwen3-coder:30b");
  });
});
