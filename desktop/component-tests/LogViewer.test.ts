import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/svelte";

const api = vi.hoisted(() => ({
  getLogTail: vi.fn(),
  isRemoteMode: vi.fn(() => false),
  computeErrorText: (e: unknown) => (e as Error).message,
}));
vi.mock("../src/lib/api", () => ({ ...api, backendReady: Promise.resolve() }));

import LogViewer from "../src/pages/LogViewer.svelte";

const j = (o: Record<string, unknown>) => JSON.stringify(o);
const T = Date.UTC(2026, 10, 16, 9, 0, 0);
const LINES = [
  j({ level: 30, time: T, service: "ide-provider", requestId: "1", req: { method: "POST", url: "/v1/ide/chat" }, msg: "incoming request" }),
  j({ level: 30, time: T, service: "ide-provider", requestId: "1", res: { statusCode: 200 }, responseTime: 812, msg: "request completed" }),
  j({ level: 30, time: T, service: "inference", requestId: "2", req: { method: "GET", url: "/model/pull/progress" }, msg: "incoming request" }),
  j({ level: 30, time: T, service: "inference", requestId: "2", res: { statusCode: 200 }, responseTime: 0.3, msg: "request completed" }),
  j({ level: 30, time: T, service: "ide-provider", requestId: "3", req: { method: "GET", url: "/v1/ide/bots" }, msg: "incoming request" }),
  j({ level: 30, time: T, service: "ide-provider", requestId: "3", res: { statusCode: 200 }, responseTime: 0.3, msg: "request completed" }),
  `[agent:desktop-mac-1] offline probe failed (Error: POST /register failed (403): {"registrationToken":"rt_secret_123456"})`,
  j({ level: 40, time: T, service: "coordinator", msg: "slow peer", authorization: "Bearer abcdefghijklmnopqrstuvwxyz0123" }),
];
const tail = (lines: string[], extra: Record<string, unknown> = {}) => ({
  source: "agent", exists: true, size: 100, start: 0, next: 100, lines, truncated: false, reset: false,
  sources: [{ id: "agent", label: "Agent and services", exists: true, size: 100 }, { id: "ollama", label: "Ollama", exists: true, size: 10 }], ...extra,
});

beforeEach(() => {
  api.getLogTail.mockReset();
  api.isRemoteMode.mockReturnValue(false);
});
afterEach(() => cleanup());

describe("Logs", () => {
  it("reads the real log: time · service · level · message, a request as one line, credentials masked", async () => {
    api.getLogTail.mockResolvedValueOnce(tail(LINES)).mockResolvedValue(tail([]));
    render(LogViewer, { pollMs: 60_000 });
    await screen.findByText("POST /v1/ide/chat → 200 · 812 ms");
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Time", "Service", "Level", "Message"]);
    const plain = screen.getByText(/^offline probe failed/).closest("tr")!;
    expect(plain.className).toContain("plain");
    expect(plain.className).toContain("lvl-error");
    expect(table.textContent).not.toContain("rt_secret_123456");
    expect(table.textContent).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(api.getLogTail).toHaveBeenCalledWith("agent", undefined);
  });

  it("routine polling is hidden by default and shown with the toggle", async () => {
    api.getLogTail.mockResolvedValueOnce(tail(LINES)).mockResolvedValue(tail([]));
    render(LogViewer, { pollMs: 60_000 });
    await screen.findByText("POST /v1/ide/chat → 200 · 812 ms");
    const toggle = screen.getByRole("checkbox", { name: "Hide routine requests" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.queryByText(/\/model\/pull\/progress/)).toBeNull();
    expect(screen.getByText(/2 routine requests hidden/)).toBeTruthy();
    await fireEvent.click(toggle);
    expect(screen.getByText(/GET \/model\/pull\/progress → 200/)).toBeTruthy();
    expect(screen.getByText(/GET \/v1\/ide\/bots → 200/)).toBeTruthy();
  });

  it("filters by level, service and text", async () => {
    api.getLogTail.mockResolvedValueOnce(tail(LINES)).mockResolvedValue(tail([]));
    render(LogViewer, { pollMs: 60_000 });
    await screen.findByText("POST /v1/ide/chat → 200 · 812 ms");
    await fireEvent.click(screen.getByRole("checkbox", { name: "Info" }));
    expect(screen.queryByText("POST /v1/ide/chat → 200 · 812 ms")).toBeNull();
    expect(screen.getByText(/^offline probe failed/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("checkbox", { name: /^Errors/ }));
    expect(screen.queryByText(/^offline probe failed/)).toBeNull();
    expect(screen.getByText(/^slow peer/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("checkbox", { name: /^Errors/ }));
    await fireEvent.click(screen.getByRole("checkbox", { name: "Info" }));
    const svc = screen.getByLabelText("Service") as HTMLSelectElement;
    svc.value = "coordinator";
    await fireEvent.change(svc);
    expect(screen.getAllByRole("row")).toHaveLength(2);
    svc.value = "";
    await fireEvent.change(svc);
    await fireEvent.input(screen.getByRole("searchbox", { name: "Search the log" }), { target: { value: "probe" } });
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  it("follows the file: asks for what was appended after the last offset; Pause stops reading", async () => {
    vi.useFakeTimers();
    try {
      api.getLogTail.mockResolvedValueOnce(tail(LINES.slice(0, 2), { next: 100 })).mockResolvedValueOnce(tail(["[agent:x] registered with https://c"], { next: 140 })).mockResolvedValue(tail([], { next: 140 }));
      render(LogViewer, { pollMs: 2000 });
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(2000);
      expect(api.getLogTail).toHaveBeenLastCalledWith("agent", 100);
      expect(screen.getByText("registered with https://c")).toBeTruthy();
      await fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
      const n = api.getLogTail.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.getLogTail.mock.calls.length).toBe(n);
      expect(screen.getByRole("button", { name: /Follow/ }).getAttribute("aria-pressed")).toBe("true");
      await fireEvent.click(screen.getByRole("button", { name: /Follow/ }));
      await vi.advanceTimersByTimeAsync(10);
      expect(api.getLogTail).toHaveBeenLastCalledWith("agent", 140);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Copy for support: the relevant lines, redacted, on the clipboard", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    api.getLogTail.mockResolvedValueOnce(tail([...LINES, "[agent:x] signed in as owner@example.com"])).mockResolvedValue(tail([]));
    render(LogViewer, { pollMs: 60_000 });
    await screen.findByText("POST /v1/ide/chat → 200 · 812 ms");
    await fireEvent.click(screen.getByRole("button", { name: /Copy for support/ }));
    await screen.findByText(/Copied 4 lines/);
    const text = String((writeText.mock.calls as unknown[][])[0][0]);
    expect(text).toContain("ide-provider · INFO · POST /v1/ide/chat → 200 · 812 ms");
    expect(text).toContain("agent · ERROR · offline probe failed");
    expect(text).not.toContain("/model/pull/progress");
    expect(text).not.toContain("rt_secret_123456");
    expect(text).not.toContain("owner@example.com");
  });

  it("empty states: no file yet, an empty file", async () => {
    api.getLogTail.mockResolvedValue(tail([], { exists: false }));
    render(LogViewer, { pollMs: 60_000 });
    await screen.findByText("This log doesn't exist yet.");
    cleanup();
    api.getLogTail.mockResolvedValue(tail([]));
    render(LogViewer, { pollMs: 60_000 });
    await screen.findByText("The log is empty.");
  });
});
