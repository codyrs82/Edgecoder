// Virtual file system for the editor
export interface EditorFile {
  path: string;
  content: string;
  language: string;
  dirty: boolean;
}

const languageMap: Record<string, string> = {
  py: "python",
  js: "javascript",
  ts: "typescript",
  rs: "rust",
  go: "go",
  json: "json",
  md: "markdown",
  html: "html",
  css: "css",
  svelte: "html",
};

export function detectLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return languageMap[ext] ?? "plaintext";
}

export function createFile(path: string, content: string): EditorFile {
  return {
    path,
    content,
    language: detectLanguage(path),
    dirty: false,
  };
}
