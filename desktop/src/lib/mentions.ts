// @-mentions in chat: "@src/lib/api.ts" or "@src/lib/" in a message attaches that file's content
// (or the folder's listing) for the agent, read from the open project when the message is sent.
import { fsList, fsRead, indexSearch } from "./api";

const MENTION_RE = /(?:^|\s)@([^\s@]+)/g;
/** Per file, and for all attachments of one message together. */
const MAX_FILE_CHARS = 20_000;
const MAX_TOTAL_CHARS = 60_000;

/** The distinct paths mentioned in a message, in order. */
export function mentionedPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const p = m[1].replace(/[.,;:!?)]+$/, "");
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * The context block to send with a message: each mentioned file's content or folder's listing.
 * Paths that don't exist in the project are skipped (an @ in prose isn't always a mention).
 */
export async function expandMentions(text: string): Promise<string> {
  const parts: string[] = [];
  let total = 0;
  for (const raw of mentionedPaths(text)) {
    if (raw === "codebase") {
      // Search the project by meaning with the rest of the message as the query.
      const query = text.replace(MENTION_RE, " ").trim() || text;
      try {
        const hits = await indexSearch(query, 6);
        const body = hits.map((h) => `${h.path}:${h.startLine}-${h.endLine}\n\`\`\`\n${h.snippet}\n\`\`\``).join("\n\n");
        if (body) {
          parts.push(`[Relevant code found in the project for this message]\n${body}`);
          total += body.length;
        }
      } catch {
        parts.push("[@codebase: the project has no search index yet; build it from the file tree header]");
      }
      continue;
    }
    if (total >= MAX_TOTAL_CHARS) break;
    const path = raw.replace(/\/+$/, "");
    try {
      if (raw.endsWith("/")) {
        const entries = await fsList(path);
        const listing = entries.map((e) => `${e.path}${e.kind === "dir" ? "/" : ""}`).join("\n");
        parts.push(`[Attached folder ${path}/]\n${listing}`);
        total += listing.length;
        continue;
      }
      const file = await fsRead(path);
      const room = Math.min(MAX_FILE_CHARS, MAX_TOTAL_CHARS - total);
      const body = file.content.length > room ? `${file.content.slice(0, room)}\n…(truncated; read_file for the rest)` : file.content;
      parts.push(`[Attached file ${file.path}]\n\`\`\`\n${body}\n\`\`\``);
      total += body.length;
    } catch {
      // not a project path: leave it as text
    }
  }
  return parts.join("\n\n");
}

export type MentionSuggestion = { path: string; kind: "file" | "dir" | "codebase" };

/** Picker suggestions for "@query": @codebase (search by meaning) first when it fits, then paths. */
export async function mentionSuggestions(query: string, find: (q: string) => Promise<Array<{ path: string; kind: "file" | "dir" }>>): Promise<MentionSuggestion[]> {
  const paths = await find(query);
  const codebase: MentionSuggestion[] = "codebase".startsWith(query.toLowerCase()) ? [{ path: "codebase", kind: "codebase" }] : [];
  return [...codebase, ...paths];
}
