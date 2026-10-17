// Record-state derivation for sources: ONE place maps stored columns to the contract's states.
// The lifecycle itself comes from SQL (public.source_lifecycle_state); this adds the record
// state overlay (a staged retract reads as 'redaction') and the evidence-only visibility rule,
// which is declared per state in the source_states registry (definition.database_wide).
export interface StoredSourceState {
  lifecycle: string; // active | suppressed | unlinked (from SQL), or held / erased
  staged_retract: boolean;
}

export function sourceRecordState(s: StoredSourceState): string {
  if (s.lifecycle === "active" && s.staged_retract) return "redaction";
  return s.lifecycle;
}

// The lifecycle states an evidence-only caller may receive, read from the registry so a new
// state declares its own visibility. An entry without the flag is NOT visible (fail closed).
export function evidenceVisibleStates(
  entries: { key: string; definition: Record<string, unknown> }[],
): Set<string> {
  return new Set(entries.filter((e) => e.definition?.database_wide === true).map((e) => e.key));
}
