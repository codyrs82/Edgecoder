// What a tool-approval card shows: every argument of the call, in full.
// The Allow click is the only check between model output and the user's machine, so nothing
// here is shortened, dropped or hidden. Long values scroll in the card; they are never cut.

export interface ApprovalField {
  /** The argument name as the model sent it. */
  key: string;
  label: string;
  /** The complete value, with invisible characters made visible. */
  value: string;
  /** Commands, file content and other multi-line text: shown as a scrolling block. */
  block: boolean;
  /** Size of a long value ("120 lines, 4,812 characters"), so text below the fold is expected. */
  size?: string;
}

/** Display order and wording per tool; arguments not listed follow under their own name. */
const KNOWN: Record<string, Array<[key: string, label: string, block?: boolean]>> = {
  run_shell: [["command", "Command", true], ["timeout", "Timeout (ms)"]],
  write_file: [["path", "File"], ["content", "Content to write", true]],
  edit_file: [["path", "File"], ["old_string", "Replace this", true], ["new_string", "With this", true]],
  git_commit: [["message", "Commit message", true], ["files", "Files to stage"]],
  git_branch: [["name", "Branch"], ["create", "Create"]],
  git_push: [["remote", "Remote"], ["branch", "Branch"], ["setUpstream", "Set upstream"]],
  git_pull: [["remote", "Remote"], ["branch", "Branch"]],
  github_create_pr: [["title", "Title"], ["body", "Description", true], ["head", "From branch"], ["base", "Into branch"]],
  open_pull_request: [["title", "Title"], ["body", "Description", true], ["branch", "From branch"], ["base", "Into branch"], ["diffstat", "Changes", true], ["commits", "Commits"], ["uncommitted", "Uncommitted files (not included)"]],
};

// C0/C1 controls (tab and newline stay), soft hyphen, zero-width and bidi controls, line/paragraph
// separators, BOM: characters that render as nothing or reorder the text around them.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/g;

/** The text with invisible and direction-changing characters written out as \u{XXXX}. */
export function showInvisible(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(INVISIBLE, (ch) => `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`);
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

const LONG_LINES = 12;
const LONG_CHARS = 600;

/** Every argument of a tool call as a labelled field: known ones first, then the rest. Nothing is truncated. */
export function approvalFields(tool: string, args: Record<string, unknown>): ApprovalField[] {
  const seen = new Set<string>();
  const fields: ApprovalField[] = [];
  const add = (key: string, label: string, block?: boolean) => {
    if (seen.has(key) || !Object.prototype.hasOwnProperty.call(args, key) || args[key] === undefined) return;
    seen.add(key);
    const value = showInvisible(textOf(args[key]));
    const lines = value.split("\n").length;
    const long = lines > LONG_LINES || value.length > LONG_CHARS;
    fields.push({
      key,
      label,
      value,
      block: block === true || lines > 1 || value.length > 80,
      ...(long ? { size: `${lines.toLocaleString("en-US")} line${lines === 1 ? "" : "s"}, ${value.length.toLocaleString("en-US")} characters` } : {}),
    });
  };
  for (const [key, label, block] of KNOWN[tool] ?? []) add(key, label, block);
  for (const key of Object.keys(args)) add(key, key);
  return fields;
}
