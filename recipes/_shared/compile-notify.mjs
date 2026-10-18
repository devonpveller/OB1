/**
 * compile-notify - the compile's research notifications (research-workbench
 * D13 items 6-7). They land INSIDE the research front end only - never
 * Mattermost, never Telegram (those are the sysadmin channels; a plane-wide
 * outage reaches them through that plane's own health monitoring).
 *
 * Sinks, in order:
 *   1. the retrieval contract's producer API, rpc/post_research_notification
 *      (research-workbench P0: research_notifications, deduped by class +
 *      subject + slug + entity) - used when the database has it;
 *   2. otherwise the compile's notification ledger, a JSONL file beside the
 *      failed-ids ledger (<out-dir>/.compile-notifications.jsonl, or
 *      WIKI_NOTIFY_FILE) that the front end reads until P0 is deployed.
 * Within one run a notification with the same (class, subject, slug, entity)
 * is posted once.
 *
 * Classes (P0's notification_classes registry): "transient" (the LLM did not
 * perform) and "structural" (not the LLM: validation, recipe, row or file
 * write).
 */
import fs from "node:fs";
import path from "node:path";

const OB_URL = () => (process.env.OPEN_BRAIN_URL || "http://openbrain-rest").replace(/\/+$/, "");
const _posted = new Set();
let _rpcMissing = false;

export function notifyFile(outDir) {
  return process.env.WIKI_NOTIFY_FILE ||
    path.join(outDir || process.env.OB_WIKI_OUT_DIR || "./wikis", ".compile-notifications.jsonl");
}

export async function notify({ cls, subject, slug = null, entity = null, error = null, outDir }) {
  const key = [cls, subject, slug ?? "", entity ?? ""].join("\u001f");
  if (_posted.has(key)) return false;
  _posted.add(key);
  const err = error == null ? null : String(error).slice(0, 1000);
  console.error(`[notify] ${cls}: ${subject}${slug ? ` (slug ${slug})` : ""}${err ? ` - ${err.slice(0, 300)}` : ""}`);
  if (!_rpcMissing) {
    try {
      const r = await fetch(`${OB_URL()}/rest/v1/rpc/post_research_notification`, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: "local-trust" },
        body: JSON.stringify({ p_class: cls, p_subject: subject, p_slug: slug, p_entity: entity == null ? null : String(entity), p_error: err }),
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) return true;
      const t = await r.text().catch(() => "");
      if (r.status === 404 || /PGRST202|could not find the function/i.test(t)) _rpcMissing = true;
      else console.error(`[notify] contract sink refused (${r.status} ${t.slice(0, 160)}); using the ledger file`);
    } catch (e) {
      console.error(`[notify] contract sink unreachable (${e?.message || e}); using the ledger file`);
    }
  }
  try {
    const f = notifyFile(outDir);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({
      class: cls, subject, slug, entity: entity == null ? null : String(entity), error: err,
      origin: "compile", at: new Date().toISOString(),
    }) + "\n");
    return true;
  } catch (e) {
    console.error(`[notify] ledger write FAILED: ${e?.message || e}`);
    return false;
  }
}

export function _resetNotifyForTests() {
  _posted.clear();
  _rpcMissing = false;
}
