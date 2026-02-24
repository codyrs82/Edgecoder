import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
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
        target: "http://localhost:4304",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/chat/, ""),
      },
      "/portal": {
        target: "http://localhost:4305",
        changeOrigin: true,
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
