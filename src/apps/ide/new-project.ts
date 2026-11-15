// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * New projects: <projects folder>/<name> (default ~/EdgeCoder), a fresh git repository.
 * Started from chat (a folder name made from the request) or from the desktop's New project
 * sheet (an exact folder name, a location, a starter template, and whether to init git).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { gitExecEnv, hardenedGitArgs } from "./git-safe.js";
import { validFolderName } from "./git-setup.js";
import { getProjectsFolder } from "./repo-connect.js";

/** The projects folder (Settings → General), default ~/EdgeCoder. */
export function projectsHome(): string {
  return getProjectsFolder().path;
}

/** A folder name from the user's words: lowercase, dashes, a few words. */
export function projectSlug(text: string): string {
  const stop = new Set(["a", "an", "the", "me", "us", "lets", "let's", "please", "build", "create", "make", "new", "write", "code", "generate", "for", "my", "i", "want", "to", "can", "you", "start", "with", "that", "of", "and", "in", "using", "simple", "some"]);
  const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w && !stop.has(w));
  return words.slice(0, 4).join("-").slice(0, 40).replace(/-+$/, "") || "project";
}

export const PROJECT_TEMPLATES = ["empty", "web", "node"] as const;
export type ProjectTemplate = (typeof PROJECT_TEMPLATES)[number];

export interface NewProjectOptions {
  /** Where the folder goes (an existing absolute folder). Default: the projects folder. */
  parentDir?: string;
  /** The exact folder name. Without it the name comes from `name` (projectSlug) and is made unique. */
  folder?: string;
  /** Starter files. Default: empty. */
  template?: ProjectTemplate;
  /** `git init` on main. Default: true. */
  git?: boolean;
}

export class NewProjectError extends Error {
  constructor(readonly code: "invalid" | "exists", message: string) {
    super(message);
  }
}

/** Starter files for each template, by project-relative path. */
export function templateFiles(template: ProjectTemplate, title: string): Record<string, string> {
  const readme = `# ${title}\n`;
  if (template === "web") {
    return {
      "README.md": `${readme}\nA static website. Open index.html in a browser, or use the preview in EdgeCoder.\n`,
      "index.html": `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>${title}</title>\n    <link rel="stylesheet" href="styles.css" />\n  </head>\n  <body>\n    <main>\n      <h1>${title}</h1>\n    </main>\n    <script src="script.js"></script>\n  </body>\n</html>\n`,
      "styles.css": "body {\n  margin: 0;\n  font-family: system-ui, sans-serif;\n}\n\nmain {\n  max-width: 720px;\n  margin: 0 auto;\n  padding: 48px 24px;\n}\n",
      "script.js": "",
    };
  }
  if (template === "node") {
    const pkgName = title.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+/, "") || "project";
    return {
      "README.md": `${readme}\nRun it with \`npm start\`.\n`,
      "package.json": `${JSON.stringify({ name: pkgName, version: "0.1.0", private: true, type: "module", scripts: { start: "node index.js", test: "node --test" } }, null, 2)}\n`,
      "index.js": 'console.log("Hello from ' + pkgName + '");\n',
      ".gitignore": "node_modules/\n.env\n",
    };
  }
  return {};
}

/** Create the folder, add the template's files, `git init` it; returns its absolute path. */
export function createNewProject(name: string, opts: NewProjectOptions = {}): string {
  let home: string;
  if (opts.parentDir !== undefined) {
    if (!isAbsolute(opts.parentDir)) throw new NewProjectError("invalid", "Pick a folder for the project.");
    if (!existsSync(opts.parentDir) || !statSync(opts.parentDir).isDirectory()) throw new NewProjectError("invalid", `${opts.parentDir} isn't a folder.`);
    home = opts.parentDir;
  } else {
    home = projectsHome();
    mkdirSync(home, { recursive: true });
  }
  let dir: string;
  if (opts.folder !== undefined) {
    if (!validFolderName(opts.folder)) throw new NewProjectError("invalid", `"${opts.folder}" isn't a usable folder name. Use letters, numbers, dots, dashes and underscores.`);
    dir = join(home, opts.folder);
    if (existsSync(dir)) throw new NewProjectError("exists", `${dir} already exists. Pick another name.`);
  } else {
    const base = projectSlug(name);
    dir = join(home, base);
    for (let n = 2; existsSync(dir); n++) dir = join(home, `${base}-${n}`);
  }
  mkdirSync(dir);
  const title = opts.folder ?? (name.trim() || "project");
  for (const [rel, content] of Object.entries(templateFiles(opts.template ?? "empty", title))) {
    writeFileSync(join(dir, rel), content);
  }
  if (opts.git !== false) {
    try {
      execFileSync("git", hardenedGitArgs(["init", "-q", "-b", "main"]), { env: gitExecEnv(), cwd: dir, stdio: "ignore", timeout: 10_000 });
    } catch {
      // git missing: still a usable folder
    }
  }
  return dir;
}
