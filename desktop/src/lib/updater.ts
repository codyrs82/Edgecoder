import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up-to-date" }
  | { state: "available"; update: Update }
  | { state: "downloading"; progress: number }
  | { state: "installing" }
  | { state: "error"; message: string };

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Install updates without asking (default on). Opt out with localStorage edgecoder_autoUpdate = "off". */
export const AUTO_UPDATE_KEY = "edgecoder_autoUpdate";

export function autoUpdateEnabled(store: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  return store?.getItem(AUTO_UPDATE_KEY) !== "off";
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let statusListeners: Array<(s: UpdateStatus) => void> = [];
let currentStatus: UpdateStatus = { state: "idle" };
let timeoutId: ReturnType<typeof setTimeout> | null = null;
let intervalId: ReturnType<typeof setInterval> | null = null;
let cachedUpdate: Update | null = null;

function setStatus(s: UpdateStatus) {
  currentStatus = s;
  for (const fn of statusListeners) fn(s);
}

export function getUpdateStatus(): UpdateStatus {
  return currentStatus;
}

export function onUpdateStatus(fn: (s: UpdateStatus) => void): () => void {
  statusListeners.push(fn);
  fn(currentStatus);
  return () => {
    statusListeners = statusListeners.filter((f) => f !== fn);
  };
}

export async function checkForUpdate(): Promise<void> {
  if (currentStatus.state === "checking" || currentStatus.state === "downloading" || currentStatus.state === "installing") {
    return; // Already in progress
  }

  setStatus({ state: "checking" });
  try {
    const update = await check();
    if (update) {
      cachedUpdate = update;
      setStatus({ state: "available", update });
      // Signed update found: fetch, verify (the plugin checks the signature against the
      // public key baked into this build), install and relaunch. The bundled agent
      // restarts with the app; in-flight swarm tasks are re-leased by the coordinator.
      if (autoUpdateEnabled()) await downloadAndInstall();
    } else {
      cachedUpdate = null;
      setStatus({ state: "up-to-date" });
    }
  } catch (err) {
    setStatus({ state: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

export async function downloadAndInstall(): Promise<void> {
  const update = cachedUpdate;
  if (!update) return;

  setStatus({ state: "downloading", progress: 0 });
  try {
    let totalBytes = 0;
    let downloadedBytes = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started" && event.data.contentLength != null) {
        totalBytes = event.data.contentLength;
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        const progress = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
        setStatus({ state: "downloading", progress });
      }
    });

    setStatus({ state: "installing" });
    await relaunch();
  } catch (err) {
    setStatus({ state: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

export function startPeriodicCheck(): void {
  if (intervalId) return;
  // Initial check after a short delay (don't block app startup)
  timeoutId = setTimeout(() => checkForUpdate(), 5_000);
  intervalId = setInterval(() => checkForUpdate(), CHECK_INTERVAL_MS);
}

export function stopPeriodicCheck(): void {
  if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
}
