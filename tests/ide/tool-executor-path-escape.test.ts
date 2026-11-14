import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolExecutor, evaluateShellCommand, realPathEscape } from "../../src/apps/ide/tool-executor.js";

/*
 * #17: path traversal and symlink escape, the cases tool-executor-paths.test.ts does not reach.
 * That file covers read_file and write_file with a direct symlink. Here: every file tool against
 * every kind of escaping path, realPathEscape on its own, symlinks seen while listing and
 * searching, and the path check on run_shell arguments.
 */

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const canSymlink = (() => {
  try {
    const dir = mkdtempSync(join(tmpdir(), "ec-sl-"));
    try {
      symlinkSync(dir, join(dir, "l"), "dir");
      return true;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    return false; // Windows without developer mode
  }
})();

const SECRET = `secret NEEDLE ${"x".repeat(4000)}\n`;

/**
 * base/proj (the root), base/outside (must never be read or written), base/proj-evil (a sibling
 * sharing the root's name as a prefix), and, when symlinks are available, links in the root that
 * leave it in each way a link can.
 */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "ec-escape-"));
  made.push(base);
  const root = join(base, "proj");
  const outside = join(base, "outside");
  const sibling = join(base, "proj-evil");
  for (const dir of [root, outside, sibling, join(root, "sub")]) mkdirSync(dir);
  writeFileSync(join(root, "ok.txt"), "inside NEEDLE\n");
  writeFileSync(join(root, "sub", "deep.txt"), "deep\n");
  writeFileSync(join(outside, "secret.txt"), SECRET);
  writeFileSync(join(sibling, "x.txt"), "evil\n");
  if (canSymlink) {
    symlinkSync(join(outside, "secret.txt"), join(root, "leak.txt")); // file link, absolute target
    symlinkSync(outside, join(root, "out"), "dir"); // directory link, absolute target
    symlinkSync(join("..", "..", "outside"), join(root, "sub", "rel"), "dir"); // relative target
    symlinkSync("..", join(root, "up"), "dir"); // the root's parent
    symlinkSync(join(root, "out"), join(root, "chain"), "dir"); // in -> in -> out
    symlinkSync(sibling, join(root, "twin"), "dir"); // the sibling with the shared prefix
    symlinkSync(join(outside, "not-there.txt"), join(root, "dangling.txt")); // target missing
    symlinkSync(join(root, "loop-b"), join(root, "loop-a")); // a cycle
    symlinkSync(join(root, "loop-a"), join(root, "loop-b"));
    symlinkSync(join(root, "sub"), join(root, "alias"), "dir"); // stays inside
  }
  return { base, root, outside, sibling, exec: new ToolExecutor(root) };
}

