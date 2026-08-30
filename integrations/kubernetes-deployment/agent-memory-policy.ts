/**
 * agent-memory-policy - what gets written, and what may be read back.
 *
 * Pure logic, no database and no network, so the decisions that govern the memory plane
 * can be tested without a stack - and so the two sides of the plane can be checked
 * AGAINST EACH OTHER rather than each on its own.
 *
 * THE FAILURE THIS MODULE EXISTS TO PREVENT. Upstream's Hermes integration writes
 * `visibility='personal'` by default while its recall scope filter silently drops
 * personal. Writes succeed, recall returns nothing, and it fails exactly at the
 * ops/personal boundary. Nothing errors; the plane is simply always empty.
 *
 * Locally the same trap is one line wide and pointed the other way: the DATABASE default
 * for `review_status` is 'pending' (schemas/agent-memory/schema.sql), and the default
 * recall gate admits only 'confirmed' and 'evidence_only'. So a writeback that lets the
 * column default apply produces a memory that the default recall can never return.
 * WRITEBACK_DEFAULTS therefore sets review_status EXPLICITLY, and
 * `defaultWritebackIsRecallable()` composes the two sides so the invariant is a test
 * rather than a comment.
 */

/** review_status values the schema permits. */
export type ReviewStatus =
  | "pending"
  | "confirmed"
  | "evidence_only"
  | "restricted"
  | "rejected"
  | "stale"
  | "merged";

export type Visibility =
  | "personal"
  | "channel"
  | "project"
  | "workspace"
  | "organization";

/**
 * What a writeback sets when the caller says nothing.
 *
 * `review_status` is NOT left to the column default. The column defaults to 'pending',
 * which the default recall gate excludes - see the module note. Everything an agent
 * writes unprompted is evidence, never instruction: `can_use_as_instruction` is absent
 * here on purpose, and the schema's CHECK refuses it for anything not user-confirmed or
 * imported, so it cannot be minted by accident from this side either.
 */
export const WRITEBACK_DEFAULTS = Object.freeze({
  visibility: "project" as Visibility,
  review_status: "evidence_only" as ReviewStatus,
  lifecycle_status: "active" as const,
  provenance_status: "generated" as const,
  can_use_as_evidence: true,
  requires_user_confirmation: true,
});

/** Statuses the CONSERVATIVE (default) recall admits. */
export const DEFAULT_RECALL_STATUSES: readonly ReviewStatus[] = Object.freeze([
  "confirmed",
  "evidence_only",
]);

/** The extra status `include_unconfirmed` opts into - and only this one. */
export const UNCONFIRMED_RECALL_STATUSES: readonly ReviewStatus[] = Object.freeze([
  "pending",
]);

/**
 * Which review statuses a recall may return.
 *
 * Deliberately asymmetric and deliberately a whitelist: 'rejected', 'restricted', 'stale'
 * and 'merged' are returned by NO path. A reviewer who rejects a memory has to be able to
 * trust that rejecting it means something, and an opt-in flag named
 * `include_unconfirmed` must not quietly also mean "include the things we threw away".
 */
export function recallReviewStatuses(includeUnconfirmed = false): ReviewStatus[] {
  return includeUnconfirmed
    ? [...DEFAULT_RECALL_STATUSES, ...UNCONFIRMED_RECALL_STATUSES]
    : [...DEFAULT_RECALL_STATUSES];
}

/**
 * THE PLANE-AGREEMENT INVARIANT, as code rather than prose.
 *
 * True when a memory written with the writeback defaults is admitted by the default
 * recall gate. If this is ever false, writes succeed and recall returns nothing - the
 * plane looks healthy and holds nothing. It is exported so the test composes the two
 * sides instead of asserting each separately and agreeing by coincidence.
 */
export function defaultWritebackIsRecallable(
  writebackDefaults: { review_status: ReviewStatus } = WRITEBACK_DEFAULTS,
  gate: readonly ReviewStatus[] = DEFAULT_RECALL_STATUSES,
): boolean {
  return gate.includes(writebackDefaults.review_status);
}

/** The columns the recall filter actually discriminates on. */
export interface RecallableRow {
  workspace_id: string;
  project_id: string | null;
  visibility: Visibility;
  review_status: ReviewStatus;
  lifecycle_status: string;
}

/**
 * Would `buildRecallScopeFilter(scope)` return this row?
 *
 * A TypeScript mirror of the SQL, and the reason it exists: the one-column check above
 * only ever compared `review_status`, so it could not see a disagreement in any OTHER
 * column - and there was one. The defaults set `visibility: 'project'` while leaving
 * `project_id` NULL, so a project-scoped recall (`am.project_id = $n`) matched nothing.
 * Writes succeeded, that recall returned nothing, nothing errored: the exact Hermes
 * failure this module's header claims to prevent, reproduced one column over and missed
 * because the invariant was too narrow to look there.
 *
 * Keep this in step with buildRecallScopeFilter. They are tested against each other.
 */
