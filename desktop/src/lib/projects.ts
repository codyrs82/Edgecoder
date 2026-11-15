// Projects in the Code view: the folders you work in, each with its coding chats.
// A project is a folder on this machine (usually a git repository). The list is the folders
// you opened recently plus every folder a coding chat is bound to; chats are grouped under them.

import { writable } from "svelte/store";
import type { Conversation } from "./types";

const RECENT_KEY = "edgecoder-recent-projects";
const LAST_CHAT_KEY = "edgecoder-last-editor-id:";
const MAX_RECENT = 20;

export interface RecentProject {
  root: string;
  openedAt: number;
}

export interface ProjectGroup {
  root: string;
  name: string;
  /** Coding chats bound to this folder, newest first. */
  chats: Conversation[];
  /** The latest of: opened, a chat updated. */
  lastActive: number;
}

/** Bumped when coding chats are saved, renamed or deleted, so lists reload. */
export const chatListVersion = writable(0);
export function chatsChanged(): void {
  chatListVersion.update((n) => n + 1);
}

/** "website" for "/Users/me/EdgeCoder/website/". */
export function projectName(root: string): string {
  return root.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || root;
}

/** "~/EdgeCoder/website" for a folder in the home directory. */
export function tildePath(p: string): string {
  return p.replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~");
}

function readRecent(): RecentProject[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is RecentProject => typeof r?.root === "string" && r.root.length > 0 && typeof r?.openedAt === "number");
  } catch {
    return [];
  }
}

function writeRecent(list: RecentProject[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable: the list lasts for this session only
  }
}

/** Recently opened project folders, most recent first. */
export function loadRecentProjects(): RecentProject[] {
  return readRecent().sort((a, b) => b.openedAt - a.openedAt);
}

/** Record that `root` was opened now; returns the new list. */
export function rememberProject(root: string, now = Date.now()): RecentProject[] {
  const list = [{ root, openedAt: now }, ...readRecent().filter((r) => r.root !== root)].slice(0, MAX_RECENT);
  writeRecent(list);
  return list;
}

/** Take a folder off the recent list (its chats keep it in the sidebar while they exist). */
export function forgetProject(root: string): RecentProject[] {
  const list = readRecent().filter((r) => r.root !== root);
  writeRecent(list);
  return list;
}

/** The chat to reopen with a project. */
export function lastChatFor(root: string): string | null {
  try {
    return localStorage.getItem(LAST_CHAT_KEY + root);
  } catch {
    return null;
  }
}

export function setLastChatFor(root: string, id: string): void {
  try {
    localStorage.setItem(LAST_CHAT_KEY + root, id);
  } catch {
    // storage unavailable
  }
}

/**
 * Group coding chats under their projects. Projects are the recent folders, the folders chats
 * are bound to, and the open one; ordered by last activity. Chats with no folder come back loose.
 */
export function groupByProject(
  chats: Conversation[],
  recent: RecentProject[],
  current: string | null,
): { projects: ProjectGroup[]; loose: Conversation[] } {
  const byRoot = new Map<string, ProjectGroup>();
  const group = (root: string): ProjectGroup => {
    let g = byRoot.get(root);
    if (!g) {
      g = { root, name: projectName(root), chats: [], lastActive: 0 };
      byRoot.set(root, g);
    }
    return g;
  };
  for (const r of recent) {
    const g = group(r.root);
    g.lastActive = Math.max(g.lastActive, r.openedAt);
  }
  if (current) group(current);
  const loose: Conversation[] = [];
  for (const c of chats) {
    if (!c.projectRoot) {
      loose.push(c);
      continue;
    }
    const g = group(c.projectRoot);
    g.chats.push(c);
    g.lastActive = Math.max(g.lastActive, c.updatedAt);
  }
  for (const g of byRoot.values()) g.chats.sort((a, b) => b.updatedAt - a.updatedAt);
  loose.sort((a, b) => b.updatedAt - a.updatedAt);
  const projects = [...byRoot.values()].sort((a, b) => b.lastActive - a.lastActive || a.name.localeCompare(b.name));
  return { projects, loose };
}

/** The repository's web page for a remote URL (GitHub, GitLab, Bitbucket), or null. */
export function repoWebUrl(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl) return null;
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(remoteUrl);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  try {
    const u = new URL(remoteUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `https://${u.host}${u.pathname.replace(/\.git\/?$/, "").replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** "owner/repo" for a GitHub remote, else null. */
export function githubSlug(remoteUrl: string | null | undefined): string | null {
  const web = repoWebUrl(remoteUrl);
  const m = web ? /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(web) : null;
  return m ? m[1] : null;
}

/** A folder name a user typed, made usable: spaces to dashes, other characters dropped. */
export function folderNameFrom(input: string): string {
  return input.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "").replace(/^[-.]+/, "").slice(0, 100);
}

/** What the New project sheet made. */
export interface CreatedProject {
  root: string;
  /** What happened, for a note in the new chat (markdown). */
  summary: string;
  /** Set when the project was made but publishing to GitHub failed. */
  warning?: string;
}
