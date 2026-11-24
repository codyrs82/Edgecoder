import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeToolRunner } from "../../src/apps/ide/agent-loop.js";
import { classifyCommand, decideToolCall, isNodeVersionSetup } from "../../src/apps/ide/permission-policy.js";
import { evaluateShellCommand } from "../../src/apps/ide/tool-executor.js";
import {
  detectMachine,
  parseVersion,
  planToolchain,
  readWantedNode,
  satisfies,
  toolchainFailureHintFor,
  toolchainNoteFor,
  type MachineDeps,
  type ToolchainFs,
  type WantedNode,
} from "../../src/apps/ide/toolchain.js";

/** An in-memory file system: paths to contents ("" for a file that only has to exist). */
function memFs(files: Record<string, string>, links: Record<string, string> = {}): ToolchainFs {
  const paths = Object.keys(files);
  // The code joins paths with node:path, so on Windows they arrive with backslashes.
  const n = (p: string) => p.replace(/\\/g, "/");
  return {
    exists: (raw) => { const p = n(raw); return p in files || paths.some((f) => f.startsWith(`${p}/`)); },
    readFile: (raw) => { const p = n(raw); return p in files ? files[p] : null; },
    readdir: (raw) => { const p = n(raw); return [...new Set(paths.filter((f) => f.startsWith(`${p}/`)).map((f) => f.slice(p.length + 1).split("/")[0]))]; },
    realpath: (raw) => links[n(raw)] ?? n(raw),
  };
}

const HOME = "/Users/me";
const machine = (files: Record<string, string>, env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" }, links: Record<string, string> = {}, platform: NodeJS.Platform = "darwin"): MachineDeps => ({
  fs: memFs(files, links),
  env,
  home: HOME,
  platform,
});

describe("versions and ranges", () => {
  it("parses versions", () => {
    expect(parseVersion("v22.12.0")).toEqual([22, 12, 0]);
    expect(parseVersion("22")).toEqual([22, 0, 0]);
    expect(parseVersion("lts/jod")).toBeNull();
  });
  it("checks engines ranges", () => {
    expect(satisfies("v26.0.0", ">=22.12 <25")).toBe(false);
    expect(satisfies("v22.12.0", ">=22.12 <25")).toBe(true);
    expect(satisfies("v22.11.0", ">=22.12 <25")).toBe(false);
    expect(satisfies("v24.1.0", ">=22.12 <25")).toBe(true);
    expect(satisfies("v20.5.0", "^18 || ^20")).toBe(true);
    expect(satisfies("v21.0.0", "^18 || ^20")).toBe(false);
    expect(satisfies("v18.17.1", "18.x")).toBe(true);
    expect(satisfies("v22.0.0", "16 - 20")).toBe(false);
    expect(satisfies("v20.9.0", ">= 18")).toBe(true);
    expect(satisfies("v20.9.0", "~20.9")).toBe(true);
    expect(satisfies("v20.10.0", "~20.9")).toBe(false);
    expect(satisfies("v20.0.0", "not a range")).toBeNull();
  });
});

// Paths in these fixtures are POSIX; the feature itself is off on Windows (toolchainNote/toolchainFailureHint).
describe.skipIf(process.platform === "win32")("readWantedNode", () => {
  const root = "/p";
  it("reads .nvmrc first, with engines alongside", () => {
    const fs = memFs({ "/p/.nvmrc": "22\n", "/p/package.json": JSON.stringify({ engines: { node: ">=22.12 <25" } }) });
    expect(readWantedNode(root, fs)).toEqual({ pin: { spec: "22", source: ".nvmrc", major: 22 }, engines: ">=22.12 <25" });
  });
  it("reads .node-version", () => {
    expect(readWantedNode(root, memFs({ "/p/.node-version": "v20.11.1" })).pin).toEqual({ spec: "v20.11.1", source: ".node-version", major: 20 });
  });
  it("reads nodejs from .tool-versions", () => {
    expect(readWantedNode(root, memFs({ "/p/.tool-versions": "python 3.12.1\nnodejs 18.19.0\n" })).pin).toEqual({ spec: "18.19.0", source: ".tool-versions", major: 18 });
  });
  it("reads volta.node", () => {
    expect(readWantedNode(root, memFs({ "/p/package.json": JSON.stringify({ volta: { node: "20.10.0" } }) })).pin).toEqual({ spec: "20.10.0", source: "package.json volta.node", major: 20 });
  });
  it("reads engines.node alone, and LTS names", () => {
    expect(readWantedNode(root, memFs({ "/p/package.json": JSON.stringify({ engines: { node: ">=18" } }) }))).toEqual({ pin: null, engines: ">=18" });
    expect(readWantedNode(root, memFs({ "/p/.nvmrc": "# comment\nlts/iron\n" })).pin?.major).toBe(20);
  });
  it("is empty without any of them", () => {
    expect(readWantedNode(root, memFs({ "/p/package.json": "{not json" }))).toEqual({ pin: null, engines: null });
  });
});

