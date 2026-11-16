import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// scripts/linux/vllm: the vLLM installer and its systemd unit (docs/inference-engines.md).
const root = resolve(__dirname, "../..");
const INSTALL = resolve(root, "scripts/linux/vllm/install-vllm.sh");
const UNIT = resolve(root, "scripts/linux/vllm/edgecoder-vllm@.service");
const ENV = resolve(root, "scripts/linux/vllm/vllm.env.example");
const read = (p: string) => readFileSync(p, "utf8");
const code = (p: string) => read(p).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

describe("install-vllm.sh", () => {
  it("parses, stops on errors, pins the vLLM version", () => {
    execFileSync("bash", ["-n", INSTALL]);
    expect(read(INSTALL)).toMatch(/^set -euo pipefail$/m);
    expect(read(INSTALL)).toMatch(/^VLLM_VERSION="\$\{VLLM_VERSION:-\d+\.\d+\.\d+\}"$/m);
  });

  it("pipes no download into a shell and never installs a driver", () => {
    const src = code(INSTALL);
    expect(src).not.toMatch(/\|\s*(sudo\s+)?(ba|z|da)?sh\b/);
    expect(src).not.toMatch(/\bwget\b/);
    expect(src).not.toMatch(/nvidia-driver|cuda-drivers|ubuntu-drivers/);
  });

  it("refuses bad input before touching the system", () => {
    const run = (...args: string[]) => spawnSync("bash", [INSTALL, ...args], { encoding: "utf8" });
    expect(run("--profile", "h100").stderr).toMatch(/unknown profile/);
    expect(run("--profile", "a16x2", "--instance", "x").stderr).toMatch(/--instance must be a number/);
    expect(run("--model", "a/b", "--gpus", "0", "--args", "--x $(id)").stderr).toMatch(/may not contain/);
    expect(run("--model", "a/b; rm", "--gpus", "0", "--args", "--x").stderr).toMatch(/--model must be/);
  });

  it("the a16x2 profile serves the AWQ build over both cards with the qwen3-coder tool parser", () => {
    const src = read(INSTALL);
    expect(src).toContain("QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ");
    expect(src).toMatch(/--tensor-parallel-size 2 --max-model-len 65536 .*--enable-prefix-caching --enable-auto-tool-choice --tool-call-parser qwen3_xml/);
  });
});

describe("edgecoder-vllm@.service", () => {
  const unit = read(UNIT);
  it("runs vLLM on loopback as the edgecoder user, from the instance's env file", () => {
    expect(unit).toMatch(/^User=edgecoder$/m);
    expect(unit).toMatch(/^EnvironmentFile=\/etc\/edgecoder\/vllm-%i\.env$/m);
    expect(unit).toMatch(/^ExecStart=\/opt\/edgecoder\/vllm\/venv\/bin\/vllm serve \$\{VLLM_MODEL_ID\} --host 127\.0\.0\.1 --port \$\{VLLM_PORT\} \$VLLM_ARGS$/m);
  });
  it("is sandboxed like the Ollama unit; --start stops and masks that instance's Ollama first (no Conflicts=: the agent unit Wants= it)", () => {
    expect(unit).not.toMatch(/^Conflicts=/m);
    const src = code(INSTALL);
    expect(src.indexOf('systemctl mask "edgecoder-ollama-$instance.service"')).toBeGreaterThan(0);
    expect(src.indexOf('systemctl mask "edgecoder-ollama-$instance.service"')).toBeLessThan(src.indexOf('systemctl restart "edgecoder-vllm@$instance.service"'));
    for (const k of ["NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes"]) expect(unit).toContain(k);
    expect(unit).toMatch(/^ReadWritePaths=\/var\/lib\/edgecoder\/vllm \/var\/lib\/edgecoder\/hf$/m);
  });
  it("the env example matches the installer's a16x2 profile", () => {
    const env = read(ENV);
    const args = /^VLLM_ARGS="([^"]+)"$/m.exec(env)?.[1];
    expect(args).toBeDefined();
    expect(read(INSTALL)).toContain(`args="\${args:-${args}}"`);
  });
});
