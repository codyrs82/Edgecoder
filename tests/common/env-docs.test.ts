import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allSchemaVariableNames, schemaVariableNames, SERVICE_SCHEMAS, type ServiceName } from "../../src/config/index.js";

/*
 * #15 acceptance: the env docs match the schemas. Three lists are kept in step here:
 *   1. the variables the service schemas declare (src/config/index.ts),
 *   2. the variables in the tables of site-docs/reference/environment-variables.md,
 *   3. the variables src/ reads from the environment.
 * A new variable therefore needs a schema entry and a docs row before this passes.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const doc = readFileSync(join(root, "site-docs/reference/environment-variables.md"), "utf8");

/** Platform, installer and shell-script variables: documented, but not service configuration. */
const OUTSIDE_SECTION = "Variables outside the service schemas";

/** Variable names in the first cell of every table row, by section heading. */
function documentedNames(markdown: string): Map<string, string> {
  const names = new Map<string, string>();
  let section = "";
  for (const line of markdown.split("\n")) {
    if (line.startsWith("#")) section = line.replace(/^#+\s*/, "").trim();
    if (!line.startsWith("|")) continue;
    const firstCell = line.split("|")[1] ?? "";
    for (const m of firstCell.matchAll(/`([A-Z][A-Z0-9_]*)`/g)) {
      if (!names.has(m[1])) names.set(m[1], section);
    }
  }
  return names;
}

const documented = documentedNames(doc);
const inSchemas = new Set(allSchemaVariableNames());
const outside = new Set([...documented].filter(([, section]) => section === OUTSIDE_SECTION).map(([name]) => name));

describe("environment-variables.md and the config schemas list the same variables", () => {
  it("documents every schema variable in a table", () => {
    expect([...inSchemas].filter((name) => !documented.has(name))).toEqual([]);
  });

  it("has no table row for a variable that no schema declares", () => {
    const stale = [...documented].filter(([name, section]) => section !== OUTSIDE_SECTION && !inSchemas.has(name)).map(([name]) => name);
    expect(stale).toEqual([]);
  });

  it(`keeps "${OUTSIDE_SECTION}" to variables that are in no schema`, () => {
    expect(outside.size).toBeGreaterThan(0);
    expect([...outside].filter((name) => inSchemas.has(name))).toEqual([]);
  });

  for (const service of Object.keys(SERVICE_SCHEMAS) as ServiceName[]) {
    it(`covers the ${service} schema`, () => {
      expect(schemaVariableNames(service).filter((name) => !documented.has(name))).toEqual([]);
    });
  }
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

// `process.env.X`, `env.X`, `env["X"]` and the same on any `...Env` object (childEnv.X).
const ENV_READ = /(?<![A-Za-z0-9_$.])(?:process\.env|env|[A-Za-z_]*(?:Env|ENV))(?:\??\.([A-Z][A-Z0-9_]*)\b|\[["']([A-Z][A-Z0-9_]*)["']\])/g;

describe("environment reads in src/", () => {
  it("are all declared in a schema (or listed as outside the schemas in the docs)", () => {
    const undeclared = new Map<string, string>();
    const seen = new Set<string>();
    for (const file of sourceFiles(join(root, "src"))) {
      const rel = relative(root, file).split(sep).join("/");
      // The schema files themselves declare names; they do not read them.
      if (rel.startsWith("src/config/") || rel.endsWith("config.ts")) continue;
      for (const m of readFileSync(file, "utf8").matchAll(ENV_READ)) {
        const name = m[1] ?? m[2];
        seen.add(name);
        if (!inSchemas.has(name) && !outside.has(name) && !undeclared.has(name)) undeclared.set(name, rel);
      }
    }
    // Guards the scan itself: a pattern that stopped matching would pass with nothing checked.
    expect(seen.size).toBeGreaterThan(150);
    // Fix: add the variable to its service schema in src/config/ and to the docs table.
    expect([...undeclared].map(([name, file]) => `${name} (${file})`)).toEqual([]);
  });
});
