import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// The design tokens are always this checkout's packages/tokens, even when node_modules is a link
// to another checkout (its @edgecoder/tokens link would resolve to that checkout's copy).
const tokens = (p: string) => fileURLToPath(new URL(`../packages/tokens/${p}`, import.meta.url));

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  resolve: {
    alias: {
      "@edgecoder/tokens/tokens.css": tokens("dist/tokens.css"),
      "@edgecoder/tokens/theme.css": tokens("src/theme.css"),
      "@edgecoder/tokens/tokens.json": tokens("src/tokens.json"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:4301",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/inference": {
        target: "http://localhost:4302",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/inference/, ""),
      },
      "/ollama": {
        target: "http://localhost:11434",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ollama/, ""),
      },
      "/chat": {
        // EDGECODER_IDE_URL points the dev UI at another IDE server (a test stack).
        target: process.env.EDGECODER_IDE_URL ?? "http://localhost:4304",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/chat/, ""),
      },
      "/portal": {
        target: "https://edgecoder-portal.fly.dev",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/portal/, ""),
      },
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      output: {
        manualChunks: {
          "monaco-editor": ["monaco-editor"],
        },
      },
    },
  },
});
