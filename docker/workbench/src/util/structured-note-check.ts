// rw-570-hub-note-scope R5 (operator decision 2026-11-24, second ruling): a structured / AI note (POST /workbench/notes,
// writeStructuredNote) is written into the SHARED wiki (content/notebooks/<nb>/<note>, class 'note', the writer named
// as the row's author). One whose file carries one of its WRITER's OWN private-report claim sentences is refused BEFORE
// anything is written (no vault file, no wiki_pages row); a sentence that is only in another user's private report
// changes nothing (saved and served, author-only like a person's note - no existence signal). The decision is the
// database's (slot 575's private_report_claims_note_refused(author, ...): the wiki guard's author-only predicate);
// this module turns its answer into the refusal, and keeps a structured note off the notebook's hub path.
// Pure: the database call is passed in (`ask`), so the unit test runs without a database.

// The one message a refused structured note gets (422).
export const NOTE_QUOTES_PRIVATE_REPORT = "this note quotes a private report; remove that sentence, or share the report first";
// An unanswered check (the database refused or failed): nothing is saved (503, fail closed).
export const NOTE_CHECK_UNAVAILABLE = "the note could not be checked; nothing was saved, try again";

export class StructuredNoteRefused extends Error {
  readonly status: 422 | 503;
  constructor(status: 422 | 503, message: string) {
    super(message);
    this.name = "StructuredNoteRefused";
    this.status = status;
  }
}

export type NoteRow = { slug: string; title: string; body: string };

// The file slug a structured note is stored under in content/notebooks/<nbSlug>/: never the notebook's own slug, which
// is its regenerable HUB page (content/notebooks/<nb>/<nb>, judged as shared text). From the slugs alone, never the
// content (attempt 2, tester defect: the hub path made another user's sentence answer differently).
export function structuredNoteFileSlug(nbSlug: string, titleSlug: string): string {
  return titleSlug === nbSlug ? `${titleSlug}-note` : titleSlug;
}
export type AskNoteRefused = (slug: string, title: string, body: string) => Promise<boolean | null>;

// The texts the writer's-own check reads (attempt 3, tester Case 6): the ROW view - exactly the slug, title and body
// the database's wiki guard judges for the stored row (slug || title, then body: a sentence split between the title
// and the content is contiguous there) - AND the whole-FILE view (attempt 2, F1: the frontmatter's agent / chat /
// notebook lines land in the shared vault file too). Refused when EITHER carries the writer's own sentence, so no row
// the guard would refuse passes the check and the vault file is never written for one.
// attempt 2 (tester, by reading): `source` is a sixth writer-supplied field that landed in the shared file RAW (no JSON
// encoding), so a newline in it could add frontmatter lines or end the frontmatter, and it was in no view. Every caller
// sends one of these two fixed values (the typed signature of writeStructuredNote); anything else is a 400.
export const NOTE_SOURCES = ["user_note", "ai_note"] as const;
export const isNoteSource = (v: unknown): v is (typeof NOTE_SOURCES)[number] => typeof v === "string" && (NOTE_SOURCES as readonly string[]).includes(v);

export type NoteFields = { title?: unknown; agent?: unknown; chat?: unknown; notebook?: unknown; content?: unknown };
export function structuredNoteViews(row: NoteRow, file: string, fields?: string | NoteFields): NoteRow[] {
  const views = [row, { slug: row.slug, title: row.title, body: file }];
  if (fields === undefined) return views;
  // rw-note-write-guard (2), widened after attempt 1: the vault file carries FIVE writer-supplied fields (title, agent, chat,
  // notebook, content) on separate lines, with the frontmatter's own words between them, and JSON.stringify rewrites a
  // tab (or a quote) inside a field into a backslash sequence - so neither the row view nor the whole-file view puts the
  // fields' DECODED text next to each other. These views do: every combination of fields (each alone, every pair, every
  // longer set, so a field the sentence skips over - the notebook line sits between chat and content - hides nothing) joined by a space, which the database's normaliser collapses, in the order the file renders
  // them (title, agent, chat, notebook, content) and again with the agent first (the form attempt 1 shipped). A sentence
  // of the writer's own split across ANY fields is judged as the guard would judge it if one row carried it.
  const f: NoteFields = typeof fields === "string" ? { title: row.title, agent: fields, content: row.body } : fields;
  if (typeof fields === "string" && !fields.trim()) return views;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const seen = new Set<string>();
  const add = (parts: string[]) => {
    const n = parts.length;
    for (let mask = 1; mask < 1 << n; mask++) {
      const run = parts.filter((_, i) => mask & (1 << i)).join(" ");
      if (seen.has(run)) continue;
      seen.add(run);
      views.push({ slug: row.slug, title: "", body: run });
    }
  };
  const nonEmpty = (xs: unknown[]) => xs.map(str).filter((v) => v.trim() !== "");
  add(nonEmpty([f.title, f.agent, f.chat, f.notebook, f.content]));
  add(nonEmpty([f.agent, f.title, f.chat, f.notebook, f.content]));
  return views;
}

