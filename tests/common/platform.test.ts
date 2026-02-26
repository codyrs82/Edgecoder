import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  detectPlatform,
  detectOS,
  detectArch,
  isDockerEnvironment,
  isWSL,
  hasSystemd,
  getPackageManager,
  detectShell,
  getConfigDir,
  getLogDir,
  getDataDir,
  type PlatformOverrides,
  type PlatformInfo,
} from "../../src/common/platform.js";

// ---------------------------------------------------------------------------
// Helpers — overrides that simulate each platform
// ---------------------------------------------------------------------------

const linuxOverrides: PlatformOverrides = {
  platform: "linux",
  arch: "x64",
  env: { SHELL: "/bin/bash", XDG_CONFIG_HOME: "/home/user/.config", XDG_STATE_HOME: "/home/user/.local/state", XDG_DATA_HOME: "/home/user/.local/share" },
  fileExists: () => false,
  fileRead: () => "",
  commandExists: (cmd: string) => ["bash", "apt-get", "systemctl"].includes(cmd),
  homeDir: "/home/user",
};

const macosOverrides: PlatformOverrides = {
  platform: "darwin",
  arch: "arm64",
  env: { SHELL: "/bin/zsh" },
  fileExists: () => false,
  fileRead: () => "",
  commandExists: (cmd: string) => ["zsh", "brew"].includes(cmd),
  homeDir: "/Users/testuser",
};

const windowsOverrides: PlatformOverrides = {
  platform: "win32",
  arch: "x64",
  env: {
    SHELL: undefined,
    PSModulePath: "C:\\Program Files\\WindowsPowerShell\\Modules",
    APPDATA: "C:\\Users\\test\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
  },
  fileExists: () => false,
  fileRead: () => "",
  commandExists: (cmd: string) => cmd === "choco",
  homeDir: "C:\\Users\\test",
};

// ---------------------------------------------------------------------------
// detectPlatform — aggregate
// ---------------------------------------------------------------------------

describe("detectPlatform", () => {
  it("returns a valid PlatformInfo for Linux overrides", () => {
    const info: PlatformInfo = detectPlatform(linuxOverrides);
    expect(info.os).toBe("linux");
    expect(info.arch).toBe("x64");
    expect(info.isDocker).toBe(false);
    expect(info.isWSL).toBe(false);
    expect(info.hasSystemd).toBe(true);
    expect(info.packageManager).toBe("apt");
    expect(info.shell).toBe("bash");
  });

  it("returns a valid PlatformInfo for macOS overrides", () => {
    const info = detectPlatform(macosOverrides);
    expect(info.os).toBe("macos");
    expect(info.arch).toBe("arm64");
    expect(info.isDocker).toBe(false);
    expect(info.isWSL).toBe(false);
    expect(info.hasSystemd).toBe(false);
    expect(info.packageManager).toBe("brew");
    expect(info.shell).toBe("zsh");
  });

  it("returns a valid PlatformInfo for Windows overrides", () => {
    const info = detectPlatform(windowsOverrides);
    expect(info.os).toBe("windows");
    expect(info.arch).toBe("x64");
    expect(info.isDocker).toBe(false);
    expect(info.isWSL).toBe(false);
    expect(info.hasSystemd).toBe(false);
    expect(info.packageManager).toBe("choco");
    expect(info.shell).toBe("powershell");
  });

  it("returns valid PlatformInfo without overrides (real host)", () => {
    const info = detectPlatform();
    expect(["macos", "linux", "windows", "ios", "android"]).toContain(info.os);
    expect(["x64", "arm64", "arm"]).toContain(info.arch);
    expect(typeof info.isDocker).toBe("boolean");
    expect(typeof info.isWSL).toBe("boolean");
    expect(typeof info.hasSystemd).toBe("boolean");
    expect(["apt", "dnf", "brew", "choco", "none"]).toContain(info.packageManager);
    expect(["bash", "zsh", "powershell", "cmd"]).toContain(info.shell);
  });
});

// ---------------------------------------------------------------------------
// detectOS
// ---------------------------------------------------------------------------

