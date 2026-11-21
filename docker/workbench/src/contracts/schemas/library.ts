// The two shared-library reads the Home screen's library cards use (research-workbench redesign, rwr-home round 4):
// claims waiting for a second source, and what is new in the library lately. Both read SHARED knowledge only
// (public.claims, public.sources): nothing here is per user. Additive; the examples are hand-written over
// contract-test/fixtures.sql and the conformance test validates each against its schema.
import { z } from "../deps.ts";
import { Iso, uuid } from "./common.ts";
import { FX } from "./fixtures.ts";

export const WaitingClaim = z.object({
  id: uuid(FX.claim),
  text: z.string(),
  created_at: Iso,
}).openapi("WaitingClaim");

export const WaitingClaims = z.object({
  total: z.number().int().openapi({ description: "every active claim backed by exactly one active source, not only this page" }),
  claims: z.array(WaitingClaim),
}).openapi("WaitingClaims");

export const RecentSource = z.object({
  id: uuid(FX.sourceActive),
  title: z.string(),
  url: z.string().nullable(),
  content_type: z.string(),
  created_at: Iso,
}).openapi("RecentSource");

export const RecentSources = z.object({
  days: z.number().int(),
  sources_total: z.number().int().openapi({ description: "every active source first added within the window, not only this page" }),
  claims_total: z.number().int().openapi({ description: "every active claim created within the window" }),
  sources: z.array(RecentSource).openapi({ description: "newest first, at most `limit`" }),
}).openapi("RecentSources");

export const LX = {
  waiting: { total: 1, claims: [{ id: FX.claim, text: "Fixture claim: contracts own record states.", created_at: FX.at }] },
  recent: {
    days: 7, sources_total: 1, claims_total: 1,
    sources: [{ id: FX.sourceActive, title: "Active fixture source", url: "https://example.org/active", content_type: "web_article", created_at: FX.at }],
  },
};
