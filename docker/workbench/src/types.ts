// Shared TS types for source / thread (notebook) / membership / provenance
// shapes (P0.7). Mirrored from the live schema — keep in sync with:
//   sources           → OB1/docker/init-sources.sql
//   threads           → OB1/docker/init-threads.sql  (the "notebook" model)
//   thread_sources    → OB1/docker/init-threads.sql
//   source_entities   → OB1/docker/init-source-graph.sql
// Additive columns introduced by later phases are marked with their phase.
// Consumed by the workbench handlers and, conceptually, the inline components.

export type Uuid = string;

// content_type starts as a CHECK list; P5 replaces it with a content_types
// reference table + FK (so it becomes open-ended). Typed loosely as string.
export type ContentType = string;

export interface Source {
  id: Uuid;
  url: string | null;
  title: string;
  content: string;
  content_type: ContentType;
  tags: string[];
  notebook: string | null;
  domain: string | null;
  research_key: string | null;
  research_query: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  // P4 — reversible staged retract (additive).
  retracted_at?: string | null;
  retracted_by?: string | null;
  retraction_committed_at?: string | null;
}

// "Notebook" is the user-facing noun; the table stays `threads` (D-G).
export interface Notebook {
  id: Uuid;
  name: string;
  description: string | null;
  status: "active" | "archived";
  created_at: string;
  updated_at: string;
  // P2 — pinned slug (additive; generated once at create, never recomputed).
  slug?: string;
}

export type LinkType = "automatic" | "suggested" | "deliberate";
export type MembershipStatus = "confirmed" | "pending" | "hidden" | "inactive";

export interface ThreadSource {
  thread_id: Uuid;
  source_id: Uuid;
  link_type: LinkType;
  status: MembershipStatus;
  suggestion_reason: string | null;
  created_at: string;
  confirmed_at: string | null;
}

// source_entities — PK (source_id, entity_id); NO metadata column (P6.3).
export interface SourceEntity {
  source_id: Uuid;
  entity_id: number; // entities.id is BIGINT
  mention_role: string; // 'mentioned' | 'user_linked' (P6) | …
  confidence: number | null;
  evidence: string | null;
  created_at: string;
}

// P4 — append-only revision history (init-source-revisions.sql).
export interface SourceRevision {
  source_id: Uuid;
  revision: number;
  content: string;
  title: string;
  edited_at: string;
  edited_by: string;
}

// P5 — durable import/grounding job state (init-import-jobs.sql). The
// staged/committed pair drives the P6 grounding badge (G11).
export type ImportStatus =
  | "queued"
  | "extracting"
  | "embedding"
  | "linking"
  | "done"
  | "failed";

export interface ImportJob {
  id: Uuid;
  status: ImportStatus;
  source_id: Uuid | null;
  target_entity_ids: number[];
  target_notebook: string | null;
  error: string | null;
  staged: boolean;
  committed: boolean;
  duplicate: boolean;
  created_at: string;
  updated_at: string;
}

// Provenance leaf reference (P1) — a cited record's viewable address.
export interface LeafRef {
  type: "thought" | "source";
  id: string; // thought = BIGSERIAL (stringified); source = UUID
}