describe("detectOS", () => {
  it("maps darwin to macos", () => {
    expect(detectOS({ platform: "darwin" })).toBe("macos");
  });

  it("maps win32 to windows", () => {
    expect(detectOS({ platform: "win32" })).toBe("windows");
  });

  it("maps linux to linux", () => {
    expect(detectOS({ platform: "linux" })).toBe("linux");
  });

  it("maps android to android", () => {
    expect(detectOS({ platform: "android" as NodeJS.Platform })).toBe("android");
  });

  it("falls back to linux for unknown platforms", () => {
    expect(detectOS({ platform: "freebsd" as NodeJS.Platform })).toBe("linux");
  });
});

// ---------------------------------------------------------------------------
// detectArch
// ---------------------------------------------------------------------------

describe("detectArch", () => {
  it("returns x64 for x64", () => {
    expect(detectArch({ arch: "x64" })).toBe("x64");
  });

  it("returns arm64 for arm64", () => {
    expect(detectArch({ arch: "arm64" })).toBe("arm64");
  });

  it("returns arm for arm", () => {
    expect(detectArch({ arch: "arm" })).toBe("arm");
  });

  it("falls back to x64 for unknown architectures", () => {
    expect(detectArch({ arch: "mips" as NodeJS.Architecture })).toBe("x64");
  });
});

// ---------------------------------------------------------------------------
// isDockerEnvironment
// ---------------------------------------------------------------------------

