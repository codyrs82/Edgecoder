import { afterEach, describe, expect, it, vi } from "vitest";
import { EndpointUnreachableError, fetchEndpoint, onEndpointUnreachable, testEndpoint } from "../src/lib/endpoints";

// #35: remote calls fail fast instead of hanging.
describe("fetchEndpoint timeout (#35)", () => {
  afterEach(() => vi.useRealTimers());

  it("a fetch that never resolves becomes EndpointUnreachableError within the timeout", async () => {
    vi.useFakeTimers();
    const never = vi.fn(() => new Promise<Response>(() => {}));
    const seen: EndpointUnreachableError[] = [];
    const off = onEndpointUnreachable((e) => seen.push(e));
    const p = fetchEndpoint("coordinator", "https://down.example", "/status", {}, { timeoutMs: 8000, fetchImpl: never as unknown as typeof fetch });
    const assertion = expect(p).rejects.toMatchObject({ name: "EndpointUnreachableError", kind: "coordinator", url: "https://down.example" });
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
    expect(seen).toHaveLength(1);
    expect(seen[0].message).toBe("Coordinator unreachable at https://down.example");
    off();
  });

  it("a network error becomes EndpointUnreachableError", async () => {
    const boom = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(fetchEndpoint("portal", "https://p.example", "/me", {}, { fetchImpl: boom as unknown as typeof fetch })).rejects.toBeInstanceOf(
      EndpointUnreachableError
    );
  });

  it("a caller abort is re-thrown unchanged (not reported as unreachable)", async () => {
    const ctrl = new AbortController();
    const hang = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))
    );
    const p = fetchEndpoint("portal", "https://p.example", "/x", { signal: ctrl.signal }, { fetchImpl: hang as unknown as typeof fetch });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("testEndpoint hits /health/runtime for the coordinator", async () => {
    const ok = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await testEndpoint("coordinator", "https://c.example", ok as unknown as typeof fetch)).toBe(true);
    expect(ok.mock.calls[0][0]).toBe("https://c.example/health/runtime");
    expect(await testEndpoint("portal", "http://evil.example", ok as unknown as typeof fetch)).toBe(false);
  });
});
