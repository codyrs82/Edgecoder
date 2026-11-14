import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";

const api = vi.hoisted(() => ({ fsFind: vi.fn() }));
vi.mock("../src/lib/api", () => ({ fsFind: api.fsFind }));

import QuickOpen from "../src/components/QuickOpen.svelte";

const FILES = [
  { path: "src/lib/api.ts", kind: "file" },
  { path: "src/lib", kind: "dir" },
  { path: "src/App.svelte", kind: "file" },
];

describe("QuickOpen (#24 command palette)", () => {
  beforeEach(() => {
    api.fsFind.mockReset();
    api.fsFind.mockResolvedValue(FILES);
  });

  it("is a dialog with a combobox that lists matching files", async () => {
    render(QuickOpen, { onOpen: () => {}, onClose: () => {} });
    expect(screen.getByRole("dialog", { name: "Go to file" })).toBeTruthy();
    const input = screen.getByRole("combobox", { name: "File name" });
    await waitFor(() => expect(document.activeElement).toBe(input));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(screen.getByRole("listbox", { name: "Files" })).toBeTruthy();
    // The first result is the active one, announced through aria-activedescendant.
    const first = screen.getAllByRole("option")[0];
    await waitFor(() => expect(first.getAttribute("aria-selected")).toBe("true"));
    expect(input.getAttribute("aria-activedescendant")).toBe(first.id);
  });

  it("searches as you type; arrows move and Enter opens", async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(QuickOpen, { onOpen, onClose });
    const input = screen.getByRole("combobox", { name: "File name" });
    await fireEvent.input(input, { target: { value: "app" } });
    await waitFor(() => expect(api.fsFind).toHaveBeenLastCalledWith("app", 30));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("src/App.svelte");
    expect(onClose).toHaveBeenCalled();
  });

  it("clicking a result opens it", async () => {
    const onOpen = vi.fn();
    render(QuickOpen, { onOpen, onClose: () => {} });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    await fireEvent.click(screen.getAllByRole("option")[0]);
    expect(onOpen).toHaveBeenCalledWith("src/lib/api.ts");
  });

  it("Escape in the field closes the palette", async () => {
    const onClose = vi.fn();
    render(QuickOpen, { onOpen: () => {}, onClose });
    await fireEvent.keyDown(screen.getByRole("combobox", { name: "File name" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says when nothing matches", async () => {
    api.fsFind.mockResolvedValue([]);
    render(QuickOpen, { onOpen: () => {}, onClose: () => {} });
    expect(await screen.findByText("Type to search the project")).toBeTruthy();
  });
});
