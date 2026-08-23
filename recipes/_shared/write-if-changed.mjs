/**
 * Idempotent file writes for the wiki emitters.
 *
 * Every emitter used to fs.writeFileSync unconditionally, so each compile
 * bumped the mtime of ~1,000 byte-identical files. The viewer's chokidar
 * polling (mtime-based) then saw them all as changed → a full 1–2 min Quartz
 * rebuild + a ~750MB snapshot copy per compile, forever (102GB of disk writes
 * in 6h measured 2026-08-23). Writing only when the bytes differ is what lets
 * the whole downstream pipeline (builder → snapshot → viewer) quiesce when
 * nothing actually changed.
 */
import fs from "node:fs";
import path from "node:path";

// Write `content` to `file` only when it differs from what is on disk.
// Returns true when a write happened.
export function writeIfChanged(file, content) {
  try {
    if (fs.readFileSync(file, "utf8") === content) return false;
  } catch {
    /* missing/unreadable → write */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return true;
}

// Same, but tolerant of volatile lines: a `generated_at: <ISO>` frontmatter
// line (or `"generated_at": "<ISO>"` in JSON) that is the ONLY difference does
// not force a rewrite. The on-disk stamp then truthfully means "when the
// content last changed", not "when the compiler last ran".
export function writeIfChangedStable(file, content, volatileKeys = ["generated_at"]) {
  const strip = (s) => {
    let out = s;
    for (const k of volatileKeys) {
      out = out
        .replace(new RegExp(`^${k}: .*$`, "m"), `${k}: <volatile>`)
        .replace(new RegExp(`"${k}": "[^"]*"`), `"${k}": "<volatile>"`);
    }
    return out;
  };
  try {
    if (strip(fs.readFileSync(file, "utf8")) === strip(content)) return false;
  } catch {
    /* missing/unreadable → write */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return true;
}