// rw-note-write-guard: one writer at a time per note path. The sequence read-previous / write / re-check / row / undo /
// commit is not atomic, and without this a refused write's undo could take another request's saved file at the same
// path out (attempt 1, race R2: the clean note answered 201 with its file gone). In-process, which is the workbench's
// one process; keys are never user text (the repo-relative path).
const pathTails = new Map<string, Promise<void>>();
export async function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = pathTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => { release = r; });
  const tail = prev.then(() => mine);
  pathTails.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (pathTails.get(key) === tail) pathTails.delete(key);
  }
}

// rw-note-write-guard (3): a notebook (or title) slug longer than this makes a file name the OS rejects (255 bytes a
// component), which used to surface as a 500. Decided from the slug alone, before any check or write, so the answer is
// the same for every user (no existence signal). 100 leaves room for the ".md" and any `-note` suffix.
export const MAX_SLUG_LEN = 100;
export const NOTE_NAME_TOO_LONG = "the notebook or note name is too long; use a shorter one (at most 100 letters and digits)";
// attempt 1 (tester): a notebook name of 200,000 characters took 85-118 s to refuse (the slug work). The RAW length is
// capped first - far above any real name and far above the slug cap, so no name that slugs short is refused by it except
// absurd ones - and the answer is the same 422 for every user.
export const MAX_RAW_NAME_LEN = 1000;
export function assertRawNoteNamesFit(notebook: string, title: string): void {
  if (notebook.length > MAX_RAW_NAME_LEN || title.length > MAX_RAW_NAME_LEN) throw new StructuredNoteRefused(422, NOTE_NAME_TOO_LONG);
}
export function assertNoteNamesFit(nbSlug: string, fileSlug: string): void {
  if (nbSlug.length > MAX_SLUG_LEN || fileSlug.length > MAX_SLUG_LEN) throw new StructuredNoteRefused(422, NOTE_NAME_TOO_LONG);
}

// Throws StructuredNoteRefused (422 when a view quotes the writer's own private report, 503 when the check gives no
// answer); returns when the note may be written. One row or several views (every one must pass).
export async function assertStructuredNoteShareable(rows: NoteRow | NoteRow[], ask: AskNoteRefused): Promise<void> {
  let unanswered = false;
  for (const row of Array.isArray(rows) ? rows : [rows]) {
    let refused: boolean | null;
    try {
      refused = await ask(row.slug, row.title, row.body);
    } catch (e) {
      console.error("[notes] the structured-note check failed (the note is not saved):", (e as Error).message);
      refused = null;
    }
    if (refused === true) throw new StructuredNoteRefused(422, NOTE_QUOTES_PRIVATE_REPORT);
    if (refused === null || refused === undefined) unanswered = true;
  }
  if (unanswered) throw new StructuredNoteRefused(503, NOTE_CHECK_UNAVAILABLE);
}

// rw-note-write-guard (1) (F3/RV2): the row is the write the shared wiki's guard judges, so the writer's-own check is
// made AGAIN where the row is written, and a refusal there takes the vault file back out. The caller supplies the
// steps; this decides the order and what a failure means. Before: the row write swallowed the guard's 42501 and the
// request answered 201 with the file left (and later committed) in the shared vault.
export type GuardedNoteWrite = {
  views: NoteRow[]; // as structuredNoteViews
  ask: AskNoteRefused; // the pre-check (may be a test seam)
  askAtWrite: AskNoteRefused; // the same predicate again, never the seam
  writeFile: () => Promise<void>;
  // the strict row write: throws what the database threw (the guard's 42501 included); never swallows
  writeRow: () => Promise<void>;
  // undo writeFile: restore what the path held before, or remove it; must not throw for a missing file
  undoFile: () => Promise<void>;
};

const isGuardRefusal = (e: unknown) => {
  const x = e as { code?: string; fields?: { code?: string }; message?: string } | null;
  return x?.code === "42501" || x?.fields?.code === "42501" || /private[- ]report|row-level security|permission denied/i.test(x?.message ?? "");
};

export async function writeGuardedStructuredNote(w: GuardedNoteWrite): Promise<void> {
  await assertStructuredNoteShareable(w.views, w.ask);
  await w.writeFile();
  try {
    await assertStructuredNoteShareable(w.views, w.askAtWrite);
    await w.writeRow();
  } catch (e) {
    try {
      await w.undoFile();
    } catch (u) {
      console.error("[notes] the refused structured note's vault file could not be removed:", (u as Error).message);
    }
    if (e instanceof StructuredNoteRefused) throw e;
    if (isGuardRefusal(e)) throw new StructuredNoteRefused(422, NOTE_QUOTES_PRIVATE_REPORT);
    console.error("[notes] the structured note's row write failed (nothing is saved):", (e as Error).message);
    throw new StructuredNoteRefused(503, NOTE_CHECK_UNAVAILABLE);
  }
}
