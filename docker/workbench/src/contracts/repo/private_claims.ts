// The one rule for a claim drawn from a person's PRIVATE idea report (rw-private-claim-reads; slot 570's rule,
// applied by library.ts, ideas.ts and every shared claim read).
//
// PRIVATE-ONLY: a claim research_private_report_claims marks AND that no shared synthesis also filed
// (claims.synthesis_id IS NULL). Slot 570's own definition: init-private-report-claims.sql:18-22 - "a claim linked in
// research_private_report_claims to any research_private_reports row ... is private, unless a SHARED synthesis also
// filed it (claims.synthesis_id set ...): shared knowledge, kept shared, counted as 'mixed'" (and workbench/README.md
// "A claim a shared synthesis also filed stays shared ('mixed')"). A MIXED claim is shared knowledge: every shared read
// shows it to everyone, and hiding it would take shared knowledge away and tell the reader that someone's private report
// marked that sentence (an oracle). A private-only claim is shown only to the owner of the marking report.
// `idExpr` is a SQL expression for the claim id; `ownerParam` a bound parameter (e.g. "$3") holding the caller's subject,
// or null for a read with no caller (then a private-only claim is excluded outright). A NULL or empty owner matches no
// report, so it fails closed. The marker table keeps no foreign key onto public.claims after slot 570, so the tests read
// the marker and the claim's own synthesis_id.
const PRIVATE_ONLY = (idExpr: string) =>
  `EXISTS (SELECT 1 FROM public.research_private_report_claims pc JOIN public.claims pcl ON pcl.id = pc.claim_id
            WHERE pc.claim_id = ${idExpr} AND pcl.synthesis_id IS NULL)`;

export const claimNotPrivate = (alias: string): string => `NOT ${PRIVATE_ONLY(`${alias}.id`)}`;

export const claimIdVisibleTo = (idExpr: string, ownerParam: string | null): string =>
  ownerParam === null
    ? `NOT ${PRIVATE_ONLY(idExpr)}`
    : `(NOT ${PRIVATE_ONLY(idExpr)}
       OR EXISTS (SELECT 1 FROM public.research_private_report_claims pc2
                    JOIN public.research_private_reports pr ON pr.id = pc2.report_id
                   WHERE pc2.claim_id = ${idExpr} AND pr.owner_sub = ${ownerParam}::text))`;

export const claimVisibleTo = (alias: string, ownerParam: string | null): string => claimIdVisibleTo(`${alias}.id`, ownerParam);
