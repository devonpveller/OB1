/**
 * drain-supervisor — decide whether the backfill drain has stalled.
 *
 * WHY THIS EXISTS (incident 2026-08-28/29). The backfill drain is a CHAIN:
 * each compile schedules the next one at the END of its try block
 * (`backfillContinueTimer`). That makes the chain self-perpetuating while
 * compiles succeed — and permanently dead the moment one fails, because a
 * throw jumps past the line that re-arms the timer.
 *
 * That is exactly what happened: the containers restarted, wiki-service booted
 * before PostgREST was serving, the boot compile died on a 503, and the drain
 * sat silent for 3h35m with 6,274 pages queued. Nothing surfaced it — the
 * process was healthy, the HTTP port answered, and the change-watch ticked
 * quietly (it only compiles when NEW content lands, so an empty queue of
 * changes looks identical to a broken drain).
 *
 * The supervisor is the FLOOR: independent of compile() entirely, so it does
 * not care WHERE a compile failed, only that pages are queued and nothing has
 * completed for a while.
 *
 * Deliberately NOT "restart the chain whenever a compile fails": that only
 * covers the failure paths we thought of. A floor covers the ones we did not.
 */

/**
 * @param {object} o
 * @param {boolean} o.running        a compile is in progress right now
 * @param {number}  o.queued         backfill-ELIGIBLE pages waiting (0 = idle)
 * @param {number}  o.msSinceCompile ms since the last compile FINISHED
 * @param {number}  o.idleFloorMs    how long is "too long" with work queued
 * @returns {boolean} true when the drain looks stalled and should be kicked
 */
export function shouldSupervisorCompile({ running, queued, msSinceCompile, idleFloorMs }) {
  // A compile is already running: the chain is alive by definition, and
  // firing another would just hit compile()'s own running guard.
  if (running) return false;
  // Nothing to drain. Note this is BACKFILL-ELIGIBLE count, not raw queue
  // depth: unlinked entities sit in planned.json forever by design, and
  // treating them as work would make the supervisor compile every tick.
  if (!Number.isFinite(queued) || queued <= 0) return false;
  // Unknown/absent clock: fail QUIET rather than compiling on every tick.
  if (!Number.isFinite(msSinceCompile) || msSinceCompile < 0) return false;
  if (!Number.isFinite(idleFloorMs) || idleFloorMs <= 0) return false;
  return msSinceCompile >= idleFloorMs;
}
