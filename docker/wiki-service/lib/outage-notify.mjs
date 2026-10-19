/**
 * outage-notify - the wiki-service's notification for a compile that could
 * not run because the DATABASE was unavailable (rw-p1a-render attempt 4,
 * tester NA3-3: such a compile failed loudly in the log, held its watermark,
 * and put NOTHING in the research notification sink).
 *
 * One `transient` notification (the class of the outage row write,
 * "row write failed: database unavailable") per OUTAGE: compiles that keep
 * failing during the same outage are logged, not notified again; a compile
 * that completes ends the outage, so the next one is notified. A failure the
 * compile's own recipe already notified as transient (its stderr carries a
 * "[notify] transient:" line) is not notified twice. The watermark is the
 * caller's: compile()'s failure path never persists state.
 *
 * PURE apart from the injected notify/forget (compile-notify.mjs) and the
 * classifier (wiki-pages.mjs isDatabaseUnavailableError), so the build gate
 * tests it without /recipes.
 */
export const OUTAGE_SUBJECT = "compile failed: database unavailable (wiki-service)";

export function createOutageNotifier({ isUnavailable, notify, forget, outDir, log = console.error }) {
  let open = false;
  return {
    async onFailed(message, childStderr = "") {
      const msg = String(message ?? "");
      if (!isUnavailable(msg)) return { notified: false, reason: "not a database outage" };
      if (/\[notify\] transient:/.test(String(childStderr ?? ""))) {
        open = true;
        return { notified: false, reason: "the compile already notified this outage" };
      }
      if (open) return { notified: false, reason: "the same outage is already notified" };
      open = true;
      try {
        await notify({ cls: "transient", subject: OUTAGE_SUBJECT, error: msg.slice(0, 300), outDir });
        log(`[wiki-service] database outage: one transient notification sent (${OUTAGE_SUBJECT}); the watermark is held`);
        return { notified: true, reason: "database outage" };
      } catch (e) {
        log(`[wiki-service] database outage notification FAILED: ${e?.message || e}`);
        return { notified: false, reason: `notification failed: ${e?.message || e}` };
      }
    },
    onCompleted() {
      if (!open) return;
      open = false;
      try { forget({ cls: "transient", subject: OUTAGE_SUBJECT }); } catch { /* best effort */ }
    },
  };
}
