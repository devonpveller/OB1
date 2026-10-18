// What quality(id) may serve from a source's scholarly record and credibility reasons
// (research-workbench P3a attempt 2, tester t-rw-p3a finding 3). Attempt 1's resolver stored the
// fetch error's message as the unresolved reason, and that message carried the request URL with
// `api_key=<OPENALEX_API_KEY>&mailto=<SCHOLARLY_MAILTO>`; quality(id) served it under
// signals.scholarly.reason, through the cloud door too. The research service now forms a reason
// from a closed vocabulary of codes (integrations/research-service/scholarly.ts); this side
// serves signals.scholarly.reason ONLY when every token is one of those codes, and redacts any
// credibility reason line that carries credential-shaped text. The patterns below are the same
// strings as scholarly.ts's (research-service scholarly.test.ts asserts they are equal and runs
// one vector list through both implementations, so the two cannot drift by convention).
// Attempt 3 (tester t-rw-p3a-2 near-misses): a bare key and a fully percent-encoded query passed
// the credential test (it is now also a token-shape test, on the text and its percent-decoded
// form), and the record's data fields (doi, identifier, authors) were served unscanned (each is
// now kept only when it carries nothing credential-shaped, every field to its shape).
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

export const SECRET_SHAPED_PATTERN =
  "(?:api[_-]?key|apikey|mailto|token|secret|password|authorization)\\s*[=:]|https?:\\/\\/[^\\s)]*\\?";
export const TOKEN_SHAPED_PATTERN =
  "(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])";
export const NOT_A_TOKEN_PATTERN =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|\\b10\\.\\d{4,9}\\/[^\\s\"'<>]+|\\b\\d{4}-\\d{4}-\\d{4}-\\d{3}[0-9X]\\b";
const SECRET_SHAPED = new RegExp(SECRET_SHAPED_PATTERN, "i");
const TOKEN_SHAPED = new RegExp(TOKEN_SHAPED_PATTERN);
const NOT_A_TOKEN = new RegExp(NOT_A_TOKEN_PATTERN, "g");

function percentDecoded(s: string): string {
  let t = s;
  for (let i = 0; i < 3; i++) {
    const d = t.replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
    if (d === t) break;
    t = d;
  }
  return t;
}

/** Credential-shaped: an assignment, a URL query, or a bare token - on the text or its decoded form. */
export function credentialShaped(text: unknown): boolean {
  const raw = String(text ?? "");
  for (const t of [raw, percentDecoded(raw)]) {
    if (SECRET_SHAPED.test(t)) return true;
    if (TOKEN_SHAPED.test(t.replace(NOT_A_TOKEN, " "))) return true;
  }
  return false;
}

/** A credibility reason line with nothing credential-shaped in it. */
export function safeReasonText(text: unknown): string {
  const s = String(text ?? "");
  return credentialShaped(s) ? REDACTED_REASON : s;
}

const PUBLISHED_RE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const cleanText = (v: unknown): string | null => (typeof v === "string" && v.length <= 400 && !credentialShaped(v) ? v : null);
const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/**
 * The scholarly record as served: the allow-listed fields, each to its shape (the research
 * service's safeScholarlyRecord, the same rules), and an allow-listed reason or the redaction.
 */
export function safeScholarly(rec: unknown): Record<string, unknown> | null {
  if (!rec || typeof rec !== "object") return null;
  const r = rec as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ("state" in r) out.state = r.state === "resolved" || r.state === "unresolved" ? r.state : "unresolved";
  if ("identifier" in r) {
    const id = r.identifier as Record<string, unknown> | null;
    const kind = id && ["doi", "pmid", "pmcid", "arxiv"].includes(String(id.kind)) ? String(id.kind) : null;
    const value = id ? cleanText(id.value) : null;
    out.identifier = kind && value ? { kind, value } : null;
  }
  if ("doi" in r) out.doi = cleanText(r.doi);
  if ("cited_by" in r) out.cited_by = count(r.cited_by);
  if ("published" in r) out.published = typeof r.published === "string" && PUBLISHED_RE.test(r.published) ? r.published : null;
  if ("authors" in r) {
    out.authors = (Array.isArray(r.authors) ? r.authors : []).slice(0, 50).map((a) => {
      const x = (a ?? {}) as Record<string, unknown>;
      return { id: cleanText(x.id), name: cleanText(x.name), works_count: count(x.works_count) };
    });
  }
  if ("resolved_at" in r) out.resolved_at = typeof r.resolved_at === "string" && ISO_RE.test(r.resolved_at) ? r.resolved_at : null;
  if ("via" in r) out.via = r.via === "openalex" || r.via === "crossref" ? r.via : null;
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
