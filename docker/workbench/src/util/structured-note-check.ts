// rw-570-hub-note-scope R5 (operator decision 2026-11-24): a structured / AI note (POST /workbench/notes,
// writeStructuredNote) is written into the SHARED wiki (content/notebooks/..., class 'note', no author). One whose
// text carries a private-report claim's sentence - the writer's own included - is refused BEFORE anything is written
// (no vault file, no wiki_pages row). The decision is the database's (slot 575's private_report_claims_note_refused:
// slot 570's wiki guard predicate on the row the write would store); this module only turns its answer into the
// refusal. Pure: the database call is passed in (`ask`), so the unit test runs without a database.

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
export type AskNoteRefused = (slug: string, title: string, body: string) => Promise<boolean | null>;

// Throws StructuredNoteRefused (422 when the row quotes a private report, 503 when the check gives no answer);
// returns when the note may be written.
export async function assertStructuredNoteShareable(row: NoteRow, ask: AskNoteRefused): Promise<void> {
  let refused: boolean | null;
  try {
    refused = await ask(row.slug, row.title, row.body);
  } catch (e) {
    console.error("[notes] the structured-note check failed (the note is not saved):", (e as Error).message);
    refused = null;
  }
  if (refused === null || refused === undefined) throw new StructuredNoteRefused(503, NOTE_CHECK_UNAVAILABLE);
  if (refused) throw new StructuredNoteRefused(422, NOTE_QUOTES_PRIVATE_REPORT);
}