/** Everything under `dir`, as "relative path = content", to prove nothing outside the root changed. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(current, entry.name), `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name} = ${readFileSync(join(current, entry.name), "utf8")}`);
    }
  };
  walk(dir, "");
  return out.sort();
}

const REJECTED = /escapes project root|Dangling symlink/;

describe.skipIf(!canSymlink)("realPathEscape (#17)", () => {
  it("returns null for paths that really are inside, existing or not", () => {
    const { root } = fixture();
    for (const path of ["ok.txt", "sub/deep.txt", "sub", "new.txt", "new/deeper/still/new.txt", "alias/deep.txt", "alias/new.txt", "."]) {
      expect(realPathEscape(root, join(root, path)), path).toBeNull();
    }
  });

  it("reports an escape for a link out of the root, however it is written", () => {
    const { root } = fixture();
    for (const path of ["leak.txt", "out", "out/secret.txt", "sub/rel", "sub/rel/secret.txt", "up", "up/outside/secret.txt", "chain", "chain/secret.txt", "twin/x.txt"]) {
      expect(realPathEscape(root, join(root, path)), path).toBe("escape");
    }
  });

  it("reports an escape for a path that does not exist yet beneath a link out of the root", () => {
    const { root, outside } = fixture();
    for (const path of ["out/new.txt", "out/a/b/c/new.txt", "sub/rel/new/file.txt", "chain/new.txt", "up/created/x.txt"]) {
      expect(realPathEscape(root, join(root, path)), path).toBe("escape");
    }
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
  });

  it("reports a dangling link, and a link cycle, instead of treating them as new files", () => {
    const { root } = fixture();
    expect(realPathEscape(root, join(root, "dangling.txt"))).toBe("dangling");
    expect(realPathEscape(root, join(root, "loop-a"))).toBe("dangling");
    expect(realPathEscape(root, join(root, "loop-a", "x.txt"))).toBe("dangling");
  });

  it("judges by where the path really is: out through a link and back in is inside", () => {
    const { root } = fixture();
    expect(realPathEscape(root, join(root, "up", "proj", "ok.txt"))).toBeNull();
    expect(realPathEscape(root, join(root, "up", "proj-evil", "x.txt"))).toBe("escape");
  });

  it("accepts a root that is itself reached through a link", () => {
    const { base, root } = fixture();
    const linkedRoot = join(base, "linked-root");
    symlinkSync(root, linkedRoot, "dir");
    expect(realPathEscape(linkedRoot, join(linkedRoot, "ok.txt"))).toBeNull();
    expect(realPathEscape(linkedRoot, join(linkedRoot, "new", "file.txt"))).toBeNull();
    expect(realPathEscape(linkedRoot, join(linkedRoot, "out", "secret.txt"))).toBe("escape");
  });
});

describe("ToolExecutor: every file tool refuses every escaping path (#17)", () => {
  const TOOLS: Array<[string, (path: string) => Record<string, unknown>]> = [
    ["read_file", (path) => ({ path })],
    ["write_file", (path) => ({ path, content: "pwned" })],
    ["edit_file", (path) => ({ path, old_string: "secret", new_string: "pwned" })],
    ["list_directory", (path) => ({ path })],
    ["search_files", (path) => ({ pattern: "NEEDLE", path })]
  ];

  it.each(TOOLS)("%s: ../ traversal, absolute paths and the sibling with the same prefix", async (tool, args) => {
    const { exec, outside, sibling, base } = fixture();
    const before = [snapshot(outside), snapshot(sibling)];
    const paths = ["..", "../outside", "../outside/secret.txt", "sub/../../outside/secret.txt", "../proj-evil/x.txt", outside, join(outside, "secret.txt"), join(sibling, "x.txt"), base, "/", "/etc/hosts"];
    for (const path of paths) {
      const result = await exec.execute(tool as never, args(path), { approved: true });
      expect(result.error, `${tool} ${path}`).toMatch(/escapes project root/);
      expect(result.result, `${tool} ${path}`).toBeUndefined();
    }
    expect([snapshot(outside), snapshot(sibling)]).toEqual(before);
  });

  it.skipIf(!canSymlink).each(TOOLS)("%s: through a link out of the root (file, directory, relative, parent, chained, dangling, cyclic)", async (tool, args) => {
    const { exec, outside, sibling } = fixture();
    const before = [snapshot(outside), snapshot(sibling)];
    const paths = [
      "leak.txt", "out", "out/secret.txt", "out/new.txt", "out/a/b/new.txt", "sub/rel", "sub/rel/secret.txt", "up", "up/outside/secret.txt",
      "chain", "chain/secret.txt", "twin", "twin/x.txt", "dangling.txt", "loop-a", "loop-a/x.txt", "alias/../out/secret.txt"
    ];
    for (const path of paths) {
      const result = await exec.execute(tool as never, args(path), { approved: true });
      expect(result.error, `${tool} ${path}`).toMatch(REJECTED);
      expect(result.result, `${tool} ${path}`).toBeUndefined();
    }
    // Nothing outside was changed or created, and the links were not replaced by files.
    expect([snapshot(outside), snapshot(sibling)]).toEqual(before);
    expect(lstatSync(join(exec["root" as never], "leak.txt")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, "not-there.txt"))).toBe(false);
  });

  it.skipIf(!canSymlink)("links that stay inside the root keep working for every tool", async () => {
    const { exec, root } = fixture();
    expect((await exec.execute("read_file", { path: "alias/deep.txt" })).result).toContain("deep");
    expect((await exec.execute("list_directory", { path: "alias" })).result).toContain("deep.txt");
    expect((await exec.execute("search_files", { pattern: "deep", path: "alias" })).error).toBeUndefined();
    expect((await exec.execute("edit_file", { path: "alias/deep.txt", old_string: "deep", new_string: "edited" }, { approved: true })).error).toBeUndefined();
    expect((await exec.execute("write_file", { path: "alias/new.txt", content: "new" }, { approved: true })).error).toBeUndefined();
    expect(readFileSync(join(root, "sub", "deep.txt"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(root, "sub", "new.txt"), "utf8")).toBe("new");
  });

  it("a NUL byte in the path never reaches a file outside the root", async () => {
    const { exec, outside, sibling } = fixture();
    const before = [snapshot(outside), snapshot(sibling)];
    // Node does not cut a path at NUL, so these either stay inside the root or are refused.
    for (const path of ["ok.txt\0../../outside/secret.txt", "../outside/secret.txt\0ok.txt", "ok.txt\0", "\0"]) {
      const read = await exec.execute("read_file", { path });
      expect(read.result ?? "", JSON.stringify(path)).not.toContain("secret");
      await exec.execute("write_file", { path, content: "pwned" }, { approved: true });
      await exec.execute("edit_file", { path, old_string: "secret", new_string: "pwned" }, { approved: true });
    }
    expect([snapshot(outside), snapshot(sibling)]).toEqual(before);
  });
});

describe.skipIf(!canSymlink)("ToolExecutor: links met while listing and searching (#17)", () => {
  it("list_directory lists a link as itself, not with the size of the file it points at", async () => {
    const { exec } = fixture();
    const listing = (await exec.execute("list_directory", { path: "." })).result ?? "";
    expect(listing).toContain("ok.txt  (14 bytes)");
    expect(listing).toContain("leak.txt");
    // The target outside the root is 4,014 bytes; its size is not something the listing may reveal.
    expect(listing).not.toContain(`${Buffer.byteLength(SECRET)} bytes`);
    // A linked directory is not expanded into the outside directory's entries.
    expect(listing).not.toContain("secret.txt");
  });

  it("search_files does not follow links out of the root while walking the tree", async () => {
    const { exec } = fixture();
    for (const path of [".", "sub"]) {
      const result = await exec.execute("search_files", { pattern: "NEEDLE|evil", path });
      expect(result.error).toBeUndefined();
      expect(result.result ?? "", path).not.toMatch(/secret|proj-evil|x\.txt|outside/);
    }
    expect((await exec.execute("search_files", { pattern: "NEEDLE", path: "." })).result).toBe("ok.txt:1:inside NEEDLE");
  });
});

describe("run_shell without approval: path arguments (#17)", () => {
  it.skipIf(!canSymlink)("refuses a path argument that leaves the root through any kind of link", () => {
    const { root } = fixture();
    for (const command of [
      "cat leak.txt", "cat ./leak.txt", "cat sub/../leak.txt", "head -n 1 leak.txt", "wc -c leak.txt", "ls out", "ls out/", "cat out/secret.txt",
      "cat sub/rel/secret.txt", "cat chain/secret.txt", "cat up/outside/secret.txt", "cat twin/x.txt", "cat dangling.txt", "cat loop-a",
      "grep --file=leak.txt ok.txt", "wc --files0-from=leak.txt", "git diff --no-index ok.txt leak.txt", "git log -p -- leak.txt"
    ]) {
      expect(evaluateShellCommand(command, { root }), command).toMatchObject({ allowed: false });
    }
    for (const command of ["cat ok.txt", "cat alias/deep.txt", "cat up/proj/ok.txt", "ls sub", "grep -rn NEEDLE ."]) {
      expect(evaluateShellCommand(command, { root }), command).toMatchObject({ allowed: true, useShell: false });
    }
  });

  it("refuses a path attached to a short option the same as one given separately", () => {
    const { root } = fixture();
    // `grep -f FILE` reads FILE. `-f ../x` and `--file=../x` were refused; `-f../x` was not.
    for (const command of ["grep -f../outside/secret.txt ok.txt", "grep -f/etc/passwd ok.txt", "grep -f~/.ssh/id_rsa ok.txt", "rg -f../outside/secret.txt", "git log -O../outside/secret.txt"]) {
      expect(evaluateShellCommand(command, { root }), command).toMatchObject({ allowed: false });
    }
    // Attached values that are not paths out of the root are unaffected.
    for (const command of ["head -n5 ok.txt", "tail -n+2 ok.txt", "grep -rn -A3 -B2 NEEDLE .", "ls -la", "grep -fok.txt ok.txt", "grep -esub/deep ok.txt", "git log -n5", "git diff -U3", "rg -tts NEEDLE"]) {
      expect(evaluateShellCommand(command, { root }), command).toMatchObject({ allowed: true });
    }
  });

  it.skipIf(!canSymlink)("refuses a link out of the root attached to a short option", () => {
    const { root } = fixture();
    for (const command of ["grep -fleak.txt ok.txt", "grep -fout/secret.txt ok.txt", "rg -fsub/rel/secret.txt NEEDLE"]) {
      expect(evaluateShellCommand(command, { root }), command).toMatchObject({ allowed: false });
    }
  });

  it("runs an allowed command without a shell, so ~, $VAR and globs in arguments are not expanded", () => {
    const { root } = fixture();
    for (const command of ["cat $HOME/.ssh/id_rsa", "cat ${HOME}/.ssh/id_rsa", "cat ../*"]) {
      const decision = evaluateShellCommand(command, { root });
      // Refused, or passed to the program as literal text.
      if (decision.allowed) expect(decision, command).toMatchObject({ useShell: false, argv: command.split(" ") });
    }
    expect(evaluateShellCommand("cat ../*", { root })).toMatchObject({ allowed: false });
    expect(evaluateShellCommand("cat ~/.ssh/id_rsa", { root })).toMatchObject({ allowed: false });
    expect(evaluateShellCommand("cat $(pwd)/../outside/secret.txt", { root })).toMatchObject({ allowed: false });
  });

  /*
   * Known gap, not fixed here (reported on #17): the check looks at path arguments, so a recursive
   * search told to follow links (GNU `grep -R`, `rg -L`) walks through a committed `link -> /outside`
   * without approval. Refusing those flags means an approval prompt for every `grep -R`, which
   * models type by habit; that trade-off is the owner's call. When it is closed, this test starts
   * failing: turn it into a plain `it`.
   */
  it.fails("known gap: a recursive search that follows links is still allowed without approval", () => {
    const { root } = fixture();
    for (const command of ["grep -R NEEDLE .", "grep --dereference-recursive NEEDLE .", "rg -L NEEDLE", "rg --follow NEEDLE ."]) {
      expect(evaluateShellCommand(command, { root }), command).toMatchObject({ allowed: false });
    }
  });
});
