import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import UpdateCountdown from "../src/components/UpdateCountdown.svelte";
import { AutoRestart } from "../src/lib/auto-restart";

function controller() {
  const restart = vi.fn(async () => {});
  const ar = new AutoRestart({ autoUpdate: () => true, autoRestart: () => true, readyVersion: () => "1.4.2", checkBusy: async () => [], restart });
  return { ar, restart };
}

describe("UpdateCountdown", () => {
  it("shows nothing until a countdown starts", () => {
    const { ar } = controller();
    render(UpdateCountdown, { controller: ar });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the countdown with Restart now and Later", async () => {
    const { ar, restart } = controller();
    render(UpdateCountdown, { controller: ar });
    await ar.evaluate();
    expect(await screen.findByText("Updating to EdgeCoder 1.4.2 — restarting in 60 s")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    expect(restart).toHaveBeenCalled();
    ar.stop();
  });

  it("Later hides it", async () => {
    const { ar, restart } = controller();
    render(UpdateCountdown, { controller: ar });
    await ar.evaluate();
    await fireEvent.click(await screen.findByRole("button", { name: "Later" }));
    expect(screen.queryByText(/restarting in/)).toBeNull();
    expect(restart).not.toHaveBeenCalled();
    ar.stop();
  });
});
