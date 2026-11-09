import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/svelte";

const shell = vi.hoisted(() => ({ open: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-shell", () => shell);

import MarkdownRenderer from "../src/components/MarkdownRenderer.svelte";

afterEach(cleanup);

describe("MarkdownRenderer with model output", () => {
  it("puts no raw HTML from the message into the DOM", () => {
    const { container } = render(MarkdownRenderer, {
      source: '<style>*{display:none}</style>\n\n<form action="https://a.example"><button>Go</button></form>\n\n<iframe src="http://127.0.0.1:4306/"></iframe> <meta http-equiv="refresh" content="0;url=https://a.example">',
    });
    for (const sel of ["style", "form", "iframe", "meta"]) expect(container.querySelector(sel), sel).toBeNull();
    expect(container.textContent).toContain("<style>");
  });

  it("opens a link in the system browser instead of navigating the app", async () => {
    const { container } = render(MarkdownRenderer, { source: "[docs](https://example.com/docs) [bad](javascript:alert(1))" });
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    links[0].dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(shell.open).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("escapes a code fence language", async () => {
    const onOpenInEditor = vi.fn();
    const { container } = render(MarkdownRenderer, { source: '```ts" onclick="x\nconst a = 1;\n```', onOpenInEditor });
    const btn = container.querySelector(".open-in-editor-btn") as HTMLElement;
    expect(btn.getAttribute("onclick")).toBeNull();
    await fireEvent.click(btn);
    expect(onOpenInEditor).toHaveBeenCalledWith("const a = 1;", "ts");
  });
});
