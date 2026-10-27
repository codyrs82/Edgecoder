import { mount } from "svelte";
// #23: local font (no CDN, CSP-safe per #11), tokens + Tailwind, theme before first paint.
import "@fontsource-variable/inter";
import "./app.css";
import { initTheme } from "./lib/theme";
import App from "./App.svelte";

initTheme();

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
