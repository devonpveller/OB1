// The idea object and the idea refinery (D17 items 5-6), held user sources (ingestion model
// 2026-09-25) and the user document listing (D12). Terms: "idea refinery" (never "hub");
// "user document" (never "note" - notes are the legacy Quartz class).
import { z } from "../deps.ts";
import { REGISTRY, registryValue } from "../registry.ts";
import { Iso, recordState, StateDetail, uuid } from "./common.ts";
import { FX } from "./fixtures.ts";

export const DocumentLink = z.strictObject({
  kind: registryValue(REGISTRY.nodeKinds, "source"),
  id: z.string(),
  pin: z.number().int().nullable().openapi({ description: "the pinned revision; only the document defines pins" }),
  reference_id: uuid().nullable().openapi({
    description: "P2a: the reference record the link points at; when set, pin IS that record's pinned revision " +
      "(D12: pins live in the reference record, the listing points at it)",
  }),
}).openapi("DocumentLink");

// D12: the listing call returns title, path, updated and outbound links - nothing else, and
// never a body. Strict: a response carrying any other key is a contract violation (500).
export const DocumentListing = z.strictObject({
  title: z.string(),
  path: z.string().openapi({ example: FX.documentPath }),
  updated: Iso,
  outbound_links: z.array(DocumentLink),
}).openapi("DocumentListing");

export const Documents = z.strictObject({
  documents: z.array(DocumentListing),
}).openapi("Documents");

export const UserSource = z.object({
  source_id: uuid(FX.heldLinked),
  refinery_id: uuid(FX.idea),
  status: registryValue(REGISTRY.userSourceStatuses, "held"),
  state: recordState("held"),
  title: z.string(),
  url: z.string().nullable(),
  revision: z.number().int(),
  // rw-p8a4-ideas (ingestion model 2026-09-25, agreed 19:59): the scoped corroboration result and the trail
  corroboration: z.object({
    state: z.string().openapi({ example: "not_run", description: "not_run | scoped (no closed list, P0). held: not run until the source is folded in; " +
      "folded: the corroboration it received from the refinery's own sources (its sessions' and its user sources)" }),
    givers: z.number().int(),
    amount: z.number(),
  }),
  found_via: z.array(z.object({
    trail_id: z.string(), url: z.string(), source_id: z.string().nullable(), at: Iso,
  })).openapi({ description: "what the admission trail admitted found_via this source (directly or through its lead)" }),
}).openapi("UserSource");

export const UserSourceAddRequest = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  url: z.string().optional(),
  content_type: registryValue(REGISTRY.contentTypes, "manual").optional(),
  by: z.string().optional(),
}).openapi("UserSourceAddRequest");

export const UserSourceAdded = z.object({
  source: UserSource,
  chunks: z.number().int(),
  embedded: z.boolean(),
}).openapi("UserSourceAdded");

export const UserSourceRemoved = z.object({
  source_id: uuid(FX.heldRemovable),
  removed: z.boolean(),
  tombstoned: z.boolean().openapi({ description: "always false: a held source leaves no tombstone" }),
}).openapi("UserSourceRemoved");

export const HiddenRequest = z.object({
  node_kind: registryValue(REGISTRY.nodeKinds, "source"),
  node_ref: z.string().min(1),
  hidden: z.boolean(),
}).openapi("HiddenRequest");

export const HiddenState = z.object({
  refinery_id: uuid(FX.idea),
  node_kind: registryValue(REGISTRY.nodeKinds, "source"),
  node_ref: z.string(),
  hidden: z.boolean(),
}).openapi("HiddenState");

export const ContextNode = z.object({
  kind: registryValue(REGISTRY.nodeKinds, "source"),
  id: z.string(),
  title: z.string(),
  state: recordState("active"),
  hidden: z.boolean(),
}).openapi("ContextNode");

export const ContextLink = z.object({
  source: z.string(),
  target: z.string(),
  kind: registryValue(REGISTRY.graphLinkKinds, "grounds"),
  pin: z.number().int().nullable().openapi({ description: "mirrors the document's pin; null until the document pins it" }),
}).openapi("ContextLink");

export const SessionSummary = z.object({
  id: uuid(FX.job),
  status: registryValue(REGISTRY.jobStates, "done"),
  origin: registryValue(REGISTRY.origins, "mattermost"),
  query: z.string(),
  refinery_id: uuid(FX.idea).nullable(),
  created_at: Iso,
  finished_at: Iso.nullable(),
}).openapi("SessionSummary");

