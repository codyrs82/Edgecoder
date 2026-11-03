import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OLLAMA_PORTS,
  blockingErrors,
  componentLine,
  formatBytes,
  needsManualOllama,
  needsSetupScreen,
  ollamaBaseFor,
  progressPercent,
  type ComponentStatus,
  type ComputeStatus,
} from "../src/lib/local-compute";

const comp = (over: Partial<ComponentStatus> = {}): ComponentStatus => ({
  state: "pending",
  source: "",
  version: "",
  detail: "",
  activity: "",
  downloaded: 0,
  total: 0,
  error: null,
  required: true,
  ...over,
});

const status = (over: Partial<ComputeStatus> = {}): ComputeStatus => ({
  managed: true,
  state: "running",
  ollama: comp(),
  docker: comp(),
  ollama_url: "http://127.0.0.1:11434",
  docker_host: null,
  ...over,
});

describe("local compute: Ollama base URL", () => {
  it("uses the shell's loopback URL on an allowed port", () => {
    expect(ollamaBaseFor(status({ ollama_url: "http://127.0.0.1:11435" }))).toBe("http://127.0.0.1:11435");
    expect(ollamaBaseFor(status({ ollama_url: "http://localhost:11434/" }))).toBe("http://localhost:11434");
  });

  it("falls back to the default for anything else", () => {
    for (const bad of ["https://evil.example:11434", "http://10.0.0.5:11434", "http://127.0.0.1:8080", "not a url", "", "file:///x"]) {
      expect(ollamaBaseFor(status({ ollama_url: bad })), bad).toBe("http://localhost:11434");
    }
    expect(ollamaBaseFor(null)).toBe("http://localhost:11434");
  });

  it("only uses ports the release CSP allows", () => {
    const conf = JSON.parse(readFileSync(resolve(__dirname, "../src-tauri/tauri.conf.json"), "utf8"));
    const connect = String(conf.app.security.csp["connect-src"]);
    for (const port of OLLAMA_PORTS) {
      expect(connect).toContain(`http://127.0.0.1:${port}`);
      expect(connect).toContain(`http://localhost:${port}`);
    }
  });
});

describe("local compute: progress", () => {
  it("reports a percentage only while downloading with a known size", () => {
    expect(progressPercent(comp({ state: "downloading", downloaded: 50, total: 200 }))).toBe(25);
    expect(progressPercent(comp({ state: "downloading", downloaded: 300, total: 200 }))).toBe(100);
    expect(progressPercent(comp({ state: "downloading", downloaded: 5, total: 0 }))).toBeNull();
    expect(progressPercent(comp({ state: "starting", downloaded: 5, total: 10 }))).toBeNull();
  });

  it("formats sizes", () => {
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(186_689_993)).toBe("178 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });

  it("describes each state in one line", () => {
    expect(componentLine(comp({ state: "downloading", detail: "Downloading ollama 0.40.13", downloaded: 1024 ** 2 * 10, total: 1024 ** 2 * 100 }))).toBe(
      "Downloading ollama 0.40.13 (10 MB of 100 MB)",
    );
    expect(componentLine(comp({ state: "error", error: "Ollama exited" }))).toBe("Ollama exited");
    expect(componentLine(comp({ state: "ready", detail: "Ollama 0.40.13 is running" }))).toBe("Ollama 0.40.13 is running");
    expect(componentLine(comp({ state: "ready", version: "1.2.3" }))).toBe("Running (1.2.3)");
    expect(componentLine(comp({ state: "starting", detail: "Starting the Docker VM" }))).toBe("Starting the Docker VM");
  });
});

describe("local compute: setup screen", () => {
  it("shows until ready", () => {
    expect(needsSetupScreen(null)).toBe(false);
    expect(needsSetupScreen(status({ state: "running" }))).toBe(true);
    expect(needsSetupScreen(status({ state: "error" }))).toBe(true);
    expect(needsSetupScreen(status({ state: "ready" }))).toBe(false);
  });

  it("lists only blocking errors", () => {
    const s = status({
      state: "error",
      ollama: comp({ state: "error", error: "Download failed" }),
      docker: comp({ state: "error", error: "Docker isn't running", required: false }),
    });
    expect(blockingErrors(s)).toEqual(["Download failed"]);
  });

  it("offers the Ollama download page only where nothing is managed", () => {
    const broken = { ollama: comp({ state: "error", error: "Ollama isn't installed" }) };
    expect(needsManualOllama(status({ managed: false, ...broken }))).toBe(true);
    expect(needsManualOllama(status({ managed: true, ...broken }))).toBe(false);
  });
});
