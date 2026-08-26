// Build-time patch: make Quartz's file watcher actually POLL.
//
// ROOT CAUSE (found 2026-08-26, after a new note failed to build for 7+ min):
// Quartz calls `chokidar.watch(".", { persistent, cwd, ignoreInitial })` with
// no `usePolling`. The compose file sets CHOKIDAR_USEPOLLING=true, but chokidar
// does NOT read that env var - it is a Vite/CRA convention. So the watcher fell
// back to native inotify across the /quartz/content -> /wiki symlink into a
// volume written by ANOTHER container, where `change` events fire but `add`
// events do not. Consequence: a NEW page (a user note, or any of the ~50 pages
// the drain creates per compile) was never picked up, and only ever appeared
// after a full cold rebuild - which is exactly the "nothing shows up until the
// nightly rebuild" symptom.
//
// Polling stats the tree on an interval, so `add` fires reliably. Interval is
// env-tunable because the vault is ~30k files: WIKI_WATCH_POLL_MS (default
// 10s) trades detection latency against stat load.
//
// A SCRIPT, not an inline sed - the replacement spans multiple lines with
// braces and quotes. Asserts its anchor and verifies the result, so a
// QUARTZ_REF bump fails the build loudly.
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "/quartz/quartz/build.ts";
const FROM = `  const watcher = chokidar.watch(".", {
    persistent: true,
    cwd: argv.directory,
    ignoreInitial: true,
  })`;
const TO = `  const watcher = chokidar.watch(".", {
    persistent: true,
    cwd: argv.directory,
    ignoreInitial: true,
    // See patches/watcher-polling.mjs: inotify does not deliver \`add\` events
    // for files another container creates under this symlinked volume, so new
    // pages were invisible until a full rebuild. Poll instead.
    usePolling: true,
    interval: Number(process.env.WIKI_WATCH_POLL_MS ?? 10000),
    binaryInterval: Number(process.env.WIKI_WATCH_POLL_MS ?? 10000) * 3,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 500 },
  })`;

const src = readFileSync(FILE, "utf8");
if (src.includes("usePolling: true")) {
  console.log("[watcher-polling] already applied");
  process.exit(0);
}
const count = src.split(FROM).length - 1;
if (count !== 1) {
  console.error(`[watcher-polling] anchor found ${count} times (expected 1) in ${FILE}`);
  process.exit(1);
}
writeFileSync(FILE, src.replace(FROM, TO), "utf8");
if (!readFileSync(FILE, "utf8").includes("usePolling: true")) {
  console.error("[watcher-polling] verification failed after write");
  process.exit(1);
}
console.log("[watcher-polling] applied: chokidar now polls, so new files are detected");
