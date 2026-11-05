// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Webview origins of the packaged desktop app (Tauri 2), plus the Vite dev server.
 * - macOS and Linux (WebKit): `tauri://localhost`.
 * - Windows (WebView2): `http://tauri.localhost` by default; `https://tauri.localhost` when the app
 *   sets `useHttpsScheme`. Leaving the http form out blocked every Windows request with CORS
 *   (password sign-in failed and the OAuth token exchange was refused).
 */
export const DESKTOP_APP_ORIGINS: readonly string[] = [
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://localhost:1420",
];

/** The request's Origin if it is a desktop app origin, else undefined (for hand-written CORS headers). */
export function desktopOriginOf(origin: string | string[] | undefined): string | undefined {
  const o = Array.isArray(origin) ? origin[0] : origin;
  return o && DESKTOP_APP_ORIGINS.includes(o) ? o : undefined;
}
