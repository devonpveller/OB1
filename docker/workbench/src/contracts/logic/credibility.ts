// The user_provided credibility term (ingestion model item 4): versioned like the weight table,
// applied to the refinery-scoped score only and ZERO for admission - otherwise dropping a
// source into a refinery would be a way around the floor and the database would stop being
// collective. The weights come from the credibility_terms registry entry; admission ignores
// the term whatever the entry says.
export interface TermDef {
  term_version: number;
  refinery_weight: number;
  admission_weight: number;
}

export function termDef(definition: Record<string, unknown> | undefined): TermDef {
  return {
    term_version: Number(definition?.term_version ?? 1),
    refinery_weight: Number(definition?.refinery_weight ?? 0),
    admission_weight: Number(definition?.admission_weight ?? 0),
  };
}

export function refineryScopedScore(base: number, userProvided: boolean, t: TermDef): number {
  return Math.min(1, base + (userProvided ? t.refinery_weight : 0));
}

// Admission never reads the term. The parameters exist so a caller that passes them cannot
// believe they counted.
export function admissionScore(base: number, _userProvided: boolean, _t: TermDef): number {
  return base;
}
