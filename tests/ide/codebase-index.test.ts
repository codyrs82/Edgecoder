import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkText, CodebaseIndex, type EmbedFn } from "../../src/apps/ide/codebase-index.js";

const VOCAB = ["payout", "retry", "login", "form", "password", "invoice", "lightning", "button", "render", "fee"];
/** Bag-of-words "embedding" over a tiny vocabulary: enough to rank by topic. */
function fakeEmbed(log: string[][]): EmbedFn {
  return async (inputs) => {
    log.push(inputs);
    return inputs.map((t) => VOCAB.map((w) => (t.toLowerCase().match(new RegExp(w, "g")) ?? []).length + 0.01));
  };
}

let root: string;
let indexDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cbi-root-"));
  indexDir = mkdtempSync(join(tmpdir(), "cbi-store-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "payouts.ts"), "// retry a lightning payout\nexport function retryPayout(invoice) {\n  // payout retry with fee cap\n}\n");
  writeFileSync(join(root, "src", "Login.svelte"), "<form>\n  <input type=password>\n  <button>login</button>\n</form>\n<!-- render the login form -->\n");
  writeFileSync(join(root, "package-lock.json"), '{"payout": "noise"}');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(indexDir, { recursive: true, force: true });
});

describe("chunkText", () => {
  it("makes overlapping 60-line windows with 1-based line numbers", () => {
    const text = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const chunks = chunkText("a.ts", text).map((c) => [c.startLine, c.endLine]);
    expect(chunks).toEqual([[1, 60], [51, 110], [101, 130]]);
  });
});

describe("CodebaseIndex", () => {
  it("indexes project files (not lockfiles), ranks by meaning, and persists", async () => {
    const log: string[][] = [];
    const idx = new CodebaseIndex(root, fakeEmbed(log), "fake", indexDir);
    expect(idx.getStatus().state).toBe("none");
    await idx.build();
    expect(idx.getStatus()).toMatchObject({ state: "ready", files: 2, chunks: 2 });
    expect(log.flat().some((t) => t.includes("package-lock"))).toBe(false);
    expect(log[0][0].startsWith("search_document: ")).toBe(true);

    const hits = await idx.search("where do we retry a payout?", 2);
    expect(hits[0].path).toBe("src/payouts.ts");
    expect(hits[0].snippet).toContain("retryPayout");
    expect((await idx.search("the login form", 1))[0].path).toBe("src/Login.svelte");

    // A fresh instance loads the saved index without re-embedding.
    const log2: string[][] = [];
    const again = new CodebaseIndex(root, fakeEmbed(log2), "fake", indexDir);
    expect(again.getStatus()).toMatchObject({ state: "ready", files: 2 });
    expect((await again.search("login", 1))[0].path).toBe("src/Login.svelte");
    expect(log2).toHaveLength(1); // only the query
  });

  it("re-embeds only files that changed", async () => {
    const log: string[][] = [];
    const idx = new CodebaseIndex(root, fakeEmbed(log), "fake", indexDir);
    await idx.build();
    log.length = 0;
    writeFileSync(join(root, "src", "payouts.ts"), "// now about invoices\nexport const invoice = 1;\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, "src", "payouts.ts"), later, later);
    await idx.build();
    expect(log.flat()).toHaveLength(1);
    expect(log[0][0]).toContain("now about invoices");
  });

  it("an index built with another model is not reused", async () => {
    await new CodebaseIndex(root, fakeEmbed([]), "model-a", indexDir).build();
    expect(new CodebaseIndex(root, fakeEmbed([]), "model-b", indexDir).getStatus().state).toBe("none");
  });

  it("reports an embedding failure in the status", async () => {
    const idx = new CodebaseIndex(root, async () => { throw new Error("the embedding model x is not installed"); }, "x", indexDir);
    await expect(idx.build()).rejects.toThrow(/not installed/);
    expect(idx.getStatus()).toMatchObject({ state: "error", error: expect.stringContaining("not installed") });
  });
});