// Paths in these fixtures are POSIX; the feature itself is off on Windows (toolchainNote/toolchainFailureHint).
describe.skipIf(process.platform === "win32")("detectMachine", () => {
  it("finds nvm and its installed versions", () => {
    const m = detectMachine(machine({ [`${HOME}/.nvm/nvm.sh`]: "", [`${HOME}/.nvm/versions/node/v22.12.0/bin/node`]: "", [`${HOME}/.nvm/versions/node/v26.0.0/bin/node`]: "" }));
    expect(m.managers.map((x) => x.name)).toEqual(["nvm"]);
    expect(m.installed.map((i) => i.version.join("."))).toEqual(["22.12.0", "26.0.0"]);
    expect(m.managers[0].install("22")).toBe(`. "${HOME}/.nvm/nvm.sh" && nvm install 22`);
  });
  it("honours NVM_DIR", () => {
    const m = detectMachine(machine({ "/opt/nvm/nvm.sh": "" }, { NVM_DIR: "/opt/nvm", PATH: "" }));
    expect(m.managers[0].exec("22", "npm ci")).toBe('. "/opt/nvm/nvm.sh" && nvm use 22 >/dev/null && npm ci');
  });
  it("finds fnm on PATH and its versions", () => {
    const m = detectMachine(machine({ "/opt/homebrew/bin/fnm": "", [`${HOME}/Library/Application Support/fnm/node-versions/v22.1.0/installation/bin/node`]: "" }, { PATH: "/opt/homebrew/bin" }));
    expect(m.managers.find((x) => x.name === "fnm")?.exec("22", "npm ci")).toBe("fnm exec --using=22 npm ci");
    expect(m.installed[0]).toMatchObject({ via: "fnm", bin: `${HOME}/Library/Application Support/fnm/node-versions/v22.1.0/installation/bin` });
  });
  it("finds volta, asdf and mise", () => {
    const m = detectMachine(
      machine({
        [`${HOME}/.volta/bin/volta`]: "",
        [`${HOME}/.volta/tools/image/node/20.10.0/bin/node`]: "",
        [`${HOME}/.asdf/bin/asdf`]: "",
        [`${HOME}/.asdf/installs/nodejs/18.19.0/bin/node`]: "",
        [`${HOME}/.local/bin/mise`]: "",
        [`${HOME}/.local/share/mise/installs/node/22.12.0/bin/node`]: "",
        [`${HOME}/.local/share/mise/installs/node/22/bin/node`]: "",
      }),
    );
    expect(m.managers.map((x) => x.name)).toEqual(["volta", "asdf", "mise"]);
    expect(m.installed.map((i) => `${i.via}:${i.version.join(".")}`)).toEqual(["volta:20.10.0", "asdf:18.19.0", "mise:22.12.0"]);
  });
  it("finds Homebrew node@N kegs", () => {
    const m = detectMachine(
      machine({ "/opt/homebrew/bin/brew": "", "/opt/homebrew/opt/node@22/bin/node": "", "/opt/homebrew/opt/node/bin/node": "" }, { PATH: "/usr/bin" }, { "/opt/homebrew/opt/node@22": "/opt/homebrew/Cellar/node@22/22.12.0" }),
    );
    expect(m.managers.map((x) => x.name)).toEqual(["brew"]);
    expect(m.installed).toEqual([{ version: [22, 12, 0], bin: "/opt/homebrew/opt/node@22/bin", via: "brew" }]);
  });
  it("finds nothing on a bare machine", () => {
    expect(detectMachine(machine({}))).toEqual({ managers: [], installed: [] });
  });
});

