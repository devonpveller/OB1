/** The query the suggestion / hidden triage listing runs (registerSuggestionList in index.ts:
 * get_suggestions, get_hidden_suggestions). Its own module so d5-consumers.test.ts runs THIS
 * text against a disposable database (rw-p0b-purge-door, tester finding T2-3: a static regex
 * over index.ts passed with the filter commented out inside the SQL).
 *
 * $1 = the thread_sources status ('pending' | 'hidden'), $2 = an optional thread uuid.
 * D5 stage 1: a suppressed (or unlinked) source - retraction_committed_at set - is not triaged,
 * as the workbench's own triage list (notebooks.ts listSuggestions) already does.
 */
export const SUGGESTION_LIST_SQL = `SELECT ts.thread_id, ts.source_id, s.url, s.title,
                    ts.link_type, ts.suggestion_reason, ts.created_at
             FROM thread_sources ts
             JOIN sources s ON s.id = ts.source_id
             WHERE ts.status = $1
               AND s.retraction_committed_at IS NULL  -- D5 stage 1: a suppressed source is not triaged (as notebooks.ts listSuggestions)
               AND ($2::uuid IS NULL OR ts.thread_id = $2)
             ORDER BY ts.created_at DESC`;
