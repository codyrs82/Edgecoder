import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INSTALL_COMMANDS, INSTALL_OPTIONS } from "../../src/install/options.js";

/**
 * Every platform entry point must end in the shared installer, and the docs must list every
 * option it accepts. A platform-specific feature that is not in src/install/options.ts fails here.
 */
const ENTRY_POINTS = [
  "deploy/install.sh",
  "deploy/install.ps1",
  "scripts/linux/package-scripts/postinst",
  "scripts/macos/package-scripts/postinstall",
  "scripts/windows/payload/bin/edgecoder-configure.ps1"
];

describe("installer parity across macOS, Linux and Windows", () => {
  it("each platform entry point runs dist/install/cli.js", () => {
    for (const file of ENTRY_POINTS) {
      const text = readFileSync(file, "utf8");
      expect(text, file).toMatch(/dist[\\/]+install[\\/]+cli\.js/);
    }
  });

  it("the bootstraps pass every option through unchanged", () => {
    expect(readFileSync("deploy/install.sh", "utf8")).toContain('apply --app-dir "$INSTALL_DIR" "$@"');
    expect(readFileSync("deploy/install.ps1", "utf8")).toContain("apply --app-dir $InstallDir @InstallerArgs");
  });

  it("docs/install.md documents every command and option", () => {
    const doc = readFileSync("docs/install.md", "utf8");
    for (const c of INSTALL_COMMANDS) expect(doc, c.name).toContain("`" + c.name + "`");
    for (const o of INSTALL_OPTIONS) expect(doc, o.flag).toContain("`" + o.flag);
  });
});
