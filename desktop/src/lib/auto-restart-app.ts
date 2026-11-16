// The app's one AutoRestart, wired to the updater, the busy registry and the agent probes.
import { computeOverview, drainAgent, getHealth, listAllSessions } from "./api";
import { AutoRestart, busyReasons, networkJobBusy, restartWithDrain, sessionsBusy, autoRestartEnabled, type BusyReason } from "./auto-restart";
import { autoUpdateEnabled, downloadAndInstall, getUpdateStatus, onUpdateStatus } from "./updater";

/** Probes that fail (agent down, older provider without the route) count as idle. */
async function probeBusy(): Promise<BusyReason[]> {
  const reasons = busyReasons();
  const [sessions, health, compute] = await Promise.allSettled([listAllSessions(), getHealth(), computeOverview()]);
  if (sessions.status === "fulfilled" && sessionsBusy(sessions.value)) reasons.push("session");
  const queued = health.status === "fulfilled" ? health.value.coordinator?.queued : 0;
  const recent = compute.status === "fulfilled" ? (compute.value.account?.recent ?? []).map((r) => r.atMs) : [];
  const claims = compute.status === "fulfilled" ? compute.value.claims ?? 0 : 0;
  if (networkJobBusy(queued, recent, Date.now(), claims)) reasons.push("network-job");
  return [...new Set(reasons)];
}

export const autoRestart = new AutoRestart({
  autoUpdate: () => autoUpdateEnabled(),
  autoRestart: () => autoRestartEnabled(),
  readyVersion: () => { const s = getUpdateStatus(); return s.state === "ready" ? s.update.version : null; },
  checkBusy: probeBusy,
  // The agent drains first (no network job left abandoned), then the update installs (BHV006).
  restart: restartWithDrain((resume) => drainAgent(resume), () => downloadAndInstall()),
});

let started = false;
export function startAutoRestart(): () => void {
  if (started) return () => {};
  started = true;
  const off = onUpdateStatus(() => void autoRestart.evaluate());
  return () => { off(); started = false; };
}
