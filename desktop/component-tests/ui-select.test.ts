import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import Harness from "./fixtures/SelectHarness.svelte";

describe("ui/Select (#24)", () => {
  it("is a named combobox showing the current option", () => {
    render(Harness);
    const trigger = screen.getByRole("combobox", { name: "Theme" });
    expect(trigger.textContent).toContain("Light");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a listbox from the keyboard and picks with Enter", async () => {
    const onChange = vi.fn();
    render(Harness, { onChange });
    const trigger = screen.getByRole("combobox", { name: "Theme" });
    trigger.focus();
    await fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await screen.findByRole("listbox");
    expect(screen.getAllByRole("option").map((o) => o.textContent?.trim())).toEqual(["System", "Light", "Dark"]);
    expect(screen.getByRole("option", { name: "Light" }).getAttribute("aria-selected")).toBe("true");
    // Focus stays on the combobox; the highlighted option is its active descendant.
    await waitFor(() => expect(trigger.getAttribute("aria-activedescendant")).toBe(screen.getByRole("option", { name: "Light" }).id));
    await fireEvent.keyDown(trigger, { key: "ArrowDown" });
    await fireEvent.keyDown(trigger, { key: "Enter" });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("dark"));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("picks an option with the pointer", async () => {
    const onChange = vi.fn();
    render(Harness, { onChange });
    await fireEvent.click(screen.getByRole("combobox", { name: "Theme" }));
    const dark = await screen.findByRole("option", { name: "Dark" });
    await fireEvent.pointerUp(dark);
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("dark"));
    expect(screen.getByRole("status").textContent).toBe("dark");
  });
});
