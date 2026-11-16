// Settings → Active work: the words and numbers the page shows, kept pure so they are tested
// without the app (the page itself is ActiveWork.svelte).
import type { ActivityItem, ActivitySnapshot, AgentActivity, MemoryOverview, ServedJob } from "./api";
import { servedLine } from "./served";
import { CLASS_LABELS, shortModel } from "./compute-choice";

/** "4 s", "1 min 05 s", "2 h 03 min". */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

export function clockText(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

/** Never anything about who else asked: only that it was you or someone on the network. */
export function requesterText(j: Pick<ServedJob, "requester">): string {
  return j.requester === "you" ? "You" : "Someone on the network";
}

export function jobKindText(j: Pick<ServedJob, "kind">): string {
  return j.kind === "inference" ? "Model call" : "Code job";
}

export function tokensText(n: number): string {
  return n >= 1000 ? `≈${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `≈${n}`;
}

function host(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The agent's state in one line and a tone for its dot. */
export function agentLine(agent: AgentActivity | null): { title: string; detail: string; tone: "on" | "warn" | "err" | "off" } {
  if (!agent) return { title: "Not on the network", detail: "This computer isn't enrolled, so it doesn't serve or send network work. Enroll it in Settings → Compute.", tone: "off" };
  if (!agent.reachable) return { title: "The agent isn't answering", detail: "The background agent that connects this computer to the network didn't respond. It restarts by itself; see Settings → Logs if this lasts.", tone: "err" };
  if (agent.paused) return { title: "Paused by the network", detail: "It takes no network work until the pause is lifted.", tone: "err" };
  if (!agent.registered) return { title: "Connecting…", detail: "The agent is looking for a coordinator to join.", tone: "warn" };
  const where = [host(agent.coordinatorUrl), agent.region].filter(Boolean).join(" · ");
  const cls = agent.computeClass ? `${CLASS_LABELS[agent.computeClass] ?? agent.computeClass}${agent.tier ? ` (${agent.tier})` : ""}` : "";
  return {
    title: `Connected to ${where || "the network"}`,
    detail: [agent.draining ? "Finishing its jobs before a restart; it takes no new work meanwhile." : "", cls ? `Serves as ${cls}.` : ""].filter(Boolean).join(" "),
    tone: agent.draining ? "warn" : "on",
  };
}

export function slotsText(agent: AgentActivity | null): string | null {
  if (!agent?.slots) return null;
  const { total, busy } = agent.slots;
  if (!total) return "No model slots (no model is ready to serve)";
  return `${Math.min(busy, total)} of ${total} slot${total === 1 ? "" : "s"} in use · ${Math.max(0, total - busy)} free`;
}

/** Where one of your requests is running: its served line, or the latest place it was sent to. */
export function runningWhere(i: Pick<ActivityItem, "calls" | "model">): string {
  const line = servedLine(i.calls);
  if (line) return line;
  const last = i.calls.at(-1)?.where;
  if (last) return last;
  return i.model ? `${shortModel(i.model.replace(/^(network|mine)\//, ""))} · waiting for the first reply` : "Starting…";
}

export const KIND_TEXT: Record<ActivityItem["kind"], string> = { chat: "Chat", code: "Code", bot: "Bot", tentacle: "Helper", api: "API call" };

/** For the polite live region: changes only when the counts do. */
export function liveSummary(s: ActivitySnapshot | null): string {
  if (!s) return "";
  const serving = s.agent?.jobs.length ?? 0;
  const mine = s.mine.length;
  return `${serving} network job${serving === 1 ? "" : "s"} on this computer, ${mine} of your request${mine === 1 ? "" : "s"} running${s.agent?.paused ? ", paused by the network" : ""}.`;
}

/** "Serving on the network: qwen3.5:9b · loaded: qwen3.5:9b, llama3.2:3b" (the agent's memory guard). */
export function memoryModelsText(m: Pick<MemoryOverview, "servingModels" | "loadedModels">): string {
  const serving = m.servingModels.length ? m.servingModels.join(", ") : "none";
  return `Serving on the network: ${serving} · loaded now: ${m.loadedModels.length ? m.loadedModels.join(", ") : "none"}`;
}
