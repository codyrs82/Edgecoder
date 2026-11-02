// Open files in the editor. Each is backed by a project file on disk (read and saved through
// the IDE server's /v1/ide/fs routes); `savedContent` and `mtimeMs` are the version on disk.
export interface EditorFile {
  path: string;
  content: string;
  /** Content as last loaded from or saved to disk. */
  savedContent: string;
  /** Disk modification time of `savedContent`; sent with a save so a newer disk version is not overwritten. */
  mtimeMs?: number;
  language: string;
  dirty: boolean;
  /** The file changed on disk while it had unsaved edits here. */
  diskChanged?: boolean;
  /** The file was deleted or moved on disk. */
  missing?: boolean;
}

const languageMap: Record<string, string> = {
  py: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  rs: "rust",
  go: "go",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  svelte: "html",
  vue: "html",
  css: "css",
  scss: "scss",
  less: "less",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  xml: "xml",
  svg: "xml",
  graphql: "graphql",
  dockerfile: "dockerfile",
};

const filenameMap: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "shell",
};

export function detectLanguage(filename: string): string {
  const base = filename.split("/").pop()?.toLowerCase() ?? "";
  if (filenameMap[base]) return filenameMap[base];
  if (base.startsWith("dockerfile")) return "dockerfile";
  const ext = base.includes(".") ? base.split(".").pop() ?? "" : "";
  return languageMap[ext] ?? "plaintext";
}

export function createFile(path: string, content: string, mtimeMs?: number): EditorFile {
  return {
    path,
    content,
    savedContent: content,
    mtimeMs,
    language: detectLanguage(path),
    dirty: false,
  };
}

/** Parent directory of a project-relative path ("" for the root). */
export function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Join a directory and a name into a project-relative path. */
export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}
