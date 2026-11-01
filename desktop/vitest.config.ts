import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";

// Component tests (#28): real Svelte components rendered in jsdom.
// Kept out of desktop/tests/, which the root (node, no svelte plugin) vitest runs.
export default defineConfig({
  plugins: [svelte({ hot: false }), svelteTesting()],
  test: {
    environment: "jsdom",
    include: ["component-tests/**/*.test.ts"],
    setupFiles: ["component-tests/setup.ts"],
    restoreMocks: true,
  },
});