// Paths in these fixtures are POSIX; the feature itself is off on Windows (toolchainNote/toolchainFailureHint).
describe.skipIf(process.platform === "win32")("planToolchain and the system-context note", () => {
  const wanted: WantedNode = { pin: { spec: "22", source: ".nvmrc", major: 22 }, engines: ">=22.12 <25" };

  it("says nothing when the shell's Node fits", () => {
    const r = planToolchain(wanted, "v22.14.0", { managers: [], installed: [] });
    expect(r.mismatch).toBe(false);
    expect(toolchainNoteFor(r)).toBe("");
  });

  it("names the installed version and a PATH prefix (the reported case: Node 26, .nvmrc 22)", () => {
    const m = detectMachine(machine({ [`${HOME}/.nvm/nvm.sh`]: "", [`${HOME}/.nvm/versions/node/v22.12.0/bin/node`]: "", [`${HOME}/.nvm/versions/node/v26.0.0/bin/node`]: "" }));
    const r = planToolchain(wanted, "v26.0.0", m);
    expect(r.mismatch).toBe(true);
    expect(r.use?.version).toEqual([22, 12, 0]);
    expect(r.runWith("npm ci")).toBe(`PATH="${HOME}/.nvm/versions/node/v22.12.0/bin:$PATH" npm ci`);
    const note = toolchainNoteFor(r);
    expect(note).toContain("Node 22 (22 in .nvmrc; engines.node \">=22.12 <25\" in package.json)");
    expect(note).toContain("Node v26.0.0");
    expect(note).toContain(`\`PATH="${HOME}/.nvm/versions/node/v22.12.0/bin:$PATH" npm ci\``);
  });

  it("skips an installed version the engines rule out", () => {
    const m = detectMachine(machine({ [`${HOME}/.nvm/nvm.sh`]: "", [`${HOME}/.nvm/versions/node/v22.3.0/bin/node`]: "" }));
    const r = planToolchain(wanted, "v26.0.0", m);
    expect(r.use).toBeNull();
    expect(r.install).toBe(`. "${HOME}/.nvm/nvm.sh" && nvm install 22`);
    expect(r.runWith("npm ci")).toBe(`. "${HOME}/.nvm/nvm.sh" && nvm use 22 >/dev/null && npm ci`);
    expect(toolchainNoteFor(r)).toContain("isn't installed. Install it with");
  });

  it("picks the newest LTS major for an engines-only project", () => {
    const r = planToolchain({ pin: null, engines: ">=18 <23" }, "v26.0.0", { managers: [], installed: [] }, "darwin");
    expect(r.target).toBe("22");
    expect(r.install).toBe("brew install node@22");
    expect(r.runWith("npm ci")).toBe('PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm ci');
  });

  it("suggests brew install and the keg PATH when Homebrew is the only manager", () => {
    const m = detectMachine(machine({ "/opt/homebrew/bin/brew": "" }));
    const r = planToolchain(wanted, "v26.0.0", m, "darwin");
    expect(r.install).toBe("brew install node@22");
    expect(r.runWith("npm test")).toBe('PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm test');
  });

  it("without any manager off macOS, says so", () => {
    const r = planToolchain(wanted, "v26.0.0", { managers: [], installed: [] }, "linux");
    expect(r.install).toBeNull();
    expect(toolchainNoteFor(r)).toContain("No Node version manager was found");
  });

  it("treats a missing node as a mismatch", () => {
    expect(planToolchain(wanted, null, { managers: [], installed: [] }).mismatch).toBe(true);
  });
});

