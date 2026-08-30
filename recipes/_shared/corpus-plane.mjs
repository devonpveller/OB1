/**
 * corpus-plane - the exposure plane, applied to the recipes that READ `public.thoughts`
 * over PostgREST and PUBLISH what they read.
 *
 * ------------------------------------------------------------------------------------
 * WHY THIS EXISTS, and why it is not a nicety
 * ------------------------------------------------------------------------------------
 * dark-factory-unification U5 closed the personal-plane boundary on the openbrain-mcp
 * doors, on openbrain-ext, on agent-memory-api, on the entity-extraction worker and, in
 * the database, on `match_thoughts` / `upsert_thought`. A verifier then walked through a
 * door none of that covers:
 *
 *   `docker/wiki-service/wiki-service.mjs` runs `entity-wiki/generate-wiki.mjs` on a
 *   schedule with `--batch` / `--ids`, NEVER with `--semantic-expand`. So the published
 *   compile does not call `match_thoughts` at all - the one corpus reader the SQL floor
 *   covers. It reads the TABLE, directly, through PostgREST:
 *
 *       GET /thought_entities?select=...,thoughts(id,content,metadata,created_at)
 *       GET /thoughts?select=id,content,metadata,created_at&id=in.(...)
 *
 *   and writes what comes back into markdown pages and into `wiki_pages` rows that the
 *   wiki viewer serves. Verified unauthenticated from a container on `open-brain_obnet`:
 *   both requests answer 200.
 *
 * Patching a FUNCTION BODY is not underneath a caller that selects the table. So the read
 * itself carries the plane, in the statement, here.
 *
 * ------------------------------------------------------------------------------------
 * WHY THE APPLICATION AND NOT A DATABASE FLOOR
 * ------------------------------------------------------------------------------------
 * The database-side alternative is a view or a row-level policy that the compiler reads
 * through. Both were considered and neither is available without the change U5 is
 * explicitly not allowed to make:
 *
 *   - A VIEW only helps if PostgREST serves it and the compiler is pointed at it, which
 *     means granting SELECT on a new relation to `service_role`. That is a grant change.
 *   - ROW LEVEL SECURITY on `thoughts` would cover every PostgREST reader at once, which
 *     is strictly better - but PostgREST connects as `service_role` with no JWT
 *     (`PGRST_DB_ANON_ROLE: service_role`, and the Caddy proxy STRIPS `Authorization`),
 *     so there is no per-caller signal a policy could read. The only policy expressible
 *     is a blunt "this role never sees a labelled row", which changes what every existing
 *     PostgREST consumer sees and is a live-behaviour decision for the operator, not a
 *     test-time one.
 *
 * So this is the application-side fix, and it is honest about its reach: it closes the
 * READER THIS FILE IS IMPORTED BY. Every other PostgREST reader of `thoughts` is still
 * raw, which is why the U5 operational constraint is NOT lifted.
 *
 * ------------------------------------------------------------------------------------
 * THE PREDICATE
 * ------------------------------------------------------------------------------------
 * Character-identical in MEANING to `corpusPlanePredicate` in
 * `integrations/kubernetes-deployment/agent-memory-plane.ts` and to
 * `docker/init-agent-memory-corpus-plane.sql`:
 *
 *     metadata->>'exposure' IS NULL  OR  metadata->>'exposure' = ANY(ARRAY['ops'])
 *
 * An ABSENT label is unclaimed general corpus and stays visible (12,989 of 12,993
 * production rows, measured 2026-08-30). A PRESENT label means the agent-memory mirror
 * claimed the row for a plane, and only the ops plane's rows are served.
 *
 * NO PARAMETER. The plane is a constant, exactly as the SQL function takes no
 * `allowed_exposures` argument: a caller that may name its own plane is not bounded by
 * one. If a personal-plane compiler is ever wanted it gets its own entry point and its
 * own argued-for door.
 *
 * ------------------------------------------------------------------------------------
 * TWO LAYERS, DELIBERATELY
 * ------------------------------------------------------------------------------------
 * `CORPUS_PLANE_OR` goes in the URL so off-plane rows never leave the database, and
 * `onCorpusPlane` re-checks every row that arrives. The second layer is not belt-and-
 * braces: a PostgREST filter is a STRING in a query the caller assembles, and the whole
 * history of this boundary is predicates that were present and then were not. A row that
 * arrives labelled off-plane is dropped whatever the URL said, so a dropped `&` cannot
 * publish content - it can only publish less.
 */

/** The plane the published wiki compiles on. A constant, never an argument. */
export const CORPUS_PLANE = Object.freeze(["ops"]);

/** The metadata key every layer of this boundary reads. */
export const EXPOSURE_KEY = "exposure";

/**
 * The PostgREST spelling of the predicate, for a top-level `thoughts` request.
 * PostgREST has no COALESCE, so "unclaimed OR on the plane" is written as its two halves -
 * the same shape the agent-memory-api door uses.
 */
export const CORPUS_PLANE_OR =
  `or=(metadata->>${EXPOSURE_KEY}.is.null,metadata->>${EXPOSURE_KEY}.in.(${CORPUS_PLANE.join(",")}))`;

/**
 * The same predicate applied to an EMBEDDED resource (`thought_entities?select=...,thoughts(...)`).
 * PostgREST names an embedded filter by the alias: `thoughts.or=(...)`. Pair it with
 * `thoughts!inner(...)` in the select so an off-plane child DROPS ITS PARENT ROW rather
 * than nulling the embed - a parent row that survives still names a thought_id, and an id
 * is a disclosure.
 */
export function embeddedCorpusPlaneOr(alias) {
  if (!alias) throw new Error("embeddedCorpusPlaneOr: alias is required");
  return `${alias}.${CORPUS_PLANE_OR}`;
}

/**
 * Is this row on the plane? Takes a row OR a metadata object, so it works on
 * `{ metadata: {...} }` from a table select and on an embedded child alike.
 *
 * FAIL-CLOSED ON A SHAPE IT DOES NOT UNDERSTAND: a null/undefined row is off-plane. The
 * caller drops it; nothing is published from a row this cannot read.
 */
export function onCorpusPlane(rowOrMetadata) {
  if (rowOrMetadata === null || typeof rowOrMetadata !== "object") return false;
  const md = Object.prototype.hasOwnProperty.call(rowOrMetadata, "metadata")
    ? rowOrMetadata.metadata
    : rowOrMetadata;
  if (md === null || md === undefined) return true; // no metadata at all = unclaimed
  if (typeof md !== "object") return false;
  const label = md[EXPOSURE_KEY];
  if (label === null || label === undefined) return true; // unclaimed general corpus
  return CORPUS_PLANE.includes(String(label));
}

/** Keep only the on-plane rows. `pick` selects the labelled object when it is nested. */
export function keepOnCorpusPlane(rows, pick) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => onCorpusPlane(pick ? pick(r) : r));
}

/**
 * Remove any `exposure` a caller-supplied metadata object carries, before it is written to
 * the corpus. Same job as `stripCorpusClaim` in the TypeScript chokepoint: a compiler-
 * written dossier is unclaimed general corpus, and a write that could carry a label could
 * MINT a plane claim - which is a way to make a row invisible to this very predicate.
 */
export function stripCorpusClaim(metadata) {
  if (metadata === null || typeof metadata !== "object") return metadata;
  if (!Object.prototype.hasOwnProperty.call(metadata, EXPOSURE_KEY)) return metadata;
  const out = { ...metadata };
  delete out[EXPOSURE_KEY];
  return out;
}
