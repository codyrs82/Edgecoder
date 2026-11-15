import { mount } from "svelte";
// #23: local font (no CDN, CSP-safe per #11), tokens + Tailwind, theme before first paint.
import "@fontsource-variable/inter";
import "./app.css";
import { initTheme } from "./lib/theme";
import App from "./App.svelte";

initTheme();

// macOS app window: the title bar is drawn by the page (Tauri overlay title bar), with room
// left for the traffic lights. Browsers and other platforms keep the plain header.
if ((globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ && /Mac/i.test(navigator.platform || navigator.userAgent)) {
  document.documentElement.dataset.titlebar = "overlay";
}

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
