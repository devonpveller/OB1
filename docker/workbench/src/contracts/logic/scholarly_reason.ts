// What quality(id) may serve from a source's scholarly record and credibility reasons
// (research-workbench P3a attempt 2, tester t-rw-p3a finding 3). Attempt 1's resolver stored the
// fetch error's message as the unresolved reason, and that message carried the request URL with
// `api_key=<OPENALEX_API_KEY>&mailto=<SCHOLARLY_MAILTO>`; quality(id) served it under
// signals.scholarly.reason, through the cloud door too. The research service now forms a reason
// from a closed vocabulary of codes (integrations/research-service/scholarly.ts); this side
// serves signals.scholarly.reason ONLY when every token is one of those codes, and redacts any
// credibility reason line that carries credential-shaped text. The pattern below is the same
// string as scholarly.ts SCHOLARLY_REASON_PATTERN (research-service scholarly.test.ts asserts
// they are equal, so the two cannot drift by convention).
export const SCHOLARLY_REASON_PATTERN =
  "^(?:(?:OpenAlex|OpenAlex authors|Crossref) (?:\\d{3}|network error|timeout|unreadable answer) \\((?:api\\.openalex\\.org|api\\.crossref\\.org)\\)" +
  "|OpenAlex not keyed|Crossref fallback: author works_count unresolved|no DOI to try Crossref with|no scholarly resolver configured)$";
const TOKEN = new RegExp(SCHOLARLY_REASON_PATTERN);

export const REDACTED_SCHOLARLY_REASON = "reason redacted (not an allow-listed reason code)";
export const REDACTED_REASON = "reason redacted (it carried a URL or credential-shaped text)";

export function scholarlyReasonAllowed(reason: unknown): boolean {
  return typeof reason === "string" && reason.length > 0 && reason.length <= 400 &&
    reason.split("; ").every((t) => TOKEN.test(t));
}

const SECRET_SHAPED = /(?:api[_-]?key|apikey|mailto|token|secret|password|authorization)\s*[=:]|https?:\/\/[^\s)]*\?/i;

/** A credibility reason line with nothing credential-shaped in it. */
export function safeReasonText(text: unknown): string {
  const s = String(text ?? "");
  return SECRET_SHAPED.test(s) ? REDACTED_REASON : s;
}

const SCHOLARLY_FIELDS = ["state", "identifier", "doi", "cited_by", "published", "authors", "resolved_at", "via"];

/** The scholarly record as served: allow-listed fields, and an allow-listed reason or the redaction. */
export function safeScholarly(rec: unknown): Record<string, unknown> | null {
  if (!rec || typeof rec !== "object") return null;
  const r = rec as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of SCHOLARLY_FIELDS) if (k in r) out[k] = r[k];
  if (r.reason !== undefined && r.reason !== null) out.reason = scholarlyReasonAllowed(r.reason) ? r.reason : REDACTED_SCHOLARLY_REASON;
  return out;
}

/**
 * The signals quality(id) serves. A family's signals are numbers, classes and the source's own
 * author identity (credibility.ts GeneralSignals / ScholarlySignals); a `scholarly` member goes
 * through safeScholarly; any other string value goes through safeReasonText.
 */
export function safeSignals(signals: unknown): Record<string, unknown> {
  if (!signals || typeof signals !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(signals as Record<string, unknown>)) {
    if (k === "scholarly") { const s = safeScholarly(v); if (s) out[k] = s; continue; }
    out[k] = typeof v === "string" ? safeReasonText(v) : v;
  }
  return out;
}