// Paths in these fixtures are POSIX; the feature itself is off on Windows (toolchainNote/toolchainFailureHint).
describe.skipIf(process.platform === "win32")("failure hints", () => {
  const wanted: WantedNode = { pin: { spec: "22", source: ".nvmrc", major: 22 }, engines: ">=22.12 <25" };
  const nvm = detectMachine(machine({ [`${HOME}/.nvm/nvm.sh`]: "", [`${HOME}/.nvm/versions/node/v22.12.0/bin/node`]: "" }));
  const report = planToolchain(wanted, "v26.0.0", nvm);
  const ebadengine = `npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: 'myapp@1.0.0',
npm warn EBADENGINE   required: { node: '>=22.12 <25' },
npm warn EBADENGINE   current: { node: 'v26.0.0', npm: '11.0.0' }
npm warn EBADENGINE }`;
  const gyp = `npm error path /p/node_modules/better-sqlite3
npm error command failed
npm error gyp ERR! build error
npm error gyp ERR! stack Error: \`make\` failed with exit code: 2
npm error ../src/better_sqlite3.cpp:1:10: error: no member named 'GetIsolate'`;
  const abi = "Error: The module '/p/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\nwas compiled against a different Node.js version using\nNODE_MODULE_VERSION 127. This version of Node.js requires\nNODE_MODULE_VERSION 141.";

  it("gives the diagnosis and the same command under the right version", () => {
    for (const out of [ebadengine, gyp, abi, 'error myapp@1.0.0: The engine "node" is incompatible with this module.']) {
      const hint = toolchainFailureHintFor("npm ci", out, report);
      expect(hint).toContain("[EdgeCoder hint]");
      expect(hint).toContain(`\`PATH="${HOME}/.nvm/versions/node/v22.12.0/bin:$PATH" npm ci\``);
    }
  });
  it("says nothing for unrelated failures or an already wrapped command", () => {
    expect(toolchainFailureHintFor("npm ci", "npm error 404 Not Found", report)).toBeNull();
    expect(toolchainFailureHintFor(`PATH="${HOME}/.nvm/versions/node/v22.12.0/bin:$PATH" npm ci`, gyp, report)).toBeNull();
  });
  it("a native build failure without a version mismatch is not about Node", () => {
    expect(toolchainFailureHintFor("npm ci", gyp, planToolchain(wanted, "v22.14.0", nvm))).toBeNull();
  });
  it("names a dependency's engines when the project itself fits", () => {
    const hint = toolchainFailureHintFor("npm ci", ebadengine.replace("'>=22.12 <25'", "'>=24'"), planToolchain(wanted, "v22.14.0", nvm));
    expect(hint).toContain("(>=24)");
  });

  it("makeToolRunner appends the hint to the run_shell result the model sees", async () => {
    const output = JSON.stringify({ stdout: "", stderr: gyp, exit_code: 1 });
    const run = makeToolRunner({
      execute: async () => ({ result: output }),
      sendEvent: () => {},
      waitForApproval: async () => true,
      captureBeforeWrite: () => null,
      turnId: "t",
      decide: () => ({ action: "run", reason: "test" }),
      shellHint: (command, out) => toolchainFailureHintFor(command, out, report),
    });
    const text = await run("run_shell", { command: "npm ci" });
    expect(text.startsWith(output)).toBe(true);
    expect(text).toContain("[EdgeCoder hint] This failure looks like a Node version mismatch.");
  });
});

