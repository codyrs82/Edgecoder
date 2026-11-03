import { describe, expect, it } from "vitest";
import { installedChatModels, pullPercent, pullWithProgress, skipStarter, starterSkipped } from "../src/lib/starter-model";

const ndjson = (lines: object[]) =>
  new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(JSON.stringify(l) + "\n")); c.close(); } }));

describe("starter model", () => {
  it("counts chat models only, and null while Ollama isn't answering", async () => {
    const ok = (async () => new Response(JSON.stringify({ models: [{ name: "nomic-embed-text" }, { name: "qwen2.5-coder:1.5b" }] }))) as typeof fetch;
    expect(await installedChatModels("x", ok)).toEqual(["qwen2.5-coder:1.5b"]);
    const empty = (async () => new Response(JSON.stringify({ models: [{ name: "nomic-embed-text" }] }))) as typeof fetch;
    expect(await installedChatModels("x", empty)).toEqual([]);
    const down = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    expect(await installedChatModels("x", down)).toBeNull();
  });

  it("reports pull progress and finishes on success", async () => {
    const seen: Array<number | null> = [];
    const f = (async () => ndjson([{ status: "pulling manifest" }, { status: "pulling abc", total: 200, completed: 50 }, { status: "pulling abc", total: 200, completed: 200 }, { status: "success" }])) as typeof fetch;
    await pullWithProgress("x", "m", (p) => seen.push(p.percent), undefined, f);
    expect(seen).toEqual([null, 25, 100, null]);
    expect(pullPercent({ total: 0 })).toBeNull();
  });

  it("surfaces Ollama's error", async () => {
    const f = (async () => ndjson([{ error: "pull model manifest: file does not exist" }])) as typeof fetch;
    await expect(pullWithProgress("x", "m", () => {}, undefined, f)).rejects.toThrow(/file does not exist/);
  });

  it("remembers a skip", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(starterSkipped(store)).toBe(false);
    skipStarter(store);
    expect(starterSkipped(store)).toBe(true);
  });
});
