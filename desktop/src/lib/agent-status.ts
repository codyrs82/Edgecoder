// #72: the desktop shell only hands the inference token to an agent it spawned itself.
// "port_occupied" means something else already listens on 127.0.0.1:4301; the webview then
// treats the local agent as unavailable (remote mode) and the UI can offer a retry.

export type LocalAgentStatus = "spawned" | "port_occupied" | "not_started" | "unknown";

export function parseAgentStatus(value: unknown): LocalAgentStatus {
  return value === "spawned" || value === "port_occupied" || value === "not_started" ? value : "unknown";
}

/** Status carried in a get_local_token error ("port_occupied: …" / "not_started: …"), if any. */
export function statusFromTokenError(message: string): LocalAgentStatus | null {
  const m = /^(port_occupied|not_started):/.exec(message.trim());
  return m ? (m[1] as LocalAgentStatus) : null;
}

/** Whether local :4301 may be used. Outside Tauri (dev/web) the status is "unknown". */
export function localAgentUsable(status: LocalAgentStatus): boolean {
  return status !== "port_occupied";
}

export function agentStatusMessage(status: LocalAgentStatus): string | null {
  if (status === "port_occupied") {
    return "Another process is already using port 4301, so EdgeCoder didn't start its local agent and won't send it your token. Stop that process (for example an agent left over from an earlier launch), then retry.";
  }
  if (status === "not_started") return "The local agent isn't running.";
  return null;
}