export const Refinery = z.object({
  origin: z.object({
    kind: registryValue(REGISTRY.refineryOrigins, "captured_idea"),
    document_path: z.string().nullable(),
  }),
  members: z.object({
    sessions: z.array(uuid(FX.job)),
    document: z.object({ path: z.string(), title: z.string() }).nullable(),
    podcasts: z.array(z.string()),
    exports: z.array(z.string()),
    room: z.string().nullable().openapi({ description: "rw-p8a4-ideas: the idea's one workspace room" }),
    chats: z.array(z.string()).openapi({ description: "rw-p8a4-ideas: the caller's rooms engaged from inside the " +
      "refinery - its own room and the caller's rooms on the refinery's sessions" }),
  }),
  context_graph: z.object({
    nodes: z.array(ContextNode),
    links: z.array(ContextLink),
  }),
  hidden: z.array(z.object({
    node_kind: registryValue(REGISTRY.nodeKinds, "source"),
    node_ref: z.string(),
    hidden_at: Iso,
  })),
  user_sources: z.array(UserSource),
  archived: z.boolean().openapi({ description: "D17 archive: the refinery rests (engagement skips it); nothing is deleted" }),
}).openapi("Refinery");

export const IdeaRevision = z.object({
  revision: z.number().int(),
  summary: z.string(),
  research_job_id: z.string().nullable(),
  created_at: Iso,
}).openapi("IdeaRevision");

// rw-p8a4-ideas (D17 item 5): the idea's ONE long-lived room in the workspace (the room store, rw-p8a3-room) and the
// accreting draft, a field on that room. The Mattermost thread is the room's inlet (a link back), never its record.
export const IdeaRoom = z.object({
  state: z.string().openapi({ example: "current", description: "current | not_opened (the room is made on first open, or by the first dossier)" }),
  room_id: z.string().nullable(),
  thread_root: z.string().nullable().openapi({ description: "the Mattermost thread bound to this room (its inlet)" }),
  inlet: z.string().nullable().openapi({ description: "mattermost:thread:<root>, when the idea has one" }),
  entries: z.number().int(),
  dossiers: z.number().int().openapi({ description: "refinery dossiers delivered into the room" }),
}).openapi("IdeaRoom");

export const IdeaDraft = z.object({
  state: z.string().openapi({ example: "current", description: "current | empty" }),
  text: z.string(),
  updated_at: Iso.nullable(),
}).openapi("IdeaDraft");

export const IdeaSummary = z.object({
  id: uuid(FX.idea),
  title: z.string(),
  state: recordState("current"),
  status: registryValue(REGISTRY.ideaStates, "researched"),
  summary: z.string(),
  current_revision: z.number().int(),
  updated_at: Iso,
  document_path: z.string().nullable(),
  // rw-p8a4-ideas: the ideas panel's columns
  last_session_at: Iso.nullable().openapi({ description: "the newest session the idea spun off" }),
  dossier_at: Iso.nullable().openapi({ description: "the latest dossier delivered into its room (else the dossier source's date)" }),
  resurfaced_at: Iso.nullable().openapi({ description: "a dormant idea a newer idea's dossier cross-linked (IR section 8)" }),
}).openapi("IdeaSummary");

export const Ideas = z.object({ ideas: z.array(IdeaSummary) }).openapi("Ideas");

export const Idea = z.object({
  id: uuid(FX.idea),
  title: z.string(),
  state: recordState("current"),
  state_detail: StateDetail,
  status: registryValue(REGISTRY.ideaStates, "researched"),
  summary: z.string(),
  current_revision: z.number().int(),
  created_at: Iso,
  updated_at: Iso,
  revisions: z.array(IdeaRevision),
  sessions: z.array(SessionSummary),
  dossier: z.object({
    source_id: uuid(FX.synthesis),
    title: z.string(),
    lifecycle: registryValue(REGISTRY.sourceStates, "active"),
  }).nullable(),
  draft: IdeaDraft,
  room: IdeaRoom,
  produced: z.object({
    sources: z.array(z.object({ id: uuid(), title: z.string(), lifecycle: registryValue(REGISTRY.sourceStates, "active") })),
    claims: z.array(z.object({ id: uuid(FX.claim), text: z.string(), confidence: z.number() })),
  }),
  refinery: Refinery,
}).openapi("Idea");
