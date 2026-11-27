// The one rule for a claim drawn from a person's PRIVATE idea report (rw-private-claim-reads; slot 570's rule,
// as library.ts:14,46 and ideas.ts:101-108 already apply it): research_private_report_claims marks it, and a shared
// read does not show it - not its text, not its id - to anyone but the owner of the marking report.
// `alias` is the claims alias; `ownerParam` a bound parameter (e.g. "$3") holding the caller's subject, or null for a
// read that has no caller (then a marked claim is excluded outright, as the library reads do). A NULL or empty owner
// matches no report, so it fails closed. The marker table keeps no foreign key onto public.claims after slot 570, so
// the tests read the marker, never a join to claims.
const MARKED = (alias: string) =>
  `EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = ${alias}.id)`;

export const claimNotPrivate = (alias: string): string => `NOT ${MARKED(alias)}`;

/** The same rule over a claim id EXPRESSION (a jsonb field of a function's row), not a claims alias. */
export const claimIdVisibleTo = (idExpr: string, ownerParam: string | null): string =>
  ownerParam === null
    ? `NOT EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = ${idExpr})`
    : `(NOT EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = ${idExpr})
       OR EXISTS (SELECT 1 FROM public.research_private_report_claims pc2
                    JOIN public.research_private_reports pr ON pr.id = pc2.report_id
                   WHERE pc2.claim_id = ${idExpr} AND pr.owner_sub = ${ownerParam}::text))`;

export const claimVisibleTo = (alias: string, ownerParam: string | null): string => claimIdVisibleTo(`${alias}.id`, ownerParam);
