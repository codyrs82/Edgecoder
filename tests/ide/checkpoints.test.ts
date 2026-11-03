import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "../../src/apps/ide/checkpoints.js";

let root: string;
const TURN = "6f1d2c3b-0000-4000-8000-000000000001";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ckpt-"));
  writeFileSync(join(root, "a.txt"), "one\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("CheckpointStore", () => {
  it("keeps each file's original from before the turn's first write, and reports the diff", () => {
    const store = new CheckpointStore();
    store.begin(TURN, root);
    expect(store.capture(TURN, "a.txt")).toBe("a.txt");
    writeFileSync(join(root, "a.txt"), "two\n");
    // A second write in the same turn keeps the first original.
    store.capture(TURN, "./a.txt");
    writeFileSync(join(root, "a.txt"), "three\n");
    expect(store.capture(TURN, "new/b.txt")).toBe("new/b.txt");
    writeFileSync(join(root, "c.txt"), "untracked\n");
    expect(store.capture(TURN, "../escape.txt")).toBeNull();
    mkdirSync(join(root, "new"));
    writeFileSync(join(root, "new", "b.txt"), "created\n");
    expect(store.changes(TURN)).toEqual([
      { path: "a.txt", before: "one\n", after: "three\n" },
      { path: "new/b.txt", before: null, after: "created\n" },
    ]);
  });

  it("reverts one file or the whole turn, deleting files the turn created", () => {
    const store = new CheckpointStore();
    store.begin(TURN, root);
    store.capture(TURN, "a.txt");
    store.capture(TURN, "b.txt");
    writeFileSync(join(root, "a.txt"), "changed\n");
    writeFileSync(join(root, "b.txt"), "created\n");
    expect(store.revert(TURN, ["b.txt"])).toEqual(["b.txt"]);
    expect(existsSync(join(root, "b.txt"))).toBe(false);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("changed\n");
    expect(store.revert(TURN)).toEqual(["a.txt", "b.txt"]);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n");
    expect(store.changes(TURN)).toEqual([]);
  });

  it("knows nothing of unknown turns", () => {
    const store = new CheckpointStore();
    expect(store.changes(TURN)).toBeNull();
    expect(store.revert(TURN)).toBeNull();
    expect(store.capture(TURN, "a.txt")).toBeNull();
  });
});
