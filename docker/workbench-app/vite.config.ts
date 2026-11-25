// The workbench app (rwr-app-scaffold): a Vite + React 19 app served at the ROOT by serve.mjs
// (not under a prefix: the app's own routes are /documents/x, /research, ...). Built in the image's
// build stage from package-lock.json (`npm ci`).
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// rwr-picker: the picker's dev-only test harness page is a second HTML entry, built ONLY with PICKER_HARNESS=1
// (the lab image); the production build is the one index.html.
const harness = process.env.PICKER_HARNESS === "1";
// rwr-flag-buttons: the same for /flag-harness.html (Flagged by you's read and link builder, which Cleanup will use), built ONLY with FLAG_HARNESS=1
const flagHarness = process.env.FLAG_HARNESS === "1";
const entries: Record<string, string> = {
  ...(harness ? { "picker-harness": resolve(__dirname, "picker-harness.html") } : {}),
  ...(flagHarness ? { "flag-harness": resolve(__dirname, "flag-harness.html") } : {}),
};

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "dist", sourcemap: false, modulePreload: { polyfill: false },
    ...(Object.keys(entries).length ? { rollupOptions: { input: { index: resolve(__dirname, "index.html"), ...entries } } } : {}),
  },
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["test/**/*.test.{ts,tsx}"],
    // the structural scans (test/picker-single.test.ts) read the whole of src/ for every case; with the editor in src/ and the
    // image build running the suites in parallel a case can pass 5 s, so the limit is 20 s (a hang still fails)
    testTimeout: 20000,
  },
});
