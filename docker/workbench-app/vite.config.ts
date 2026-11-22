// The workbench app (rwr-app-scaffold): a Vite + React 19 app served at the ROOT by serve.mjs
// (not under a prefix: the app's own routes are /documents/x, /research, ...). Built in the image's
// build stage from package-lock.json (`npm ci`).
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// rwr-picker: the picker's dev-only test harness page is a second HTML entry, built ONLY with PICKER_HARNESS=1
// (the lab image); the production build is the one index.html.
const harness = process.env.PICKER_HARNESS === "1";

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist", sourcemap: false, modulePreload: { polyfill: false },
    ...(harness ? { rollupOptions: { input: { index: resolve(__dirname, "index.html"), "picker-harness": resolve(__dirname, "picker-harness.html") } } } : {}),
  },
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
