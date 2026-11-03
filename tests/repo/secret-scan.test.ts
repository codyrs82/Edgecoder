import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #3: the secret-scan workflow and its gitleaks config stay in place and well-formed.
// Checked with regexes rather than YAML/TOML libraries to avoid a new dependency.
const root = resolve(__dirname, "../..");
const wf = readFileSync(resolve(root, ".github/workflows/secret-scan.yml"), "utf8").replace(/\r\n/g, "\n");
const toml = readFileSync(resolve(root, ".gitleaks.toml"), "utf8").replace(/\r\n/g, "\n");

describe("secret-scan workflow (#3)", () => {
  it("runs both scanners", () => {
    expect(wf).toMatch(/^\s*-\s*uses: gitleaks\/gitleaks-action@/m);
    expect(wf).toMatch(/^\s*-\s*uses: trufflesecurity\/trufflehog@/m);
  });

  it("pins every action by a 40-char SHA with a tag comment", () => {
    const uses = wf.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
    expect(uses.length).toBeGreaterThanOrEqual(4);
    const bad = uses.filter((l) => !/@[0-9a-f]{40} # v?\d+(\.\d+)*\s*$/.test(l));
    expect(bad).toEqual([]);
  });

  it("does not pin trufflehog to a moving ref", () => {
    expect(wf).not.toMatch(/trufflehog@(main|master|latest)\b/);
  });

  it("runs on pull_request, push to main and workflow_dispatch", () => {
    const on = wf.slice(wf.indexOf("\non:\n"), wf.indexOf("\npermissions:"));
    expect(on).toMatch(/^\s+pull_request:/m);
    expect(on).toMatch(/^\s+workflow_dispatch:/m);
    expect(on).toMatch(/^\s+push:\n\s+branches: \[main\]/m);
  });

  it("checks out full history and points gitleaks at the repo config", () => {
    expect(wf.match(/fetch-depth: 0/g)?.length).toBe(2);
    expect(wf).toMatch(/GITLEAKS_CONFIG: \.gitleaks\.toml/);
    expect(wf).toMatch(/--results=verified,unknown/);
  });
});

describe(".gitleaks.toml (#3)", () => {
  // A tiny TOML sanity check: every non-blank, non-comment line is a table header,
  // a key = value, or part of a bracketed array; quotes and brackets are balanced.
  it("parses as TOML", () => {
    let depth = 0;
    for (const raw of toml.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (depth === 0) {
        const ok = /^\[[\w.]+\]$/.test(line) || /^\w+\s*=\s*("[^"]*"|'[^']*'|true|false|\d+|\[)/.test(line);
        expect(ok, `unexpected TOML line: ${line}`).toBe(true);
      } else {
        const ok = /^('''.*'''|"[^"]*"),?$/.test(line) || line === "]";
        expect(ok, `unexpected array element: ${line}`).toBe(true);
      }
      // Count array brackets outside of string literals.
      const stripped = line.replace(/'''.*?'''|"[^"]*"/g, "");
      depth += (stripped.match(/\[/g) ?? []).length - (stripped.match(/\]/g) ?? []).length;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it("keeps the default rules and only allowlists fixtures, never src/", () => {
    expect(toml).toMatch(/^\[extend\]\nuseDefault = true$/m);
    expect(toml).toMatch(/^\[allowlist\]$/m);
    expect(toml).toMatch(/'''\^tests\/\.\*'''/);
    expect(toml).toMatch(/'''\^desktop\/tests\/\.\*'''/);
    const paths = toml.slice(toml.indexOf("paths = ["), toml.indexOf("]", toml.indexOf("paths = [")));
    expect(paths).not.toMatch(/'''\^src\/\.\*'''|'''\^src\/\[/);
    expect(paths).not.toMatch(/\^deploy\/|\^scripts\/|\^\.github\//);
  });
});
