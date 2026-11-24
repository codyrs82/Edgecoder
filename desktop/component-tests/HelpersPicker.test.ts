// The Code view's Helpers switch (docs/tentacles.md): on/off, how many at once, the chat's budget.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/svelte";
import HelpersPicker from "../src/components/HelpersPicker.svelte";

afterEach(cleanup);

describe("HelpersPicker", () => {
  it("shows whether helpers are on, how many run at once and the budget", () => {
    render(HelpersPicker, { helpers: { enabled: true, maxParallel: 4, budgetCSats: 100 }, onChange: vi.fn() });
    expect(screen.getByRole("button", { name: /Helpers · 4 · 100 cSats/ }).getAttribute("aria-expanded")).toBe("false");
  });

  it("turns helpers on and off from the switch", async () => {
    const onChange = vi.fn();
    render(HelpersPicker, { helpers: { enabled: false, maxParallel: 4, budgetCSats: 100 }, onChange });
    await fireEvent.click(screen.getByRole("button", { name: /Helpers off/ }));
    const sw = screen.getByRole("switch", { name: "Helpers" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    await fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith({ enabled: true });
  });

  it("sets how many run at once and the chat's budget, within limits", async () => {
    const onChange = vi.fn();
    render(HelpersPicker, { helpers: { enabled: true, maxParallel: 4, budgetCSats: 100 }, onChange });
    await fireEvent.click(screen.getByRole("button", { name: /Helpers ·/ }));
    await fireEvent.change(screen.getByLabelText("Helpers at once"), { target: { value: "40" } });
    expect(onChange).toHaveBeenCalledWith({ maxParallel: 16 });
    await fireEvent.change(screen.getByLabelText("Helper budget in cSats"), { target: { value: "250" } });
    expect(onChange).toHaveBeenCalledWith({ budgetCSats: 250 });
  });

  it("closes on Escape", async () => {
    render(HelpersPicker, { helpers: { enabled: true, maxParallel: 4, budgetCSats: 100 }, onChange: vi.fn() });
    await fireEvent.click(screen.getByRole("button", { name: /Helpers ·/ }));
    await fireEvent.keyDown(screen.getByRole("dialog", { name: "Helpers" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
