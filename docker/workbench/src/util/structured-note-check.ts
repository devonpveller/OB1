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
export function structuredNoteViews(row: NoteRow, file: string, agent?: string): NoteRow[] {
  const views = [row, { slug: row.slug, title: row.title, body: file }];
  // rw-note-write-guard (2): the frontmatter writes `agent` beside the title, so the row view (title, then content) and
  // the whole-file view (agent sits between other lines and the content) never see the agent line next to the content.
  // Three more views put it there: agent then content, title then agent then content (agent + title + content as one
  // run), and agent then title then content. A sentence split across the agent field and the content is caught as the
  // guard would catch it if the row carried it.
  const a = (agent ?? "").trim();
  if (a) {
    views.push(
      { slug: row.slug, title: a, body: row.body },
      { slug: row.slug, title: `${row.title} ${a}`, body: row.body },
      { slug: row.slug, title: `${a} ${row.title}`, body: row.body },
    );
  }
  return views;
}

// rw-note-write-guard (3): a notebook (or title) slug longer than this makes a file name the OS rejects (255 bytes a
// component), which used to surface as a 500. Decided from the slug alone, before any check or write, so the answer is
// the same for every user (no existence signal). 100 leaves room for the ".md" and any `-note` suffix.
export const MAX_SLUG_LEN = 100;
export const NOTE_NAME_TOO_LONG = "the notebook or note name is too long; use a shorter one (at most 100 letters and digits)";
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