describe("permission policy for version-manager commands", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "toolchain-policy-"));
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "nvm.sh"), "");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const cls = (c: string) => classifyCommand(c, { root, branch: "feat/x" });

  it("PATH prefixes are transparent around the inner command", () => {
    expect(cls('PATH="/Users/me/.nvm/versions/node/v22.12.0/bin:$PATH" npm test')).toMatchObject({ action: "run", category: "dev" });
    expect(cls('PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm ci')).toMatchObject({ action: "ask", category: "install" });
    expect(cls('PATH="/opt/homebrew/opt/node@22/bin:$PATH" rm -rf /')).toMatchObject({ action: "refuse" });
  });
  it("a PATH into the project or a relative one asks", () => {
    expect(cls(`PATH="${root}/bin:$PATH" npm test`)).toMatchObject({ action: "ask", category: "outside" });
    expect(cls('PATH="./bin:$PATH" npm test')).toMatchObject({ action: "ask" });
  });
  it("sourcing nvm and nvm use are transparent", () => {
    expect(cls('. "/Users/me/.nvm/nvm.sh" && nvm use 22 >/dev/null && npm test')).toMatchObject({ action: "run", category: "dev" });
    expect(cls('source "$NVM_DIR/nvm.sh" && nvm use 22 >/dev/null && npm run lint')).toMatchObject({ action: "run", category: "dev" });
    expect(cls('. "/Users/me/.nvm/nvm.sh" && nvm use 22 >/dev/null && npm ci')).toMatchObject({ action: "ask", category: "install" });
    expect(cls('. "/Users/me/.nvm/nvm.sh" && nvm use 22 && curl https://x.example')).toMatchObject({ action: "ask", category: "network" });
  });
  it("a project's own nvm.sh is not a setup step", () => {
    expect(isNodeVersionSetup([".", join(root, "nvm.sh")], root)).toBe(false);
    expect(isNodeVersionSetup([".", "./nvm.sh"], root)).toBe(false);
    expect(cls(`. ${join(root, "nvm.sh")} && npm test`).action).toBe("ask");
  });
  it("selecting a version alone asks", () => {
    expect(cls("nvm use 22")).toMatchObject({ action: "ask" });
    expect(cls('. "/Users/me/.nvm/nvm.sh" && nvm use 22')).toMatchObject({ action: "ask" });
  });
  it("installing a version asks as an install", () => {
    expect(cls('. "/Users/me/.nvm/nvm.sh" && nvm install 22')).toMatchObject({ action: "ask", category: "install" });
    expect(cls("fnm install 22")).toMatchObject({ action: "ask", category: "install" });
    expect(cls("volta fetch node@22")).toMatchObject({ action: "ask", category: "install" });
    expect(cls("mise install node@22")).toMatchObject({ action: "ask", category: "install" });
    expect(cls("asdf install nodejs latest:22")).toMatchObject({ action: "ask", category: "install" });
    expect(cls("brew install node@22")).toMatchObject({ action: "ask", category: "install" });
  });
  it("exec wrappers are judged by what they run", () => {
    expect(cls("fnm exec --using=22 npm test")).toMatchObject({ action: "run", category: "dev" });
    expect(cls("fnm exec --using 22 -- npx vitest run")).toMatchObject({ action: "run", category: "dev" });
    expect(cls("nvm exec 22 npm test")).toMatchObject({ action: "run", category: "dev" });
    expect(cls("fnm exec --using=22 git push")).toMatchObject({ action: "ask", category: "push" });
    expect(cls("asdf exec npm test")).toMatchObject({ action: "run", category: "dev" });
  });
  it("volta run and mise exec may download a version: they ask", () => {
    expect(cls("volta run --node 22 npm test")).toMatchObject({ action: "ask", category: "install" });
    expect(cls("mise exec node@22 -- npm test")).toMatchObject({ action: "ask", category: "install" });
    expect(cls("mise exec node@22 -- sudo ls")).toMatchObject({ action: "refuse" });
  });
  it("in Auto a wrapped test runs; in Manual it asks and stays approvable", () => {
    const cmd = 'PATH="/Users/me/.nvm/versions/node/v22.12.0/bin:$PATH" npm test';
    expect(decideToolCall("run_shell", { command: cmd }, { mode: "auto", root }).action).toBe("run");
    expect(decideToolCall("run_shell", { command: cmd }, { mode: "ask", root }).action).toBe("ask");
  });
  it("the executor runs an approved PATH-prefixed command through the shell", () => {
    expect(evaluateShellCommand('PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm ci', { approved: true })).toMatchObject({ allowed: true, useShell: true });
    expect(evaluateShellCommand('PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm ci', { approved: false }).allowed).toBe(false);
    expect(evaluateShellCommand("npm ci", { approved: true })).toMatchObject({ allowed: true, useShell: false });
  });
});
