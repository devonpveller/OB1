// The ONE shared path/asset normalizer (G9, §14.3, §11). Used by the notes
// write path (P3) and asset writes (P5) — never re-implemented per handler.
// Rejects absolute paths and ANY `..` segment, so a request can never escape
// its base dir (no `../../etc/...`).

// Control chars (NUL .. US, 0x00-0x1f) are disallowed in any path segment.
const CONTROL_CHARS = /[\x00-\x1f]/;

export function safeRelPath(rel: string): string {
  const parts = String(rel)
    .replace(/\\/g, "/")
    .split("/")
    .filter((p) => p.length > 0 && p !== ".");
  if (parts.length === 0) throw new Error("empty path");
  if (parts.some((p) => p === "..")) throw new Error("path traversal rejected");
  if (parts.some((p) => CONTROL_CHARS.test(p))) throw new Error("invalid path char");
  return parts.join("/");
}

// Like safeRelPath but for FOLDER paths: no `.md` requirement, and also rejects
// a `.git` segment so a folder op can never touch the repo metadata.
export function safeFolderRel(rel: string): string {
  const safe = safeRelPath(rel);
  if (safe.split("/").some((p) => p === ".git")) throw new Error("invalid folder name");
  return safe;
}

export function safeJoin(baseDir: string, rel: string): string {
  return `${baseDir.replace(/\/+$/, "")}/${safeRelPath(rel)}`;
}
