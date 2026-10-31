// rw-identity-harden round 2 (tester t-id-harden D1): what a route's own catch may answer. An
// exception's own text never reaches a caller - an OS error names the vault's absolute path, a fetch
// error the upstream URL. Only the fixed messages the workbench's path validators throw
// (util/paths.ts, repositories/notes.ts, documents/paths.ts, the note routes' readPath/notePath) are
// answered as they are - the UI shows them; anything else is logged here and answered with the route's
// own fixed message.
import { logRefusal } from "../identity/refusal_log.ts";

const VALIDATOR_MESSAGES = new Set([
  "empty path",
  "path traversal rejected",
  "invalid path char",
  "invalid folder name",
  "notes must be .md files",
  "path must be a .md file",
  "path must be a notes/*.md file",
  "a user document is a .md file",
]);

export function isValidatorMessage(e: unknown): boolean {
  return VALIDATOR_MESSAGES.has(String((e as Error)?.message ?? ""));
}

// The message to answer for `e`: the validator's own text, or `fallback` (and the real one is logged,
// once a minute per route - a client can cause these at will).
export function publicError(e: unknown, fallback: string, where = "workbench"): string {
  if (isValidatorMessage(e)) return String((e as Error).message);
  const m = String((e as Error)?.message ?? e);
  logRefusal(`${where}: ${fallback}`, `[${where}] ${fallback}: ${m}`);
  return fallback;
}
