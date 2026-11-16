// What the app says about this machine's memory guard (the agent's src/swarm/memory-manager.ts).
import type { MemoryOverview } from "./api";
import { thisMachineLabel } from "./agent-paused";

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;

/** "Paused: this Mac is low on memory", or null while network work runs. */
export function memoryPausedTitle(m: MemoryOverview | undefined, platform?: string): string | null {
  if (!m?.paused) return null;
  const machine = thisMachineLabel(platform).toLowerCase();
  if (m.pressure === "critical") return `Paused: ${machine} is critically low on memory`;
  if (m.pressure === "warning") return `Paused: ${machine} is low on memory`;
  return `Paused: no installed model fits ${machine}'s memory budget`;
}

/** The detail line under the title. */
export function memoryPausedDetail(m: MemoryOverview): string {
  if (m.pressure === "critical") return "Network work was stopped and handed to other machines, and idle models were unloaded. It resumes by itself once memory is free again. Your own chats keep working.";
  if (m.pressure === "warning") return "It takes no new network work and has unloaded idle models until memory pressure drops. Your own chats keep working.";
  return `Models may use ${gb(m.budgetBytes)} here. Install a smaller model to serve the network.`;
}

/** "Serving on the network: qwen3.5:9b" (Settings → Models). */
export function servingLine(m: MemoryOverview | undefined): string | null {
  if (!m) return null;
  return m.servingModels.length ? `Serving on the network: ${m.servingModels.join(", ")}` : "Serving on the network: none";
}

/** Budget and what the served model runs with. */
export function budgetLine(m: MemoryOverview): string {
  const parts = [`memory budget ${gb(m.budgetBytes)} of ${gb(m.totalBytes)}`, `${gb(m.usedBytes)} loaded`];
  if (m.contextWindow) parts.push(`${Math.round(m.contextWindow / 1024)}k context × ${m.parallel} parallel`);
  return parts.join(" · ");
}

/** Installed models kept for local use only, and why. */
export function localOnlyLine(m: MemoryOverview): string | null {
  const parts: string[] = [];
  if (m.localOnlyModels.length) parts.push(`local only (past this machine's network model limit): ${m.localOnlyModels.join(", ")}`);
  if (m.tooBigModels.length) parts.push(`local only (too big for the memory budget): ${m.tooBigModels.join(", ")}`);
  return parts.length ? parts.join("; ") : null;
}
