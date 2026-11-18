// The chat's Web indicator ("Web: Auto" / "Off for this chat") and the sources under a web answer
// (docs/web-tool.md). Web is automatic: when it's set up, the model can call tools and the account
// has cSats, the chat offers web_search and read_page and the model decides when to search. The
// server side is src/web-tool/: they run on EdgeCoder's servers and are billed per call.
import { writable } from "svelte/store";

export interface WebSource {
  n: number;
  title: string;
  url: string;
}

/** The web tool's total for one reply: searches, pages read, their cSats and the numbered sources. */
export interface WebUsage {
  searches: number;
  pages: number;
  cSats: number;
  sources: WebSource[];
  /** Every call was free: the chat ran on your own machine. */
  free?: boolean;
}

/** /v1/ide/web/status (IDE server) or /portal/api/web/status (portal) for the chat's model. */
export interface WebStatus {
  available: boolean;
  configured: boolean;
  toolsSupported: boolean;
  /** Why it can't be on: not set up on the servers, the model can't call tools, no cSats, or unreachable. */
  reason?: "not_configured" | "no_tools" | "needs_csats" | "free_used" | "rate_limited" | "offline" | "unreachable" | null;
  message?: string;
  searchCSats?: number;
  readCSats?: number;
  balanceCSats?: number | null;
  maxSearchesPerReply?: number;
  maxReadsPerReply?: number;
  /** The chat runs on your own machine and the web is free for it now (no cSats needed). */
  free?: boolean;
  freeSearchesLeftToday?: number;
  freeReadsLeftToday?: number;
}

/** A chat's web: "auto" (the model searches when a question needs fresh information) or "off". */
export type WebMode = "auto" | "off";

export interface WebIndicatorView {
  /** Shown at all (hidden while web search isn't set up on the servers or the status is unknown). */
  visible: boolean;
  /** The menu can't be opened: the chat's model can't call tools. */
  unavailable: boolean;
  /** "Web: Auto", "Web: Off", or "Web" when unavailable. */
  label: string;
  /** A short quiet note beside it ("needs cSats"). */
  note: string;
  title: string;
}

export const UNAVAILABLE_TITLE = "Web: unavailable with this model";
export const NEEDS_CSATS_NOTE = "Web search needs cSats";

/** What the composer's quiet Web indicator shows for a status and the chat's mode. */
export function webIndicatorView(status: WebStatus | null | undefined, mode: WebMode): WebIndicatorView {
  if (!status || !status.configured || status.reason === "not_configured") return { visible: false, unavailable: true, label: "Web", note: "", title: status?.message ?? "Web search isn't set up yet" };
  if (!status.toolsSupported || status.reason === "no_tools") return { visible: true, unavailable: true, label: "Web", note: "", title: UNAVAILABLE_TITLE };
  const prices = status.searchCSats !== undefined ? ` (${status.searchCSats} cSats a search, ${status.readCSats ?? 0} a page)` : "";
  if (mode === "off") return { visible: true, unavailable: false, label: "Web: Off", note: "", title: "Web is off for this chat. Click to change." };
  // "needs cSats" is for chats on the network; on your own machine the web is free (daily allowance).
  if (status.reason === "needs_csats" && !status.free) return { visible: true, unavailable: false, label: "Web: Auto", note: "needs cSats", title: `${NEEDS_CSATS_NOTE}${prices}. This chat answers without the web until you top up.` };
  if (!status.available) return { visible: true, unavailable: false, label: "Web: Auto", note: "", title: status.message ?? "Web search isn't available right now." };
  if (status.free) {
    const left = typeof status.freeSearchesLeftToday === "number" ? ` (${status.freeSearchesLeftToday} free searches left today)` : "";
    return { visible: true, unavailable: false, label: "Web: Auto", note: "", title: `Web: Auto. The model searches the web when a question needs fresh information, and cites its sources. Free on your machine${left}.` };
  }
  return { visible: true, unavailable: false, label: "Web: Auto", note: "", title: `Web: Auto. The model searches the web when a question needs fresh information, and cites its sources${prices}.` };
}

/** A chat's mode: its own choice (true: Auto, false: Off for this chat), else the Settings default. */
export function chatWebMode(chatChoice: boolean | undefined, autoByDefault: boolean): WebMode {
  if (chatChoice === true) return "auto";
  if (chatChoice === false) return "off";
  return autoByDefault ? "auto" : "off";
}

/** Offer web_search and read_page with this message: Auto, and the status says they can be used now. */
export function webOffered(status: WebStatus | null | undefined, mode: WebMode): boolean {
  return mode === "auto" && status?.available === true;
}

/** Settings → General "Search the web automatically" (default on), kept on this computer. */
export const WEB_AUTO_KEY = "edgecoder.web.auto";

type Store = Pick<Storage, "getItem">;
function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function webAutoDefault(store: Store | null = safeStorage()): boolean {
  try {
    return store?.getItem(WEB_AUTO_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setWebAutoDefault(on: boolean, store: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    store?.setItem(WEB_AUTO_KEY, on ? "on" : "off");
  } catch {
    /* storage unavailable */
  }
  webAutoStore.set(on);
}

/** The default, live (Settings changes it; the chat reads it). */
export const webAutoStore = writable<boolean>(webAutoDefault());

export const FREE_ON_YOUR_MACHINE = "free (your machine)";

/** "2 searches · 1 page · 1.2 cSats", or "2 searches · free (your machine)"; "" when the web wasn't used. */
export function webFooter(u: Pick<WebUsage, "searches" | "pages" | "cSats" | "free"> | undefined): string {
  if (!u) return "";
  const parts: string[] = [];
  if (u.searches) parts.push(`${u.searches} search${u.searches === 1 ? "" : "es"}`);
  if (u.pages) parts.push(`${u.pages} page${u.pages === 1 ? "" : "s"}`);
  if (parts.length === 0) return "";
  parts.push(u.free && !u.cSats ? FREE_ON_YOUR_MACHINE : `${Number(u.cSats.toFixed(2))} cSats`);
  return parts.join(" · ");
}

/** The sources an answer cites as [n], in order; all of them (up to 8) when it cites none. */
export function citedSources(text: string, sources: readonly WebSource[]): WebSource[] {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const cited = [...new Set([...text.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1])))].filter((n) => byN.has(n)).sort((a, b) => a - b);
  return cited.length ? cited.map((n) => byN.get(n)!) : sources.slice(0, 8);
}

/** A "web" stream event as a WebUsage, or null when it isn't one. */
export function webUsageOf(event: Record<string, unknown>): WebUsage | null {
  if (event.type !== "web" && !("sources" in event)) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const sources = Array.isArray(event.sources)
    ? (event.sources as Array<Record<string, unknown>>)
        .filter((s) => typeof s.url === "string" && /^https?:\/\//i.test(s.url as string))
        .map((s) => ({ n: n(s.n), title: String(s.title ?? s.url), url: String(s.url) }))
    : [];
  return { searches: n(event.searches), pages: n(event.pages), cSats: n(event.cSats), sources, ...(event.free === true ? { free: true } : {}) };
}

/** The status lines the web tool sends ("Searching the web…", "Reading example.com…"). */
export function isWebStatus(message: string): boolean {
  return /^(Searching the web|Reading \S+)…$/.test(message);
}
