/**
 * Just enough DOM to run a portal page script in node (no jsdom here): elements with attributes,
 * classes, children and text; querySelector(All) by tag, .class or tag.class; listeners kept but
 * never fired. Layout reads (clientWidth, getBoundingClientRect) return fixed sizes.
 */
export class FakeEl {
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  style: Record<string, string> = {};
  value = "";
  clientWidth = 600;
  offsetWidth = 120;
  dataset: Record<string, string> = {};
  private text = "";

  constructor(readonly tagName: string) {}

  get classList() {
    const list = () => (this.attrs.class ?? "").split(/\s+/).filter(Boolean);
    return {
      add: (c: string) => void (this.attrs.class = [...new Set([...list(), c])].join(" ")),
      remove: (c: string) => void (this.attrs.class = list().filter((x) => x !== c).join(" ")),
      contains: (c: string) => list().includes(c)
    };
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.text = String(v);
    for (const c of this.children) c.parent = null;
    this.children = [];
  }
  setAttribute(k: string, v: unknown): void {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  appendChild(c: FakeEl): FakeEl {
    c.remove();
    c.parent = this;
    this.children.push(c);
    return c;
  }
  insertBefore(c: FakeEl, ref: FakeEl | null): FakeEl {
    if (!ref) return this.appendChild(c);
    c.remove();
    c.parent = this;
    this.children.splice(this.children.indexOf(ref), 0, c);
    return c;
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
    this.parent = null;
  }
  addEventListener(): void {}
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 600, height: 170 };
  }
  querySelectorAll(sel: string): FakeEl[] {
    const [tag, cls] = sel.includes(".") ? sel.split(".") : [sel, undefined];
    const out: FakeEl[] = [];
    const walk = (e: FakeEl) => {
      for (const c of e.children) {
        if ((!tag || c.tagName === tag) && (!cls || c.classList.contains(cls!))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): FakeEl | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

/** A document whose elements by id are made on first use; `prepare` builds the ones a test needs up front. */
export function fakeDocument(prepare: (byId: Map<string, FakeEl>) => void) {
  const byId = new Map<string, FakeEl>();
  prepare(byId);
  const document = {
    hidden: false,
    getElementById: (id: string) => {
      if (!byId.has(id)) byId.set(id, new FakeEl("div"));
      return byId.get(id)!;
    },
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
    createTextNode: (text: string) => {
      const t = new FakeEl("#text");
      t.textContent = text;
      return t;
    },
    querySelectorAll: () => [],
    addEventListener: () => undefined
  };
  return { document, byId };
}
