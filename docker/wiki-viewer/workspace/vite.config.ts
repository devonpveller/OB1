// The workspace (research-workbench P2b): a Vite + React 19 app the wiki viewer serves at /workspace.
// Built in the viewer image (Dockerfile stage `workspace`) from package-lock.json (`npm ci`), so
// CodeMirror 6 and every other package is the version the lockfile pins.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/workspace/",
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 2000 },
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
