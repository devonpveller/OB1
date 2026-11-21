// The workbench app (rwr-app-scaffold): a Vite + React 19 app served at the ROOT by serve.mjs
// (not under a prefix: the app's own routes are /documents/x, /research, ...). Built in the image's
// build stage from package-lock.json (`npm ci`).
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false },
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
