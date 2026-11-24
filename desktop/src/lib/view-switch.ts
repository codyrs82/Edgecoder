/**
 * Where the Chat / Code switch sits: at the top of the open view's sidebar, above New chat, like
 * the portal; in the title bar only while that sidebar is hidden, so there is always one way to
 * switch. Exactly one place at a time (the tabs carry ids the tab panels point at).
 */
export type View = "chat" | "editor";
export type SwitchSpot = "chat-sidebar" | "code-sidebar" | "titlebar";

export function viewSwitchSpot(view: View, chatSidebarOpen: boolean, codeSidebarOpen: boolean): SwitchSpot {
  if (view === "chat") return chatSidebarOpen ? "chat-sidebar" : "titlebar";
  return codeSidebarOpen ? "code-sidebar" : "titlebar";
}

/** A session someone drives from outside this Mac (the phone or the web, through Code from your phone). */
export function drivenRemotely(s: { controller?: { kind: string } | null; clients?: Array<{ kind: string }> }): boolean {
  return s.controller?.kind === "remote" || (s.clients ?? []).some((c) => c.kind === "remote");
}
