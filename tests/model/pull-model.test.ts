import { afterEach, describe, expect, it, vi } from "vitest";
import { pullModel } from "../../src/model/swap.js";
import { PullTracker } from "../../src/model/pull-tracker.js";

// #119 review: pullModel itself, with a stubbed fetch (no Ollama).
function ndjson(lines: object[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(JSON.stringify(l) + "\n"));
      c.close();
    }
  });
}

function stubFetch(tags: string[], pull: { ok: boolean; lines?: object[] } | "throw") {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/api/tags")) return { ok: true, json: async () => ({ models: tags.map((name) => ({ name })) }) };
    if (pull === "throw") throw new Error("connect refused");
    return { ok: pull.ok, body: pull.ok ? ndjson(pull.lines ?? []) : null };
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("pullModel (#37)", () => {
  it("already installed: ready, tracker released", async () => {
    stubFetch(["llama3:8b"], { ok: true });
    const t = new PullTracker();
    t.tryStart("llama3:8b");
    expect(await pullModel("llama3:8b", t)).toEqual({ model: "llama3:8b", status: "ready" });
    expect(t.getProgress()).toBeNull();
  });

  it("streams progress and completes", async () => {
    stubFetch([], { ok: true, lines: [{ status: "downloading", completed: 5, total: 10 }, { status: "success" }] });
    const t = new PullTracker();
    t.tryStart("x:1");
    expect(await pullModel("x:1", t)).toEqual({ model: "x:1", status: "pulling" });
    await vi.waitFor(() => expect(t.getProgress()).toBeNull());
  });

  it("a streamed error line fails the tracker", async () => {
    stubFetch([], { ok: true, lines: [{ error: "manifest unknown" }] });
    const t = new PullTracker();
    t.tryStart("x:1");
    await pullModel("x:1", t);
    await vi.waitFor(() => expect(t.getProgress()).toMatchObject({ status: "error", error: "manifest unknown" }));
  });

  it("a rejected or unreachable pull is an error", async () => {
    stubFetch([], { ok: false });
    const t = new PullTracker();
    t.tryStart("x:1");
    expect(await pullModel("x:1", t)).toMatchObject({ status: "error" });
    expect(t.getProgress()).toMatchObject({ status: "error", error: "pull_request_failed" });
    stubFetch([], "throw");
    expect(await pullModel("x:1", t)).toMatchObject({ status: "error" });
  });
});
