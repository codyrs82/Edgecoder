import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/svelte";
import PermissionModePicker from "../src/components/PermissionModePicker.svelte";
import PlanApproval from "../src/components/PlanApproval.svelte";
import { chatMode, defaultMode, engineMode, setDefaultMode, uiMode } from "../src/lib/permission-modes";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

describe("PermissionModePicker", () => {
  it("shows the current mode on a small button", () => {
    render(PermissionModePicker, { mode: "auto-edits", onChange: vi.fn() });
    const button = screen.getByRole("button", { name: /Accept edits/ });
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("lists the four modes with descriptions, number keys and a check on the current one", async () => {
    render(PermissionModePicker, { mode: "ask", onChange: vi.fn() });
    await fireEvent.click(screen.getByRole("button", { name: /Manual/ }));
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.querySelector(".title")!.textContent)).toEqual(["Auto", "Manual", "Accept edits", "Plan"]);
    expect(options.map((o) => o.querySelector(".key")!.textContent)).toEqual(["1", "2", "3", "4"]);
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"]);
    expect(options[1].querySelector(".check svg")).toBeTruthy();
    expect(options[3].querySelector(".desc")!.textContent).toMatch(/plan first/i);
  });

  it.each([
    ["1", "auto"],
    ["2", "ask"],
    ["3", "auto-edits"],
    ["4", "plan"],
  ])("key %s picks %s and closes", async (key, engine) => {
    const onChange = vi.fn();
    render(PermissionModePicker, { mode: key === "2" ? "auto" : "ask", onChange });
    await fireEvent.click(screen.getByRole("button"));
    await fireEvent.keyDown(screen.getByRole("listbox"), { key });
    expect(onChange).toHaveBeenCalledWith(engine);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("arrows and Enter pick; Escape closes without a change", async () => {
    const onChange = vi.fn();
    render(PermissionModePicker, { mode: "auto", onChange });
    await fireEvent.click(screen.getByRole("button"));
    await fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button"));
    await fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    await fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    await fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("auto-edits");
  });

  it("clicking an option picks it", async () => {
    const onChange = vi.fn();
    render(PermissionModePicker, { mode: "ask", onChange });
    await fireEvent.click(screen.getByRole("button"));
    await fireEvent.click(screen.getAllByRole("option")[3]);
    expect(onChange).toHaveBeenCalledWith("plan");
  });
});

describe("mode persistence and mapping", () => {
  it("maps the picker's names to the engine", () => {
    expect(engineMode("manual")).toBe("ask");
    expect(engineMode("accept-edits")).toBe("auto-edits");
    expect(engineMode("auto")).toBe("auto");
    expect(engineMode("plan")).toBe("plan");
    expect(uiMode("auto-edits")).toBe("accept-edits");
    expect(uiMode("nonsense")).toBe("manual");
  });

  it("keeps the default for new chats (Settings → General), Accept edits until changed", () => {
    expect(defaultMode()).toBe("auto-edits");
    setDefaultMode("plan");
    expect(defaultMode()).toBe("plan");
  });

  it("a chat keeps its own mode; older chats fall back to the per-project switch, then the default", () => {
    setDefaultMode("auto");
    expect(chatMode("ask", true)).toBe("ask");
    expect(chatMode(undefined, true)).toBe("auto-edits");
    expect(chatMode(undefined, false)).toBe("ask");
    expect(chatMode(undefined, null)).toBe("auto");
  });
});

describe("PlanApproval", () => {
  it("approves into Accept edits by default, or the chosen mode; Revise asks for changes", async () => {
    const onApprove = vi.fn();
    const onRevise = vi.fn();
    render(PlanApproval, { onApprove, onRevise });
    await fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    expect(onApprove).toHaveBeenLastCalledWith("auto-edits");
    await fireEvent.change(screen.getByRole("combobox"), { target: { value: "auto" } });
    await fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));
    expect(onApprove).toHaveBeenLastCalledWith("auto");
    await fireEvent.click(screen.getByRole("button", { name: "Revise" }));
    expect(onRevise).toHaveBeenCalled();
  });
});
