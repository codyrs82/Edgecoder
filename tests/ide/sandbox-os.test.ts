// The real OS sandbox (src/apps/ide/sandbox.ts): sandbox-exec on macOS, bubblewrap on Linux when it
// is installed and allowed to make namespaces. Skipped where there is none (Windows, Linux without bwrap).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bwrapArgs, darwinUserTemp, macProfile, sandboxSupport, type SandboxPaths } from "../../src/apps/ide/sandbox.js";
import { ToolExecutor } from "../../src/apps/ide/tool-executor.js";

const support = sandboxSupport();
const dirs: string[] = [];
const mk = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Runs `command` with /bin/sh in the sandbox built for `paths` (a fake home, so CI needn't have ~/.ssh). */
function inSandbox(command: string, paths: SandboxPaths): { code: number | null; out: string } {
  const [file, args] =
    support.kind === "sandbox-exec"
      ? ["/usr/bin/sandbox-exec", ["-p", macProfile({ ...paths, userTemp: darwinUserTemp() })]]
      : [["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"].find((p) => existsSync(p))!, bwrapArgs(paths)];
  const r = spawnSync(file, [...args, "/bin/sh", "-c", command], { cwd: paths.root, encoding: "utf8", timeout: 30_000, env: { PATH: process.env.PATH, HOME: paths.home, TMPDIR: paths.tmp } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe.skipIf(!support.kind)(`the ${support.kind ?? "OS"} sandbox`, () => {
  const root = mk("sbx-proj-");
  const tmp = mk("sbx-tmp-");
  const home = mk("sbx-home-");
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id_test"), "SECRET-KEY-MATERIAL");
  mkdirSync(join(home, "other"));
  writeFileSync(join(home, "other", ".env"), "TOKEN=outside");
  writeFileSync(join(root, ".env"), "TOKEN=inside");
  const paths: SandboxPaths = { root, tmp, home };

  it("writes inside the project and the temp folder", () => {
    const r = inSandbox("echo in > made.txt && mkdir -p sub && echo t > \"$TMPDIR/t.txt\" && cat made.txt", paths);
    expect(r.code).toBe(0);
    expect(readFileSync(join(root, "made.txt"), "utf8").trim()).toBe("in");
    expect(readFileSync(join(tmp, "t.txt"), "utf8").trim()).toBe("t");
  });

  it("can't write outside the project (the home folder)", () => {
    const target = join(home, "escaped.txt");
    const r = inSandbox(`echo out > '${target}'`, paths);
    // bwrap: this fake home is under /tmp, which is a fresh tmpfs inside the sandbox, so the write
    // may "succeed" there and vanish; it never reaches the real folder. (Real $HOME: the executor test.)
    if (support.kind === "sandbox-exec") expect(r.code).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  it("can't write the project's git hooks", () => {
    const r = inSandbox("echo 'echo pwned' > .git/hooks/pre-commit", paths);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(root, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it("can't read ~/.ssh", () => {
    const r = inSandbox(`cat '${join(home, ".ssh", "id_test")}'`, paths);
    expect(r.out).not.toContain("SECRET-KEY-MATERIAL");
  });

  it("has no network", () => {
    // No DNS either: connect straight to an address.
    const r = inSandbox(`node -e 'const s=require("net").connect(443,"1.1.1.1");s.on("connect",()=>{console.log("CONNECTED");process.exit(0)});s.on("error",e=>{console.log("ERR",e.code);process.exit(3)});setTimeout(()=>process.exit(4),8000)'`, paths);
    expect(r.out).not.toContain("CONNECTED");
    expect(r.code).not.toBe(0);
  });

  it.skipIf(support.kind !== "sandbox-exec")("reads the project's .env but not one outside it (macOS)", () => {
    expect(inSandbox("cat .env", paths).out).toContain("TOKEN=inside");
    expect(inSandbox(`cat '${join(home, "other", ".env")}'`, paths).out).not.toContain("TOKEN=outside");
  });

  it("runs python3 and node scripts", () => {
    const r = inSandbox("python3 - <<'EOF'\nopen('py.txt','w').write('ok')\nprint('py-ran')\nEOF", paths);
    if (r.out.includes("not found")) return; // no python3 on this runner
    expect(r.out).toContain("py-ran");
    expect(readFileSync(join(root, "py.txt"), "utf8")).toBe("ok");
  });

  it("through the executor: a sandboxed run_shell writes the project, and a blocked write says so", async () => {
    const ex = new ToolExecutor(root);
    const ok = JSON.parse((await ex.execute("run_shell", { command: "node -e \"require('fs').writeFileSync('exec.txt','1')\"" }, { sandbox: true })).result!);
    expect(ok).toMatchObject({ exit_code: 0, sandboxed: true });
    expect(existsSync(join(root, "exec.txt"))).toBe(true);
    const target = join(homedir(), `edgecoder-sbx-test-${process.pid}.txt`);
    try {
      const bad = JSON.parse((await ex.execute("run_shell", { command: `echo x > '${target}'` }, { sandbox: true })).result!);
      expect(bad.exit_code).not.toBe(0);
      expect(bad.sandbox_denied).toEqual(expect.any(String));
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(target, { force: true });
    }
  });
});
