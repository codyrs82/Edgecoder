// The chat's Web toggle and the sources under a web answer (docs/web-tool.md). The server side is
// src/web-tool/: web_search and read_page run on EdgeCoder's servers and are billed per call.

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
}

/** /v1/ide/web/status (IDE server) or /portal/api/web/status (portal) for the chat's model. */
export interface WebStatus {
  available: boolean;
  configured: boolean;
  toolsSupported: boolean;
  /** Why it can't be on: not set up on the servers, the model can't call tools, no cSats, or unreachable. */
  reason?: "not_configured" | "no_tools" | "needs_csats" | "offline" | "unreachable" | null;
  message?: string;
  searchCSats?: number;
  readCSats?: number;
  balanceCSats?: number | null;
}

export interface WebToggleView {
  /** Shown at all (hidden while web search isn't set up on the servers). */
  visible: boolean;
  disabled: boolean;
  pressed: boolean;
  /** A short note beside "Web" ("needs cSats"). */
  note: string;
  title: string;
}

export const NO_TOOLS_TITLE = "Web needs a model that can use tools. Pick another model.";

/** What the composer's Web toggle shows for a status and the chat's setting. */
export function webToggleView(status: WebStatus | null | undefined, on: boolean): WebToggleView {
  if (!status || !status.configured || status.reason === "not_configured") return { visible: false, disabled: true, pressed: false, note: "", title: status?.message ?? "Web search isn't set up yet" };
  const prices = status.searchCSats !== undefined ? ` (${status.searchCSats} cSats a search, ${status.readCSats ?? 0} a page)` : "";
  if (!status.toolsSupported || status.reason === "no_tools") return { visible: true, disabled: true, pressed: false, note: "", title: NO_TOOLS_TITLE };
  if (status.reason === "needs_csats") return { visible: true, disabled: true, pressed: false, note: "needs cSats", title: `Web search costs cSats${prices}. Top up to use it.` };
  if (!status.available) return { visible: true, disabled: true, pressed: false, note: "", title: status.message ?? "Web search isn't available right now." };
  return {
    visible: true,
    disabled: false,
    pressed: on,
    note: "",
    title: on ? `Web is on: the model may search the web and read pages${prices}.` : `Let the model search the web and read pages, with sources${prices}.`,
  };
}

/** "2 searches · 1 page · 1.2 cSats"; "" when the web wasn't used. */
export function webFooter(u: Pick<WebUsage, "searches" | "pages" | "cSats"> | undefined): string {
  if (!u) return "";
  const parts: string[] = [];
  if (u.searches) parts.push(`${u.searches} search${u.searches === 1 ? "" : "es"}`);
  if (u.pages) parts.push(`${u.pages} page${u.pages === 1 ? "" : "s"}`);
  if (parts.length === 0) return "";
  parts.push(`${Number(u.cSats.toFixed(2))} cSats`);
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
  return { searches: n(event.searches), pages: n(event.pages), cSats: n(event.cSats), sources };
}

/** The status lines the web tool sends ("Searching the web…", "Reading example.com…"). */
export function isWebStatus(message: string): boolean {
  return /^(Searching the web|Reading \S+)…$/.test(message);
}
