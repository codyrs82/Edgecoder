// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

// First-run local compute: the desktop shell (src-tauri/src/local_compute.rs) sets up Ollama and
// the Colima Docker sandbox itself. This module reads its progress and turns it into what the
// "Setting up local compute" screen shows. Framework-free so the root vitest suite covers it.

export type ComponentState =
  | "pending"
  | "checking"
  | "downloading"
  | "installing"
  | "starting"
  | "ready"
  | "error"
  | "skipped";

export interface ComponentStatus {
  state: ComponentState;
  /** "existing" (the user's own install), "managed" (installed by EdgeCoder) or "". */
  source: string;
  version: string;
  detail: string;
  activity: string;
  downloaded: number;
  total: number;
  error: string | null;
  required: boolean;
}

export interface ComputeStatus {
  /** Whether this platform gets managed downloads (macOS). */
  managed: boolean;
  state: "idle" | "running" | "ready" | "error";
  ollama: ComponentStatus;
  docker: ComponentStatus;
  ollama_url: string;
  docker_host: string | null;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost"]);
/** Ports the release CSP allows for Ollama (11435 is the shell's fallback next to an old Ollama). */
export const OLLAMA_PORTS = new Set(["11434", "11435"]);

/**
 * The Ollama base URL the webview should use for model management: the shell's, when it is
 * a loopback http URL on an allowed port, else the default. Never anything remote.
 */
export function ollamaBaseFor(status: Pick<ComputeStatus, "ollama_url"> | null | undefined): string {
  const fallback = "http://localhost:11434";
  const raw = status?.ollama_url?.trim();
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname) || !OLLAMA_PORTS.has(u.port)) return fallback;
    return `${u.protocol}//${u.hostname}:${u.port}`;
  } catch {
    return fallback;
  }
}

/** 0–100 while downloading with a known size, else null (indeterminate). */
export function progressPercent(c: ComponentStatus): number | null {
  if (c.state !== "downloading" || !(c.total > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((c.downloaded / c.total) * 100)));
}

export function formatBytes(n: number): string {
  if (!(n > 0)) return "0 MB";
  const mb = n / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** One line under a component's name. */
export function componentLine(c: ComponentStatus): string {
  switch (c.state) {
    case "pending":
      return "Waiting";
    case "downloading": {
      const pct = progressPercent(c);
      const base = c.detail || "Downloading";
      return pct === null ? base : `${base} (${formatBytes(c.downloaded)} of ${formatBytes(c.total)})`;
    }
    case "error":
      return c.error || "Something went wrong";
    case "skipped":
      return c.error || "Not set up on this platform";
    case "ready":
      return c.detail || (c.version ? `Running (${c.version})` : "Running");
    default:
      return c.detail || "Working";
  }
}

/** Whether the setup screen should be up: not ready yet, or failed. */
export function needsSetupScreen(status: ComputeStatus | null): boolean {
  if (!status || status.state === "ready") return false;
  if (status.state === "error") return true;
  // Only first-time setup gets the screen. Every launch re-checks Ollama and restarts the Docker VM
  // (the shell stops it on quit to free its memory); that routine start runs quietly.
  return [status.ollama, status.docker].some(isFirstTimeSetup);
}

/** Downloading or installing something, or creating the Docker VM (not just starting it). */
export function isFirstTimeSetup(c: ComponentStatus): boolean {
  return c.state === "downloading" || c.state === "installing" || (c.state === "starting" && c.detail.startsWith("Creating"));
}

/** The errors to show (only from components that block). */
export function blockingErrors(status: ComputeStatus): string[] {
  return [status.ollama, status.docker]
    .filter((c) => c.required && c.state === "error" && c.error)
    .map((c) => c.error as string);
}

/** Off macOS a missing Ollama needs a manual install; offer the download page for it. */
export function needsManualOllama(status: ComputeStatus): boolean {
  return !status.managed && status.ollama.state === "error";
}

/** The shell's setup status, or null outside the desktop app (dev in a browser, web build). */
export async function getLocalComputeStatus(): Promise<ComputeStatus | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ComputeStatus>("get_local_compute_status");
  } catch {
    return null;
  }
}

/** Start setup, or retry it after an error (no-op while it's running). */
export async function startLocalComputeSetup(): Promise<ComputeStatus | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<ComputeStatus>("start_local_compute_setup");
  } catch {
    return null;
  }
}
