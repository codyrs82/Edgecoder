import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import { tick } from "svelte";

const api = vi.hoisted(() => ({
  getHealth: vi.fn(),
  getStatus: vi.fn(),
  isRemoteMode: vi.fn(() => false),
}));
vi.mock("../src/lib/api", () => ({ ...api, backendReady: Promise.resolve() }));

import LogViewer from "../src/pages/LogViewer.svelte";

let results = 0;
/** jsdom has no layout, so give the log container a real scrollTop to observe. */
function trackScroll(el: HTMLElement) {
  let v = 0;
  Object.defineProperty(el, "scrollTop", { configurable: true, get: () => v, set: (n: number) => { v = n; } });
}
async function nextPoll() {
  results++;
  await vi.advanceTimersByTimeAsync(5000);
  await tick();
}

beforeEach(() => {
  vi.useFakeTimers();
  results = 0;
  api.getHealth.mockResolvedValue({ ollama: { reachable: true } });
  api.getStatus.mockImplementation(async () => ({ agents: 1, queued: 0, results }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("LogViewer", () => {
  it("is a focusable log region", async () => {
    render(LogViewer);
    const log = screen.getByRole("log", { name: /activity log/i });
    expect(log.getAttribute("tabindex")).toBe("0");
    log.focus();
    expect(document.activeElement).toBe(log);
  });

  it("auto-scroll on: new entries jump back to the newest (top)", async () => {
    render(LogViewer);
    const log = screen.getByRole("log");
    trackScroll(log);
    const toggle = screen.getByRole("checkbox", { name: /auto-scroll/i }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    log.scrollTop = 220;
    await fireEvent.scroll(log);
    await nextPoll();
    expect(log.scrollTop).toBe(0);
  });

  it("auto-scroll off: the rows being read stay put as entries are prepended", async () => {
    render(LogViewer);
    const log = screen.getByRole("log");
    trackScroll(log);
    const toggle = screen.getByRole("checkbox", { name: /auto-scroll/i }) as HTMLInputElement;
    await fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    log.scrollTop = 220;
    await fireEvent.scroll(log);
    const before = screen.getByText(/entries \(/).textContent;
    await nextPoll();
    expect(screen.getByText(/entries \(/).textContent).not.toBe(before);
    // Each prepended row (22px) is compensated so the view does not move.
    expect(log.scrollTop).toBeGreaterThan(220);
    expect((log.scrollTop - 220) % 22).toBe(0);
  });

  it("turning auto-scroll back on resumes following", async () => {
    render(LogViewer);
    const log = screen.getByRole("log");
    trackScroll(log);
    const toggle = screen.getByRole("checkbox", { name: /auto-scroll/i });
    await fireEvent.click(toggle);
    log.scrollTop = 220;
    await fireEvent.click(toggle);
    await nextPoll();
    expect(log.scrollTop).toBe(0);
  });
});