describe("isDockerEnvironment", () => {
  it("returns true when /.dockerenv exists", () => {
    expect(isDockerEnvironment({
      fileExists: (p: string) => p === "/.dockerenv",
      fileRead: () => "",
    })).toBe(true);
  });

  it("returns true when /proc/1/cgroup mentions docker", () => {
    expect(isDockerEnvironment({
      fileExists: () => false,
      fileRead: (p: string) => p === "/proc/1/cgroup" ? "12:memory:/docker/abc123" : "",
    })).toBe(true);
  });

  it("returns true when /proc/1/cgroup mentions containerd", () => {
    expect(isDockerEnvironment({
      fileExists: () => false,
      fileRead: (p: string) => p === "/proc/1/cgroup" ? "0::/system.slice/containerd.service" : "",
    })).toBe(true);
  });

  it("returns false when no Docker markers present", () => {
    expect(isDockerEnvironment({
      fileExists: () => false,
      fileRead: () => "",
    })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isWSL
// ---------------------------------------------------------------------------

describe("isWSL", () => {
  it("returns true when /proc/version contains Microsoft", () => {
    expect(isWSL({
      fileRead: (p: string) =>
        p === "/proc/version"
          ? "Linux version 5.15.146.1-microsoft-standard-WSL2"
          : "",
    })).toBe(true);
  });

  it("returns true when /proc/version contains WSL (case-insensitive)", () => {
    expect(isWSL({
      fileRead: (p: string) =>
        p === "/proc/version" ? "Linux version 5.15.146.1-wsl2" : "",
    })).toBe(true);
  });

  it("returns false on plain Linux", () => {
    expect(isWSL({
      fileRead: (p: string) =>
        p === "/proc/version" ? "Linux version 6.5.0-14-generic" : "",
    })).toBe(false);
  });

  it("returns false when file is empty", () => {
    expect(isWSL({ fileRead: () => "" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasSystemd
// ---------------------------------------------------------------------------

describe("hasSystemd", () => {
  it("returns true when systemctl exists", () => {
    expect(hasSystemd({ commandExists: (cmd) => cmd === "systemctl" })).toBe(true);
  });

  it("returns false when systemctl does not exist", () => {
    expect(hasSystemd({ commandExists: () => false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getPackageManager
// ---------------------------------------------------------------------------

describe("getPackageManager", () => {
  it("detects apt on Linux", () => {
    expect(getPackageManager({
      platform: "linux",
      commandExists: (cmd) => cmd === "apt-get",
    })).toBe("apt");
  });

  it("detects dnf on Linux when apt is absent", () => {
    expect(getPackageManager({
      platform: "linux",
      commandExists: (cmd) => cmd === "dnf",
    })).toBe("dnf");
  });

  it("detects brew on macOS", () => {
    expect(getPackageManager({
      platform: "darwin",
      commandExists: (cmd) => cmd === "brew",
    })).toBe("brew");
  });

  it("detects choco on Windows", () => {
    expect(getPackageManager({
      platform: "win32",
      commandExists: (cmd) => cmd === "choco",
    })).toBe("choco");
  });

  it("returns none when nothing is found", () => {
    expect(getPackageManager({
      platform: "linux",
      commandExists: () => false,
    })).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// detectShell
// ---------------------------------------------------------------------------

describe("detectShell", () => {
  it("detects zsh from SHELL env", () => {
    expect(detectShell({ platform: "darwin", env: { SHELL: "/bin/zsh" } })).toBe("zsh");
  });

  it("detects bash from SHELL env", () => {
    expect(detectShell({ platform: "linux", env: { SHELL: "/usr/bin/bash" } })).toBe("bash");
  });

  it("detects powershell on Windows when PSModulePath is set", () => {
    expect(detectShell({
      platform: "win32",
      env: { PSModulePath: "C:\\something" },
    })).toBe("powershell");
  });

  it("falls back to cmd on Windows without PSModulePath", () => {
    expect(detectShell({ platform: "win32", env: {} })).toBe("cmd");
  });

  it("falls back to bash on Linux when SHELL is unset", () => {
    expect(detectShell({ platform: "linux", env: {} })).toBe("bash");
  });
});

// ---------------------------------------------------------------------------
// getConfigDir
// ---------------------------------------------------------------------------

describe("getConfigDir", () => {
  it("returns XDG-based path on Linux", () => {
    const dir = getConfigDir(linuxOverrides);
    expect(dir).toBe("/home/user/.config/edgecoder");
  });

  it("uses default XDG when XDG_CONFIG_HOME is unset on Linux", () => {
    const dir = getConfigDir({
      ...linuxOverrides,
      env: {},
    });
    expect(dir).toBe("/home/user/.config/edgecoder");
  });

  it("returns Library path on macOS", () => {
    const dir = getConfigDir(macosOverrides);
    expect(dir).toBe("/Users/testuser/Library/Application Support/EdgeCoder");
  });

  it("returns APPDATA path on Windows", () => {
    const dir = getConfigDir(windowsOverrides);
    // path.join uses host-native separators, so compare with join()
    expect(dir).toBe(join("C:\\Users\\test\\AppData\\Roaming", "EdgeCoder"));
  });

  it("falls back to home-based APPDATA on Windows when env is unset", () => {
    const dir = getConfigDir({
      ...windowsOverrides,
      env: {},
    });
    expect(dir).toContain("AppData");
    expect(dir).toContain("EdgeCoder");
  });
});

// ---------------------------------------------------------------------------
// getLogDir
// ---------------------------------------------------------------------------

describe("getLogDir", () => {
  it("returns XDG state-based path on Linux", () => {
    const dir = getLogDir(linuxOverrides);
    expect(dir).toBe("/home/user/.local/state/edgecoder/logs");
  });

  it("returns Library/Logs path on macOS", () => {
    const dir = getLogDir(macosOverrides);
    expect(dir).toBe("/Users/testuser/Library/Logs/EdgeCoder");
  });

  it("returns LOCALAPPDATA path on Windows", () => {
    const dir = getLogDir(windowsOverrides);
    expect(dir).toBe(join("C:\\Users\\test\\AppData\\Local", "EdgeCoder", "logs"));
  });
});

// ---------------------------------------------------------------------------
// getDataDir
// ---------------------------------------------------------------------------

describe("getDataDir", () => {
  it("returns XDG data-based path on Linux", () => {
    const dir = getDataDir(linuxOverrides);
    expect(dir).toBe("/home/user/.local/share/edgecoder");
  });

  it("returns Library/Application Support path on macOS", () => {
    const dir = getDataDir(macosOverrides);
    expect(dir).toBe("/Users/testuser/Library/Application Support/EdgeCoder/data");
  });

  it("returns LOCALAPPDATA path on Windows", () => {
    const dir = getDataDir(windowsOverrides);
    expect(dir).toBe(join("C:\\Users\\test\\AppData\\Local", "EdgeCoder", "data"));
  });
});
