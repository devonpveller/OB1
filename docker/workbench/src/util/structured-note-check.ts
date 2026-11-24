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
export function structuredNoteViews(row: NoteRow, file: string): NoteRow[] {
  return [row, { slug: row.slug, title: row.title, body: file }];
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
