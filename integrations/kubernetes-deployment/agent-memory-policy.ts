/**
 * agent-memory-policy - what gets written, and what may be read back.
 *
 * Pure logic, no database and no network, so the decisions that govern the memory plane
 * can be tested without a stack - and so the two sides of the plane can be checked
 * AGAINST EACH OTHER rather than each on its own.
 *
 * THE INVARIANT THIS MODULE ENFORCES, from the memory-plane plan (canonical copy in the
 * sibling plans repo; in-repo pointer at
 * documentation/implementation-guide/agent-memory-plane/PLAN.md):
 *
 *   §1.1 ACCESS BOUNDS WRITES (DECIDED, operator 2026-08-25, BINDING):
 *   a record's maximum exposure equals the access plane of the context that wrote it. A
 *   writer can never produce a memory more widely visible than the narrowest data plane it
 *   could read. Enforced mechanically - NEVER by model self-restraint.
 *
 *   §1.3 PLANE AGREEMENT: the default writeback's VISIBILITY/EXPOSURE must be provably
 *   returned by the default recall scope. The failure it guards is silent: the write side
 *   and the read side each look correct alone and disagree in combination, so a memory is
 *   written, nothing errors, and the default recall never returns it.
 *
 * A CORRECTION IS BAKED INTO THIS FILE. An earlier version of it stated the invariant over
 * `review_status` instead of visibility/exposure, and then - to make that version pass -
 * changed the write default from the plan's locked `pending` to `evidence_only`. That
 * inverted the governance posture: every agent write became immediately recallable instead
 * of waiting for a human. The subject under test had been bent to fit the test. The
 * defaults below are §1's, unmodified, and `pending` deliberately sits OUTSIDE the default
 * recall gate - a memory nobody has reviewed is not returned until someone asks for it with
 * `include_unconfirmed`.
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

/**
 * §1.1 exposure classes. NOT a caller field - see `stampExposure`.
 *
 *   ops      - the writing context had NO personal-plane inputs: agent-org efforts that
 *              never consumed Tier-2 advisor output, little-coder, claude-sessions rollups.
 *   personal - the writing context COULD read personal-plane data: OWUI assistant surfaces,
 *              tainted efforts.
 */
export type Exposure = "ops" | "personal";

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
  // §1, LOCKED: 'pending'. Not 'evidence_only' - see the correction in the module header.
  // A memory no human has looked at is not recallable by default; that is the point of the
  // review door, and writing 'evidence_only' here quietly removed it.
  review_status: "pending" as ReviewStatus,
  lifecycle_status: "active" as const,
  provenance_status: "generated" as const,
  can_use_as_evidence: true,
  requires_user_confirmation: true,
  // §1: confidence <= 0.6 for anything an agent writes unprompted.
  confidence: 0.5,
  // The SAFE end of the exposure axis. A writer that says nothing gets the narrowest
  // plane, never the widest - the door overrides this with its own forced value.
  exposure: "personal" as Exposure,
});

/** Exposure classes a recall returns when the caller does not narrow it. */
export const DEFAULT_RECALL_EXPOSURES: readonly Exposure[] = Object.freeze(["ops"]);

/**
 * §1.1: LANE STAMPING HAPPENS AT DOORS, NOT BY WRITERS.
 *
 * The exposure of a memory is a property of the CONTEXT THAT WROTE IT, and a writer is
 * exactly the party that cannot be trusted to report it - a compromised or confused agent
 * would simply claim `ops`. So the caller's value is ignored, and the door supplies the
 * forced value it was configured with.
 *
 * `tainted` is the mechanical demotion rule: an agent-org effort is ops-clean by
 * construction UNLESS it consumed Tier-2 advisor output (that corpus includes
 * personal-plane, gmail-derived sources) or its goal text came from a personal-plane
 * surface. The orchestrator knows both; this function does not guess.
 *
 * Demotion only. There is no argument that widens exposure, because widening is a human
 * decision and lives behind the review door's `promote_exposure` action.
 */
