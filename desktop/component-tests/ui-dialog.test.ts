import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import Harness from "./fixtures/DialogHarness.svelte";

describe("ui/Dialog (#24)", () => {
  it("is a named modal dialog that takes focus and gives it back to the opener", async () => {
    render(Harness);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    await fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Example" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Second" }));

    await fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("Escape in a text field does not close it", async () => {
    render(Harness);
    await fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("dialog");
    await fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("a non-dismissible dialog ignores Escape", async () => {
    render(Harness, { dismissible: false });
    await fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await screen.findByRole("dialog");
    await fireEvent.keyDown(screen.getByRole("button", { name: "Second" }), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
