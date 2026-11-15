import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "ide-token-123") }));

describe("workspace trust API", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reads and sets folder trust on the local IDE server with the bearer token", async () => {
    vi.stubEnv("DEV", false);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes("/v1/ide/")) calls.push({ url, init });
      const body = init.body ? JSON.parse(String(init.body)) : {};
      return new Response(JSON.stringify({ projectRoot: "/p", trusted: body.trusted ?? false }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const { ideProjectTrust, ideSetProjectTrust } = await import("../src/lib/api");
    expect(await ideProjectTrust()).toEqual({ projectRoot: "/p", trusted: false });
    expect(await ideSetProjectTrust(true)).toEqual({ projectRoot: "/p", trusted: true });
    expect(calls.map((c) => [c.init?.method ?? "GET", c.url])).toEqual([
      ["GET", "http://127.0.0.1:4304/v1/ide/project/trust"],
      ["POST", "http://127.0.0.1:4304/v1/ide/project/trust"],
    ]);
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ trusted: true });
    for (const c of calls) expect(new Headers(c.init.headers).get("authorization")).toBe("Bearer ide-token-123");
  });
});