export function stampExposure(
  doorExposure: Exposure,
  opts: { tainted?: boolean; piiDetected?: boolean } = {},
): Exposure {
  if (doorExposure === "personal") return "personal";
  if (opts.tainted) return "personal";
  if (opts.piiDetected) return "personal";
  return "ops";
}

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
  /** §1.1. The `agent_memories.exposure` COLUMN (NOT NULL, CHECKed) since DFU C.9 H3. */
  exposure: Exposure;
}

/**
 * Would `buildRecallScopeFilter(scope)` return this row?
 *
 * A TypeScript mirror of the SQL, and the reason it exists: the one-column check above
 * only ever compared `review_status`, so it could not see a disagreement in any OTHER
 * column - and there was one. The defaults set `visibility: 'project'` while leaving
 * `project_id` NULL, so a project-scoped recall (`am.project_id = $n`) matched nothing.
 * Writes succeeded, that recall returned nothing, nothing errored - the same shape as the
 * review_status trap in the header, one column over, and missed because the invariant was
 * too narrow to look there. Reproduced against a real database, not reasoned about.
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
  // §1.1, and the half the earlier version of this predicate could not see at all.
  const exposure = scope.exposure && scope.exposure.length
    ? scope.exposure
    : DEFAULT_RECALL_EXPOSURES;
  if (!exposure.includes(row.exposure)) return false;
  if (row.lifecycle_status !== "active") return false;
  return recallReviewStatuses(scope.includeUnconfirmed).includes(row.review_status);
}

export interface RecallScope {
  workspace_id: string;
  project_id?: string | null;
  visibility?: readonly Visibility[];
  /** §1.1. Omitted = the ops plane only. A door forces this; callers do not widen it. */
  exposure?: readonly Exposure[];
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

  // §1.1 exposure gate, reading the TYPED COLUMN (DFU C.9 H3, operator 2026-08-31). It
  // used to read `COALESCE(am.metadata->>'exposure', 'personal')`: a jsonb key with a
  // read-time default, which is the shape H3 replaced. The column is NOT NULL and
  // CHECKed IN ('ops','personal'), so there is no absent value to default and no
  // misspelled one to coalesce - `= ANY` is now total. metadata->>'exposure' survives as a
  // non-authoritative mirror and nothing here reads it.
  const exposure = scope.exposure && scope.exposure.length
    ? [...scope.exposure]
    : [...DEFAULT_RECALL_EXPOSURES];
  clauses.push(`am.exposure = ANY($${i++})`);
  params.push(exposure);

  clauses.push(`am.lifecycle_status = 'active'`);

  clauses.push(`am.review_status = ANY($${i++})`);
  params.push(recallReviewStatuses(scope.includeUnconfirmed));

  return { sql: clauses.join(" AND "), params };
}

/**
 * §1.1: PII HEURISTICS DEMOTE, THEY NEVER BLESS AND THEY NEVER REJECT.
 *
 * Code and operational prose are full of email-shaped strings, so rejecting on them would
 * refuse ordinary writes and the gate would be switched off. Detection instead forces
 * `exposure='personal'` (via `stampExposure`) and a review-queue entry, which is the
 * conservative direction: the memory is kept, and it is kept where the narrower plane is.
 *
 * Deliberately NOT part of `detectUnsafeContent` - that function answers "may this be
 * stored at all", and conflating the two would turn a demotion into a refusal.
 */
const PII_PATTERNS: readonly RegExp[] = Object.freeze([
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,        // email address
  /\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/,        // NANP phone
  /\b\d{3}-\d{2}-\d{4}\b/,                                    // US SSN shape
  /\b(?:\d[ -]*?){13,16}\b/,                                   // payment card shape
]);

export function detectPii(content: string): boolean {
  if (!content) return false;
  return PII_PATTERNS.some((re) => re.test(content));
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
