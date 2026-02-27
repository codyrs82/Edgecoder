import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that transitively pulls them in.
// ---------------------------------------------------------------------------

const mockMigrate = vi.fn().mockResolvedValue(undefined);
const mockEnsureOllama = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/db/store.js", () => ({
  pgStore: { migrate: mockMigrate }
}));

vi.mock("../../src/model/ollama-installer.js", () => ({
  ensureOllamaModelInstalled: mockEnsureOllama
}));

// ---------------------------------------------------------------------------
// We cannot import `bootstrapCoordinator` directly because the module
// immediately calls it at import time (top-level side-effect).  Instead we
// use `vi.importActual` to dynamically load the module inside each test
// after the environment variables are configured.
//
// To prevent the top-level `process.exit(1)` from killing the test runner,
// we also spy on `process.exit`.
// ---------------------------------------------------------------------------

let exitSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(vars)) {
    savedEnv[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function loadCoordinatorModule() {
  // Reset the module registry so mocks are re-wired and the top-level call executes again
  vi.resetModules();

  // Re-apply the mocks after resetModules (vi.mock hoisting still applies)
  // We need to actually import the module to trigger the top-level bootstrapCoordinator()
  try {
    await import("../../src/bootstrap/coordinator.js");
  } catch {
    // process.exit stub may throw — that is expected
  }

  // Give any micro-tasks a chance to complete
  await new Promise((resolve) => setTimeout(resolve, 50));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("coordinator bootstrap", () => {
  beforeEach(() => {
    mockMigrate.mockReset().mockResolvedValue(undefined);
    mockEnsureOllama.mockReset().mockResolvedValue(undefined);

    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Start with a clean environment for the variables the module reads
    setEnv({
      LOCAL_MODEL_PROVIDER: undefined,
      OLLAMA_AUTO_INSTALL: undefined,
      OLLAMA_MODEL: undefined,
      AGENT_OS: undefined,
      OLLAMA_HOST: undefined
    });
  });

  afterEach(() => {
    restoreEnv();
    exitSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  // ---- Startup sequence ----

  it("runs database migration when pgStore is available", async () => {
    await loadCoordinatorModule();
    expect(mockMigrate).toHaveBeenCalledOnce();
  });

  it("calls ensureOllamaModelInstalled with default values", async () => {
    await loadCoordinatorModule();

    expect(mockEnsureOllama).toHaveBeenCalledOnce();
    const opts = mockEnsureOllama.mock.calls[0][0];
    expect(opts).toMatchObject({
      enabled: false, // default provider is "edgecoder-local", not "ollama-local"
      autoInstall: false, // OLLAMA_AUTO_INSTALL not set
      model: "qwen2.5:7b",
      role: "coordinator",
      platform: "macos"
    });
  });

  it("logs success JSON on completion", async () => {
    await loadCoordinatorModule();

    expect(consoleLogSpy).toHaveBeenCalled();
    const logged = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(logged.ok).toBe(true);
    expect(logged.database).toBe("postgres_ready");
  });

  it("does not call process.exit on success", async () => {
    await loadCoordinatorModule();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ---- Configuration validation ----

  it("enables ollama when LOCAL_MODEL_PROVIDER is ollama-local", async () => {
    setEnv({ LOCAL_MODEL_PROVIDER: "ollama-local" });
    await loadCoordinatorModule();

    const opts = mockEnsureOllama.mock.calls[0][0];
    expect(opts.enabled).toBe(true);
  });

  it("enables auto-install when OLLAMA_AUTO_INSTALL is 'true'", async () => {
    setEnv({ OLLAMA_AUTO_INSTALL: "true" });
    await loadCoordinatorModule();

    const opts = mockEnsureOllama.mock.calls[0][0];
    expect(opts.autoInstall).toBe(true);
  });

  it("respects custom OLLAMA_MODEL", async () => {
    setEnv({ OLLAMA_MODEL: "codellama:13b" });
    await loadCoordinatorModule();

    const opts = mockEnsureOllama.mock.calls[0][0];
    expect(opts.model).toBe("codellama:13b");
  });

  it("respects custom AGENT_OS", async () => {
    setEnv({ AGENT_OS: "debian" });
    await loadCoordinatorModule();

    const opts = mockEnsureOllama.mock.calls[0][0];
    expect(opts.platform).toBe("debian");
  });

  it("passes OLLAMA_HOST to installer when set", async () => {
    setEnv({ OLLAMA_HOST: "http://192.168.1.50:11434" });
    await loadCoordinatorModule();

    const opts = mockEnsureOllama.mock.calls[0][0];
    expect(opts.host).toBe("http://192.168.1.50:11434");
  });

  it("passes undefined OLLAMA_HOST when not set", async () => {
    await loadCoordinatorModule();

    const opts = mockEnsureOllama.mock.calls[0][0];
    expect(opts.host).toBeUndefined();
  });

  it("logs provider in output", async () => {
    setEnv({ LOCAL_MODEL_PROVIDER: "ollama-local" });
    await loadCoordinatorModule();

    const logged = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(logged.provider).toBe("ollama-local");
  });

  it("logs ollamaAutoInstall=true when enabled", async () => {
    setEnv({ OLLAMA_AUTO_INSTALL: "true" });
    await loadCoordinatorModule();

    const logged = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(logged.ollamaAutoInstall).toBe(true);
  });

  // ---- Graceful degradation when optional services are unavailable ----

  it("calls process.exit(1) and logs error when ollama installer throws", async () => {
    mockEnsureOllama.mockRejectedValue(new Error("ollama binary not found"));

    await loadCoordinatorModule();

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("calls process.exit(1) when database migration fails", async () => {
    mockMigrate.mockRejectedValue(new Error("ECONNREFUSED postgres"));

    await loadCoordinatorModule();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Test the pgStore=null branch.
// We need a separate describe because the mock setup differs.
// ---------------------------------------------------------------------------

describe("coordinator bootstrap — database disabled", () => {
  beforeEach(() => {
    vi.resetModules();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    restoreEnv();
    exitSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("skips migration and reports database_disabled when pgStore is null", async () => {
    // Override the db/store mock to return null
    vi.doMock("../../src/db/store.js", () => ({ pgStore: null }));
    vi.doMock("../../src/model/ollama-installer.js", () => ({
      ensureOllamaModelInstalled: vi.fn().mockResolvedValue(undefined)
    }));

    try {
      await import("../../src/bootstrap/coordinator.js");
    } catch {
      // ignored
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(consoleLogSpy).toHaveBeenCalled();
    const logged = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(logged.database).toBe("database_disabled");
    expect(logged.ok).toBe(true);
  });
});
