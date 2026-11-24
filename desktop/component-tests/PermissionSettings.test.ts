import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/svelte";

vi.mock("../src/lib/api", () => ({
  listPermissions: vi.fn(async () => ({})),
  removePermission: vi.fn(async () => undefined),
}));

import PermissionSettings from "../src/components/PermissionSettings.svelte";
import { defaultMode } from "../src/lib/permission-modes";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

async function choose(label: string) {
  await fireEvent.click(screen.getByRole("combobox", { name: "Default permission mode" }));
  await fireEvent.pointerUp(await screen.findByRole("option", { name: label }));
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

describe("Settings → default permission mode", () => {
  it("offers Full access as the default only after its confirm", async () => {
    render(PermissionSettings);
    await choose("Full access");
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toMatch(/runs commands, edits, installs and pushes without asking/);
    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(defaultMode()).toBe("auto-edits");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("combobox", { name: "Default permission mode" }).textContent).toContain("Accept edits");

    await choose("Full access");
    await fireEvent.click(await screen.findByRole("button", { name: "Make it the default" }));
    expect(defaultMode()).toBe("full");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Confirmed once: switching away and back doesn't ask again.
    await choose("Manual");
    expect(defaultMode()).toBe("ask");
    await choose("Full access");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(defaultMode()).toBe("full");
  });
});