export function isRowRecallableBy(row: RecallableRow, scope: RecallScope): boolean {
  if (row.workspace_id !== scope.workspace_id) return false;
  if (scope.project_id !== undefined && scope.project_id !== null) {
    if (row.project_id !== scope.project_id) return false;
  }
  const visibility = scope.visibility && scope.visibility.length
    ? scope.visibility
    : (["project", "workspace", "organization"] as Visibility[]);
  if (!visibility.includes(row.visibility)) return false;
  if (row.lifecycle_status !== "active") return false;
  return recallReviewStatuses(scope.includeUnconfirmed).includes(row.review_status);
}

export interface RecallScope {
  workspace_id: string;
  project_id?: string | null;
  visibility?: readonly Visibility[];
  includeUnconfirmed?: boolean;
}

export interface SqlFragment {
  /** WHERE fragment using $1..$n placeholders, offset by the caller's existing params. */
  sql: string;
  params: unknown[];
}

/**
 * Build the recall WHERE fragment.
 *
 * PARAMETERISED, never interpolated. Every caller-supplied value goes into `params` and
 * the SQL carries only placeholders - this is the memory plane's read path, and a
 * concatenated workspace id here would be an injection into the one store that is meant
 * to be trustworthy.
 *
 * `lifecycle_status='active'` is enforced HERE rather than left to callers, because a
 * caller who forgets it gets superseded and disputed memories back and has no way to know.
 * The whole point of a scope builder is that the dangerous clauses are not optional.
 *
 * @param startIndex 1-based index of the first placeholder this fragment may use.
 */
export function buildRecallScopeFilter(scope: RecallScope, startIndex = 1): SqlFragment {
  if (!scope.workspace_id || !scope.workspace_id.trim()) {
    throw new Error("recall scope requires a workspace_id");
  }
  const params: unknown[] = [];
  const clauses: string[] = [];
  let i = startIndex;

  clauses.push(`am.workspace_id = $${i++}`);
  params.push(scope.workspace_id);

  // A recall without a project is workspace-wide ON PURPOSE; passing null must not
  // silently match rows whose project_id IS NULL and nothing else.
  if (scope.project_id !== undefined && scope.project_id !== null) {
    clauses.push(`am.project_id = $${i++}`);
    params.push(scope.project_id);
  }

  const visibility = scope.visibility && scope.visibility.length
    ? [...scope.visibility]
    : (["project", "workspace", "organization"] as Visibility[]);
  clauses.push(`am.visibility = ANY($${i++})`);
  params.push(visibility);

  clauses.push(`am.lifecycle_status = 'active'`);

  clauses.push(`am.review_status = ANY($${i++})`);
  params.push(recallReviewStatuses(scope.includeUnconfirmed));

  return { sql: clauses.join(" AND "), params };
}

/** Why a writeback was refused. `null` means it is safe to store. */
export type UnsafeReason =
  | "empty"
  | "too_large"
  | "secret_shaped"
  | null;

/** Content longer than this is refused outright (characters, not tokens). */
export const MAX_CONTENT_CHARS = 20000;

/**
 * Patterns for material that must never be written into a durable, recallable store.
 *
 * Shaped, not exhaustive - this is a guard against an agent pasting a credential into
 * memory, not a secret scanner. It is deliberately anchored on well-known prefixes and
 * long high-entropy runs rather than on anything that merely looks like a password, so
 * that ordinary prose about credentials ("rotate the API key") is not refused. A gate
 * that rejects normal writing gets turned off.
 */
const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bsk-[A-Za-z0-9]{32,}\b/, // OpenAI-style secret key
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // GitHub token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, // JWT
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/, // Slack token
]);

/**
 * Decide whether content may be stored. Returns the REASON rather than a boolean, so the
 * caller can tell the agent what to fix instead of failing opaquely.
 */
export function detectUnsafeContent(
  content: string,
  maxChars: number = MAX_CONTENT_CHARS,
): UnsafeReason {
  if (!content || !content.trim()) return "empty";
  if (content.length > maxChars) return "too_large";
  for (const re of SECRET_PATTERNS) {
    if (re.test(content)) return "secret_shaped";
  }
  return null;
}

export function isSafeToStore(content: string, maxChars: number = MAX_CONTENT_CHARS): boolean {
  return detectUnsafeContent(content, maxChars) === null;
}
