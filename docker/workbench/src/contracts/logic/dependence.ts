// D5 stage 2: aggregate source_dependence() rows into the contract's Dependence record. PURE.
// Which kinds block erasure and which the sever tool may remove is DECLARED in the
// dependence_kinds registry; an undeclared kind blocks and is not severable (fail closed).
export interface DependenceRow {
  kind: string;
  ref: string;
  detail: Record<string, unknown>;
}

export interface KindDef {
  blocks_erase: boolean;
  severable: boolean;
}

export function kindDefs(
  entries: { key: string; definition: Record<string, unknown> }[],
): Map<string, KindDef> {
  return new Map(entries.map((e) => [e.key, {
    blocks_erase: e.definition?.blocks_erase !== false,
    severable: e.definition?.severable === true,
  }]));
}

const UNDECLARED: KindDef = { blocks_erase: true, severable: false };

export function aggregateDependence(rows: DependenceRow[], defs: Map<string, KindDef>) {
  const counts: Record<string, number> = {};
  const claimsByEdgeType: Record<string, number> = {};
  let blocking = 0;
  const connections = rows.map((r) => {
    const d = defs.get(r.kind) ?? UNDECLARED;
    counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    if (r.kind === "claim_edge") {
      const et = String(r.detail?.edge_type ?? "unknown");
      claimsByEdgeType[et] = (claimsByEdgeType[et] ?? 0) + 1;
    }
    if (d.blocks_erase) blocking++;
    return { kind: r.kind, ref: r.ref, detail: r.detail ?? {}, ...d };
  });
  return { blocking, total: rows.length, counts, claims_by_edge_type: claimsByEdgeType, connections };
}
