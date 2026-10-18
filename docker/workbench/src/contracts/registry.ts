// Expansion by registration (D18). Every enumerated kind the contract exposes is a REGISTRY:
// declared, versioned rows in contract_registry_entries (content_types keeps its own table),
// never a closed list in a schema. Schemas therefore type these fields as plain strings with an
// `x-registry` annotation naming the registry; values are checked against the registry at
// runtime, on the write paths, so a new entry needs an INSERT and no schema change.
import { z } from "./deps.ts";
import type { Db } from "./db.ts";

// The registries the contract's schemas reference. The list exists so the generator can check
// that every x-registry annotation names a registry the migration declares (a typo would
// otherwise be an unvalidated free-text field).
export const REGISTRY = {
  recordStates: "record_states",
  sourceStates: "source_states",
  pageClasses: "page_classes",
  notificationClasses: "notification_classes",
  sourceFamilies: "source_families",
  origins: "origins",
  learningRecordFidelities: "learning_record_fidelities",
  contentTypes: "content_types",
  erasureReasons: "erasure_reasons",
  erasers: "erasers",
  dependenceKinds: "dependence_kinds",
  claimEdgeTypes: "claim_edge_types",
  userSourceStatuses: "user_source_statuses",
  admissionPaths: "admission_paths",
  admissionOutcomes: "admission_outcomes",
  jobKinds: "job_kinds",
  jobStates: "job_states",
  nodeKinds: "node_kinds",
  graphLinkKinds: "graph_link_kinds",
  refineryOrigins: "refinery_origins",
  refineryMemberKinds: "refinery_member_kinds",
  ideaStates: "idea_states",
  credibilityTerms: "credibility_terms",
  claimKinds: "claim_kinds",
  trailEventKinds: "trail_event_kinds",
  timelineEventKinds: "timeline_event_kinds",
  settings: "settings",
  implementationStates: "implementation_states",
} as const;
export type RegistryName = typeof REGISTRY[keyof typeof REGISTRY];

// A registry-valued field: an open string, annotated. NEVER z.enum - see the file header.
export function registryValue(name: RegistryName, example: string, description?: string) {
  return z.string().min(1).openapi({
    "x-registry": name,
    example,
    description: description ?? `A key of the \`${name}\` registry (GET /workbench/contract/registries/${name}).`,
  } as Record<string, unknown>);
}

export interface RegistryEntry {
  registry: string;
  key: string;
  version: number;
  label: string;
  definition: Record<string, unknown>;
  retired_at: string | null;
  superseded_by: string | null;
}

// Runtime reader over contract_registry_view, cached briefly: registries change by migration
// or by an operator INSERT, never per request.
export class RegistryReader {
  #cache: { at: number; rows: RegistryEntry[] } | null = null;
  constructor(private db: Db, private ttlMs = 30_000) {}

  async all(): Promise<RegistryEntry[]> {
    const now = Date.now();
    if (this.#cache && now - this.#cache.at < this.ttlMs) return this.#cache.rows;
    const rows = await this.db.query<RegistryEntry>(
      `SELECT registry, key, version, label, definition, retired_at, superseded_by
         FROM public.contract_registry_view ORDER BY registry, key`,
    );
    this.#cache = { at: now, rows };
    return rows;
  }

  invalidate(): void {
    this.#cache = null;
  }

  async entries(registry: string): Promise<RegistryEntry[]> {
    return (await this.all()).filter((e) => e.registry === registry);
  }

  async entry(registry: string, key: string): Promise<RegistryEntry | undefined> {
    return (await this.all()).find((e) => e.registry === registry && e.key === key);
  }

  async has(registry: string, key: string): Promise<boolean> {
    return (await this.entry(registry, key)) !== undefined;
  }

  // A definition field, or the fallback when the entry or the field is absent.
  async definitionOf<T>(registry: string, key: string, field: string, fallback: T): Promise<T> {
    const e = await this.entry(registry, key);
    const v = e?.definition?.[field];
    return v === undefined ? fallback : v as T;
  }
}

export class UnregisteredValue extends Error {
  constructor(public registry: string, public value: string) {
    super(`'${value}' is not a key of the ${registry} registry`);
  }
}

export async function requireRegistered(reg: RegistryReader, registry: RegistryName, value: string) {
  if (!(await reg.has(registry, value))) throw new UnregisteredValue(registry, value);
}
