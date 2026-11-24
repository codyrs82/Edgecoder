// Settings is a full-window dialog over the app's title bar, so it carries its own drag strips:
// on macOS (overlay title bar) the window drags from the top of Settings like from the chat screens.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/svelte";
import SettingsOverlay from "../src/components/SettingsOverlay.svelte";
import type { AuthUser } from "../src/lib/api";

const USER = { userId: "u1", email: "me@example.com", emailVerified: true } as unknown as AuthUser;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
  document.documentElement.dataset.titlebar = "overlay";
});
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.titlebar;
  vi.unstubAllGlobals();
});

describe("Settings title bar", () => {
  it("has a drag strip over the section list and one over the page, outside the accessibility tree", async () => {
    render(SettingsOverlay, { user: USER, onClose: () => {}, onLogout: () => {}, initialSection: "getting-started" });
    await screen.findByRole("dialog");
    const strips = document.querySelectorAll(".settings-titlebar[data-tauri-drag-region]");
    expect(strips).toHaveLength(2);
    strips.forEach((s) => {
      expect(s.getAttribute("aria-hidden")).toBe("true");
      // Empty, so nothing clickable sits inside a drag region.
      expect(s.children).toHaveLength(0);
    });
    // The side strip is above Back; the other heads the page column.
    const side = screen.getByTestId("settings-titlebar");
    expect(side.nextElementSibling?.textContent?.trim()).toBe("Back");
    expect(strips[1].nextElementSibling?.id).toBe("settings-panel");
  });
});
