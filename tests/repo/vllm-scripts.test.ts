import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VLLM_PROFILES, vllmDropInPath, vllmMarkerPath } from "../../src/install/engine.js";

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
  it("is sandboxed like the Ollama unit; --start holds that instance's Ollama off first, with edgecoder-install's marker and drop-in, never a mask (no Conflicts=: the agent unit Wants= it)", () => {
    expect(unit).not.toMatch(/^Conflicts=/m);
    const src = code(INSTALL);
    // A mask is lifted by the next edgecoder-install run (it rewrites the unit file): marker + ConditionPathExists instead.
    expect(src).not.toMatch(/systemctl mask/);
    expect(src).toContain('marker="$ETC/vllm-$instance.active"');
    expect(src).toContain('dropin="/etc/systemd/system/edgecoder-ollama-$instance.service.d/vllm-switch.conf"');
    expect(src).toContain("ConditionPathExists=!%s");
    const off = src.indexOf('systemctl disable --now "edgecoder-ollama-$instance.service"');
    expect(off).toBeGreaterThan(0);
    expect(off).toBeLessThan(src.indexOf('systemctl restart "edgecoder-vllm@$instance.service"'));
    for (const k of ["NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes"]) expect(unit).toContain(k);
    expect(unit).toMatch(/^ReadWritePaths=\/var\/lib\/edgecoder\/vllm \/var\/lib\/edgecoder\/hf$/m);
  });
  it("edgecoder-install's vLLM profiles and switch files match the script's", () => {
    const src = read(INSTALL);
    for (const [name, p] of Object.entries(VLLM_PROFILES)) {
      const block = new RegExp(`\\n  ${name.replace("-", "\\-")}\\)\\n([\\s\\S]*?);;`).exec(src)?.[1] ?? "";
      expect(block, name).toContain(`model="\${model:-${p.model}}"`);
      expect(block, name).toMatch(new RegExp(`^\\s*slots=${p.slots}$`, "m"));
    }
    expect(vllmMarkerPath("/etc/edgecoder", 0)).toBe("/etc/edgecoder/vllm-0.active");
    expect(vllmDropInPath(0)).toBe("/etc/systemd/system/edgecoder-ollama-0.service.d/vllm-switch.conf");
  });
  it("single-card profiles are tensor parallel 1 on GPU 0, and their KV cache fits a full-length call with headroom", () => {
    // Qwen3-Coder-30B-A3B: KV 96 KiB per token at bf16 (48 layers x 4 KV heads x 128 x 2 x 2 bytes).
    const KV_BYTES_PER_TOKEN = 48 * 4 * 128 * 2 * 2;
    const WEIGHTS_GB: Record<string, number> = { "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ": 17, "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8": 31 };
    // The smallest card --vllm-profile auto gives each profile (nvidia-smi GiB), and ~3 GB for activations and CUDA graphs.
    const SMALLEST_CARD_GB: Record<string, number> = { "gpu-24gb": 22.5 * 1.074, "a100-40": 40, "gpu-48gb": 45 * 1.074, "a100-80": 80 };
    const OVERHEAD_GB = 3;
    const src = read(INSTALL);
    for (const [name, card] of Object.entries(SMALLEST_CARD_GB)) {
      const block = new RegExp(`\\n  ${name.replace("-", "\\-")}\\)\\n([\\s\\S]*?);;`).exec(src)?.[1] ?? "";
      expect(block, name).toContain('gpus="${gpus:-0}"');
      expect(block, name).not.toContain("--tensor-parallel-size");
      const util = Number(/--gpu-memory-utilization ([\d.]+)/.exec(block)?.[1]);
      const maxLen = Number(/--max-model-len (\d+)/.exec(block)?.[1]);
      const kvGb = card * util - WEIGHTS_GB[VLLM_PROFILES[name].model] - OVERHEAD_GB;
      const kvTokens = (kvGb * 1e9) / KV_BYTES_PER_TOKEN;
      expect(kvTokens, name).toBeGreaterThan(maxLen * 1.5);
      // Slots: never more than ~2x the full-length calls the cache holds (vLLM preempts past that).
      expect(VLLM_PROFILES[name].slots, name).toBeLessThanOrEqual(Math.max(1, Math.ceil((2 * kvTokens) / maxLen)));
    }
  });

  it("the env example matches the installer's a16x2 profile", () => {
    const env = read(ENV);
    const args = /^VLLM_ARGS="([^"]+)"$/m.exec(env)?.[1];
    expect(args).toBeDefined();
    expect(read(INSTALL)).toContain(`args="\${args:-${args}}"`);
  });
});
