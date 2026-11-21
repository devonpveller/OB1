// rw-owner-private-view (slot 480): the owner's private views. Every response says `private: true`; no response
// carries a count, a total or a length (lists page with `next`). Kinds and states are strings described here (the
// podcast render request's convention), never a closed list.
import { z } from "../deps.ts";
import { Iso, uuid } from "./common.ts";

const PRIVATE = z.boolean().openapi({ example: true, description: "always true: the owner's private material - never shared, cached or fed to the wiki, digest or research" });
const SIGN_IN = z.boolean().optional().openapi({ description: "present (true) on the empty answer when sign-in is on and the caller is not a signed-in user" });
const NEXT = z.string().nullable().openapi({ example: null, description: "the cursor of the next page (pass it as `before`), or null" });

export const PrivateSourceRef = z.object({
  id: uuid("f5000000-0000-4000-8000-000000000001"),
  title: z.string(),
  kind: z.string().openapi({ example: "email", description: "email | podcast | other" }),
  created_at: Iso,
}).openapi("PrivateSourceRef");

export const PrivateClaim = z.object({
  id: uuid("f5100000-0000-4000-8000-000000000001"),
  kind: z.string().openapi({ example: "private", description: "private (the claim itself is the owner's) | mixed (a shared claim with the owner's private link)" }),
  text: z.string(),
  status: z.string().openapi({ example: "active", description: "the claim's lifecycle: active | retracted | superseded" }),
  epistemic_tag: z.string().openapi({ example: "sourced" }),
  confidence: z.number(),
  contradicted: z.boolean(),
  created_at: Iso,
  private_sources: z.array(PrivateSourceRef),
  private_parents: z.array(z.object({ id: uuid("f5100000-0000-4000-8000-000000000002"), text: z.string() })),
  shared_sources: z.array(z.object({ id: uuid(), title: z.string(), url: z.string() })).openapi({ description: "a mixed claim's shared grounding, as any user sees it; empty for a private claim" }),
}).openapi("PrivateClaim");

export const PrivateClaims = z.object({
  private: PRIVATE, claims: z.array(PrivateClaim), next: NEXT, sign_in_required: SIGN_IN,
}).openapi("PrivateClaims");

export const PrivateClaimOne = z.object({ private: PRIVATE, claim: PrivateClaim }).openapi("PrivateClaimOne");

export const PrivateHit = z.object({
  source_id: uuid("f5000000-0000-4000-8000-000000000001"),
  title: z.string(),
  kind: z.string().openapi({ example: "email", description: "email | podcast | other" }),
  created_at: Iso,
  idx: z.number().int().openapi({ description: "the chunk; -1 = the source's own body (a source with no chunk)" }),
  snippet: z.string().openapi({ description: "text mode: inert <<HL>>/<</HL>> markers around matches (escape first, then swap)" }),
  score: z.number(),
}).openapi("PrivateHit");

export const PrivateHits = z.object({
  private: PRIVATE, mode: z.string().openapi({ example: "text", description: "text | semantic" }), hits: z.array(PrivateHit), sign_in_required: SIGN_IN,
}).openapi("PrivateHits");

export const PrivateJob = z.object({
  id: uuid("f5200000-0000-4000-8000-000000000001"),
  root_job_id: z.string().nullable(),
  created_at: Iso,
  state: z.string().openapi({ example: "done", description: "the shared job's status" }),
  query: z.string().nullable().openapi({ description: "the seeded job's ORIGINAL question (the owner's own; the shared session read keeps the neutral one)" }),
}).openapi("PrivateJob");

export const PrivateJobs = z.object({ private: PRIVATE, jobs: z.array(PrivateJob), next: NEXT, sign_in_required: SIGN_IN }).openapi("PrivateJobs");

export const PrivateJobText = z.object({
  private: PRIVATE,
  job: z.object({
    id: uuid("f5200000-0000-4000-8000-000000000001"),
    query: z.string().nullable(),
    result: z.record(z.string(), z.unknown()).nullable(),
    progress: z.record(z.string(), z.unknown()).nullable(),
    error: z.string().nullable(),
  }),
}).openapi("PrivateJobText");
