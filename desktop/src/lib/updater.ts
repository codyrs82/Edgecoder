import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up-to-date" }
  | { state: "available"; update: Update }
  | { state: "downloading"; progress: number }
  /** Downloaded and verified; installs when the user chooses "Restart to update". */
  | { state: "ready"; update: Update }
  | { state: "installing" }
  | { state: "error"; message: string };

export const CHECK_INTERVAL_MS = 30 * 60 * 1000;
/** Also check when the window regains focus, at most this often. */
export const FOCUS_CHECK_MIN_MS = 10 * 60 * 1000;

/**
 * Download updates in the background (default on); the app never restarts by itself, it shows
 * "Restart to update". Opt out with localStorage edgecoder_autoUpdate = "off".
 */
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

let lastCheckMs = 0;

export async function checkForUpdate(): Promise<void> {
  if (["checking", "downloading", "ready", "installing"].includes(currentStatus.state)) {
    return; // In progress, or already downloaded and waiting for a restart
  }
  lastCheckMs = Date.now();
  setStatus({ state: "checking" });
  try {
    const update = await check();
    if (update) {
      cachedUpdate = update;
      setStatus({ state: "available", update });
      // The plugin verifies the signature against the public key baked into this build.
      if (autoUpdateEnabled()) await downloadInBackground();
    } else {
      cachedUpdate = null;
      setStatus({ state: "up-to-date" });
    }
  } catch (err) {
    setStatus({ state: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

async function download(update: Update): Promise<void> {
  let totalBytes = 0;
  let downloadedBytes = 0;
  setStatus({ state: "downloading", progress: 0 });
  await update.download((event) => {
    if (event.event === "Started" && event.data.contentLength != null) {
      totalBytes = event.data.contentLength;
    } else if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
      const progress = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
      setStatus({ state: "downloading", progress });
    }
  });
}

/** Fetch the update now and wait for the user to restart (a restart would interrupt their work). */
export async function downloadInBackground(): Promise<void> {
  const update = cachedUpdate;
  if (!update) return;
  try {
    await download(update);
    setStatus({ state: "ready", update });
  } catch (err) {
    setStatus({ state: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

/** "Restart to update": install the downloaded update (downloading first if needed) and relaunch. */
export async function downloadAndInstall(): Promise<void> {
  const update = cachedUpdate;
  if (!update) return;
  try {
    if (currentStatus.state !== "ready") await download(update);
    // The bundled agent restarts with the app; in-flight swarm tasks are re-leased by the coordinator.
    setStatus({ state: "installing" });
    await update.install();
    await relaunch();
  } catch (err) {
    setStatus({ state: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

/** Whether a focus event should trigger a check (throttled so switching windows doesn't spam the feed). */
export function focusCheckDue(nowMs: number, lastMs: number): boolean {
  return nowMs - lastMs >= FOCUS_CHECK_MIN_MS;
}

function onFocus(): void {
  if (focusCheckDue(Date.now(), lastCheckMs)) void checkForUpdate();
}

export function startPeriodicCheck(): void {
  if (intervalId) return;
  // Initial check after a short delay (don't block app startup)
  timeoutId = setTimeout(() => checkForUpdate(), 5_000);
  intervalId = setInterval(() => checkForUpdate(), CHECK_INTERVAL_MS);
  if (typeof window !== "undefined") window.addEventListener("focus", onFocus);
}

export function stopPeriodicCheck(): void {
  if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
  if (typeof window !== "undefined") window.removeEventListener("focus", onFocus);
}
