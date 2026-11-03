import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { OUTPUT_TRUNCATED_MARKER, runInDockerSandbox, sandboxMaxOutputBytes } from "../../src/executor/docker-sandbox.js";

// A fake `docker` CLI on PATH: logs every invocation; `run` behaves per FAKE_DOCKER_MODE; the
// container "exists" until `rm -f` is called for it (so `container inspect` confirms removal).
const FAKE = `#!/bin/sh
echo "$@" >> "$FAKE_DOCKER_LOG"
case "$1" in
  run)
    case "$FAKE_DOCKER_MODE" in
      hang) exec sleep 30 ;;
      flood) exec yes AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ;;
      *) echo "hello"; exit 0 ;;
    esac ;;
  kill) exit 0 ;;
  rm) touch "$FAKE_DOCKER_DIR/removed"; exit 0 ;;
  container) if [ -f "$FAKE_DOCKER_DIR/removed" ]; then exit 1; else exit 0; fi ;;
esac
exit 0
`;

const isWindows = process.platform === "win32";
let dir: string;
let log: string;
const savedPath = process.env.PATH;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ec-fake-docker-"));
  log = join(dir, "calls.log");
  writeFileSync(join(dir, "docker"), FAKE);
  chmodSync(join(dir, "docker"), 0o755);
  process.env.PATH = `${dir}${delimiter}${savedPath}`;
  process.env.FAKE_DOCKER_LOG = log;
  process.env.FAKE_DOCKER_DIR = dir;
});
afterAll(() => {
  process.env.PATH = savedPath;
  delete process.env.FAKE_DOCKER_MODE;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  writeFileSync(log, "");
  rmSync(join(dir, "removed"), { force: true });
});

const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
const runName = () => /--name=(\S+)/.exec(calls().find((c) => c.startsWith("run ")) ?? "")?.[1];

describe.skipIf(isWindows)("docker sandbox lifecycle (fake docker CLI)", () => {
  it("gives each run a unique container name", async () => {
    process.env.FAKE_DOCKER_MODE = "ok";
    const r1 = await runInDockerSandbox("python", "print(1)", 5000);
    const n1 = runName();
    writeFileSync(log, "");
    await runInDockerSandbox("python", "print(1)", 5000);
    const n2 = runName();
    expect(r1).toMatchObject({ ok: true, stdout: "hello\n" });
    expect(n1).toMatch(/^edgecoder-sbx-/);
    expect(n2).toMatch(/^edgecoder-sbx-/);
    expect(n1).not.toBe(n2);
  });

  it("on timeout kills and removes the container, and confirms it is gone", async () => {
    process.env.FAKE_DOCKER_MODE = "hang";
    const res = await runInDockerSandbox("python", "while True: pass", 300);
    const name = runName();
    expect(res).toMatchObject({ ok: false, exitCode: 124, queueReason: "timeout" });
    expect(res.stderr).toMatch(/timed out/);
    expect(res.stderr).not.toMatch(/could not be confirmed/);
    expect(calls()).toEqual(expect.arrayContaining([`kill ${name}`, `rm -f ${name}`, `container inspect ${name}`]));
    const order = calls().map((c) => c.split(" ")[0]);
    expect(order.indexOf("kill")).toBeLessThan(order.indexOf("rm"));
  });

  it("an abort signal stops the container the same way", async () => {
    process.env.FAKE_DOCKER_MODE = "hang";
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    const res = await runInDockerSandbox("python", "x", 10_000, { signal: ctl.signal });
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/aborted/);
    expect(calls().some((c) => c.startsWith("kill "))).toBe(true);
  });

  it("caps output, stops the container and marks the truncation", async () => {
    process.env.FAKE_DOCKER_MODE = "flood";
    const res = await runInDockerSandbox("python", "x", 10_000, { maxOutputBytes: 4096 });
    expect(res.ok).toBe(false);
    expect(res.stdout.endsWith(OUTPUT_TRUNCATED_MARKER)).toBe(true);
    expect(res.stdout.length).toBe(4096 + OUTPUT_TRUNCATED_MARKER.length);
    expect(res.stderr).toMatch(/output exceeded 4096 bytes/);
    expect(calls().some((c) => c.startsWith("rm -f "))).toBe(true);
  });

  it("the cap defaults to 1 MiB and is configurable", () => {
    expect(sandboxMaxOutputBytes(undefined)).toBe(1024 * 1024);
    expect(sandboxMaxOutputBytes("2048")).toBe(2048);
    expect(sandboxMaxOutputBytes("nope")).toBe(1024 * 1024);
  });
});
