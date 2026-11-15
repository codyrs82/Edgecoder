import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import Toaster from "../src/components/ui/Toaster.svelte";
import { notify } from "../src/lib/toast";

describe("toasts (#24)", () => {
  it("announces in a polite live region and lets errors be dismissed", async () => {
    render(Toaster);
    notify("Could not save the file", "error", "t1");

    const text = await screen.findByText("Could not save the file");
    expect(text.closest("[aria-live='polite']")).not.toBeNull();
    // Errors stay until dismissed, so they carry a named close button.
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("a toast with the same id replaces the earlier one", async () => {
    render(Toaster);
    notify("Settings saved", "success", "same");
    notify("Settings saved again", "success", "same");

    await screen.findByText("Settings saved again");
    await waitFor(() => expect(screen.queryByText("Settings saved")).toBeNull());
  });
});
