import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// deploy/gpu-agent: the GPU VM bootstrap and the inference-only container entrypoint
// (runbook: deploy/gpu-agent/README.md). The Dockerfile itself is checked in dockerfiles.test.ts.
const root = resolve(__dirname, "../..");
const BOOTSTRAP = resolve(root, "deploy/gpu-agent/vm-bootstrap.sh");
const ENTRYPOINT = resolve(root, "deploy/gpu-agent/inference-entrypoint.sh");
const read = (p: string) => readFileSync(p, "utf8");
const code = (p: string) => read(p).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

describe("deploy/gpu-agent/vm-bootstrap.sh", () => {
  it("parses (bash -n) and stops on errors", () => {
    execFileSync("bash", ["-n", BOOTSTRAP]);
    expect(read(BOOTSTRAP)).toMatch(/^set -euo pipefail$/m);
  });

  it("pipes nothing it downloads into a shell, and pipes no download at all", () => {
    const src = code(BOOTSTRAP);
    expect(src).not.toMatch(/\|\s*(sudo\s+)?(ba|z|da)?sh\b/);
    expect(src).not.toMatch(/\b(ba)?sh\s+(-c\s+)?["']?\$\(\s*(curl|wget)/);
    expect(src).not.toMatch(/\bwget\b/);
    // Every curl writes to a file (fetch() -o) that is checked before use.
    for (const line of src.split("\n").filter((l) => /\bcurl\s+-/.test(l))) expect(line).toMatch(/-o "\$2"/);
  });

  it("pins Docker's repo key to the fingerprint deploy/install.sh and docs/install.md use, and checks it before trusting it", () => {
    const src = read(BOOTSTRAP);
    const pin = /^DOCKER_REPO_FINGERPRINT=([0-9A-F]{40})$/m.exec(src)?.[1];
    expect(pin).toBeDefined();
    expect(read(resolve(root, "deploy/install.sh"))).toContain(`DOCKER_REPO_FINGERPRINT=${pin}`);
    expect(read(resolve(root, "docs/install.md"))).toContain(pin!.replace(/(.{4})(?!$)/g, "$1 "));
    expect(src.indexOf('[ "$fpr" = "$DOCKER_REPO_FINGERPRINT" ]')).toBeGreaterThan(0);
    expect(src.indexOf('[ "$fpr" = "$DOCKER_REPO_FINGERPRINT" ]')).toBeLessThan(src.indexOf("signed-by=$keyring"));
  });

  it("installs through deploy/install.sh with the docker sandbox, never installs a driver", () => {
    const src = code(BOOTSTRAP);
    expect(src).toMatch(/bash "\$INSTALL_SH" "\$\{args\[@\]\}"/);
    expect(src).toMatch(/--sandbox docker/);
    expect(src).not.toMatch(/apt-get install[^\n]*nvidia-driver|ubuntu-drivers (install|autoinstall)/);
  });

  it("keeps secrets out of argv and output", () => {
    const src = code(BOOTSTRAP);
    // The API key and tokens go to the installer through its environment only.
    expect(src).not.toMatch(/--enroll\b|--token\b|--mesh-token\b/);
    expect(src).not.toMatch(/\benv\b[^\n]*EDGECODER_API_KEY=/);
    for (const line of src.split("\n").filter((l) => /\b(echo|printf)\b/.test(l))) {
      expect(line).not.toMatch(/\$\{?(EDGECODER_ENROLL_KEY|EDGECODER_API_KEY|MESH_AUTH_TOKEN|EDGECODER_MESH_TOKEN|EDGECODER_REGISTRATION_TOKEN|token)\b/);
    }
  });

  it("accepts only plain https service URLs", () => {
    const check = (url: string) =>
      spawnSync("bash", ["-c", `. "${BOOTSTRAP}"; check_url TEST_URL "$1"`, "_", url], { env: { PATH: process.env.PATH, EDGECODER_BOOTSTRAP_LIB: "1" }, encoding: "utf8" }).status;
    expect(check("https://coordinator.example.org")).toBe(0);
    expect(check("https://coordinator.example.org:8443/base")).toBe(0);
    for (const bad of ["http://coordinator.example.org", "", "https://x.example.org/$(id)", "https://x.example.org\nEVIL=1", "https://x.example.org/a b"]) {
      expect(check(bad), JSON.stringify(bad)).not.toBe(0);
    }
  });

  // GNU sed -i and the env-file layout edgecoder-install writes: Linux only.
  it.skipIf(process.platform !== "linux")("switches the agent env files to the local Ollama and restarts the agents once", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpu-bootstrap-"));
    try {
      writeFileSync(join(dir, "agent-0.env"), "AGENT_ID=a-gpu0\nLOCAL_MODEL_PROVIDER=edgecoder-local\nAGENT_REGISTRATION_TOKEN=secret\n");
      writeFileSync(join(dir, "agent-1.env"), "AGENT_ID=a-gpu1\n");
      const run = () =>
        spawnSync(
          "bash",
          ["-c", `. "${BOOTSTRAP}"; ENV_DIR="$1"; systemctl() { if [ "$1" = list-unit-files ]; then echo "edgecoder-agent-0.service enabled"; else echo "systemctl $*" >> "$ENV_DIR/calls"; fi; }; use_local_ollama`, "_", dir],
          { env: { PATH: process.env.PATH, EDGECODER_BOOTSTRAP_LIB: "1" }, encoding: "utf8" }
        );
      expect(run().status).toBe(0);
      expect(read(join(dir, "agent-0.env"))).toBe("AGENT_ID=a-gpu0\nLOCAL_MODEL_PROVIDER=ollama-local\nAGENT_REGISTRATION_TOKEN=secret\n");
      expect(read(join(dir, "agent-1.env"))).toBe("AGENT_ID=a-gpu1\nLOCAL_MODEL_PROVIDER=ollama-local\n");
      expect(read(join(dir, "calls"))).toBe("systemctl restart edgecoder-agent-0.service\n");
      // Already applied: nothing changes and nothing restarts.
      expect(run().status).toBe(0);
      expect(read(join(dir, "calls"))).toBe("systemctl restart edgecoder-agent-0.service\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("deploy/gpu-agent/inference-entrypoint.sh", () => {
  it("parses (sh -n)", () => {
    execFileSync("sh", ["-n", ENTRYPOINT]);
  });

  it("refuses to start without its settings or with a sandbox mode it cannot provide, printing no secret", () => {
    const run = (env: Record<string, string>) => spawnSync("sh", [ENTRYPOINT, "true"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, encoding: "utf8" });
    const ok = { COORDINATOR_URL: "https://c.example.org", AGENT_ID: "vast-gpu-1", AGENT_REGISTRATION_TOKEN: "s3cr3t-token-value" };
    expect(run({ ...ok, COORDINATOR_URL: "" }).stderr).toMatch(/COORDINATOR_URL is not set/);
    expect(run({ ...ok, COORDINATOR_URL: "http://c.example.org" }).stderr).toMatch(/must be https/);
    expect(run({ ...ok, AGENT_ID: "" }).stderr).toMatch(/AGENT_ID is not set/);
    expect(run({ ...ok, AGENT_REGISTRATION_TOKEN: "" }).stderr).toMatch(/AGENT_REGISTRATION_TOKEN is not set/);
    const docker = run({ ...ok, SANDBOX_MODE: "docker" });
    expect(docker.status).not.toBe(0);
    expect(docker.stderr).toMatch(/SANDBOX_MODE=docker in the inference-only image/);
    expect(docker.stdout + docker.stderr).not.toContain("s3cr3t-token-value");
  });

  it("EDGECODER_SKIP_CHECKS=1 runs the given command directly", () => {
    const r = spawnSync("sh", [ENTRYPOINT, "echo", "direct"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", EDGECODER_SKIP_CHECKS: "1" }, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("direct\n");
  });
});
