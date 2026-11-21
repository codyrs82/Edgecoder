import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { CHAT_SHARING_SCRIPT } from "../../src/portal/pages/settings.js";

type Reply = { ok: boolean; status: number; json: any };

/** Just the two elements the script touches, with a change listener we can fire. */
class El {
  checked = false;
  disabled = true;
  textContent = "";
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<() => unknown>> = {};
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  removeAttribute(k: string) { delete this.attrs[k]; }
  addEventListener(type: string, fn: () => unknown) { (this.listeners[type] ??= []).push(fn); }
  fire(type: string) { return Promise.all((this.listeners[type] ?? []).map((fn) => fn())); }
}

/** Runs the page script with call() answering from `replies` in order (an Error rejects, like fetch offline). */
function runScript(replies: Array<Reply | Error | Promise<Reply>>) {
  const box = new El();
  const status = new El();
  status.textContent = "Loading…";
  const calls: Array<{ path: string; options?: { method?: string; body?: string } }> = [];
  const toasts: Array<{ msg: string; error: boolean }> = [];
  const document = { getElementById: (id: string) => (id === "chatShareToggle" ? box : id === "chatShareStatus" ? status : null) };
  const call = async (path: string, options?: { method?: string; body?: string }) => {
    calls.push({ path, options });
    const r = replies.shift();
    if (!r) throw new Error("unexpected call " + path);
    if (r instanceof Error) throw r;
    return r;
  };
  const showToast = (msg: string, error = false) => void toasts.push({ msg, error });
  new Function("document", "call", "showToast", CHAT_SHARING_SCRIPT)(document, call, showToast);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  /** Flip the box as a click or Space would, then fire change. */
  const toggle = () => { box.checked = !box.checked; return box.fire("change"); };
  return { box, status, calls, toasts, settle, toggle };
}

const ok = (shareChatForImprovement: boolean): Reply => ({ ok: true, status: 200, json: { shareChatForImprovement, updatedAtMs: 1 } });

describe("Settings > Privacy > Share my chats", () => {
  it("renders an accessible switch, disabled until loaded, with the explanation and no inline handlers", async () => {
    const app = Fastify();
    registerPortalPages(app);
    const html = (await app.inject({ url: "/portal/settings" })).body;
    await app.close();
    expect(html).toContain("Share my chats to help improve EdgeCoder");
    expect(html).toContain('<input id="chatShareToggle" type="checkbox" role="switch" aria-label="Share my chats to help improve EdgeCoder" aria-describedby="chatShareDesc chatShareStatus" disabled />');
    expect(html).toContain('<label class="check" for="chatShareToggle">');
    expect(html).toContain('id="chatShareStatus" role="status" aria-live="polite"');
    expect(html).toContain("Off by default. Your chats stay encrypted at rest either way. Turning it off also withdraws chats you shared before.");
    expect(html).toContain("/me/chat-sharing");
    const privacy = html.slice(html.indexOf('set-group">Privacy'), html.indexOf('set-group">Sign-in'));
    expect(privacy).toContain("chatShareToggle");
    expect(privacy).not.toMatch(/\son[a-z]+=/i);
    expect(privacy).not.toMatch(/style=/);
    expect(() => new Function(CHAT_SHARING_SCRIPT)).not.toThrow();
  });

  it("reads the saved value on load and enables the switch", async () => {
    const t = runScript([ok(true)]);
    await t.settle();
    expect(t.calls).toEqual([{ path: "/me/chat-sharing", options: undefined }]);
    expect(t.box.checked).toBe(true);
    expect(t.box.disabled).toBe(false);
    expect(t.status.textContent).toBe("On");
  });

  it("stays disabled with a message when the setting can't be loaded", async () => {
    for (const reply of [{ ok: false, status: 503, json: { error: "portal_database_not_configured" } }, new Error("offline")]) {
      const t = runScript([reply]);
      await t.settle();
      expect(t.box.disabled).toBe(true);
      expect(t.box.checked).toBe(false);
      expect(t.status.textContent).toMatch(/Could not load/);
    }
  });

  it("PUTs the new value on change and confirms it", async () => {
    const t = runScript([ok(false), ok(true), ok(false)]);
    await t.settle();
    await t.toggle();
    expect(t.calls[1]).toEqual({ path: "/me/chat-sharing", options: { method: "PUT", body: JSON.stringify({ shareChatForImprovement: true }) } });
    expect(t.box.checked).toBe(true);
    expect(t.status.textContent).toBe("On");
    expect(t.box.attrs["aria-busy"]).toBeUndefined();
    expect(t.toasts.at(-1)).toEqual({ msg: expect.stringMatching(/shared/), error: false });
    await t.toggle();
    expect(JSON.parse(t.calls[2]!.options!.body!)).toEqual({ shareChatForImprovement: false });
    expect(t.box.checked).toBe(false);
    expect(t.status.textContent).toBe("Off");
    expect(t.toasts.at(-1)!.msg).toMatch(/withdrawn/);
  });

  it("reverts the switch and shows an error when saving fails", async () => {
    const t = runScript([ok(false), { ok: false, status: 500, json: { error: "boom" } }, new Error("offline")]);
    await t.settle();
    await t.toggle();
    expect(t.box.checked).toBe(false);
    expect(t.status.textContent).toBe("Could not save. Still off.");
    expect(t.toasts.at(-1)).toEqual({ msg: expect.stringContaining("boom"), error: true });
    await t.toggle();
    expect(t.box.checked).toBe(false);
    expect(t.toasts.at(-1)!.error).toBe(true);
    expect(t.box.attrs["aria-busy"]).toBeUndefined();
  });

  it("ignores a second flip while a save is in flight", async () => {
    let release!: (r: Reply) => void;
    const slow = new Promise<Reply>((r) => (release = r));
    const t = runScript([ok(false), slow]);
    await t.settle();
    const saving = t.toggle();
    expect(t.box.attrs["aria-busy"]).toBe("true");
    expect(t.status.textContent).toBe("Saving…");
    await t.toggle();
    expect(t.box.checked).toBe(true);
    expect(t.calls).toHaveLength(2);
    release(ok(true));
    await saving;
    expect(t.box.checked).toBe(true);
    expect(t.status.textContent).toBe("On");
  });
});
