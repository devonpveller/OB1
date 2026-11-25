// Podcasts (research-workbench P7a): the presenter model (presenters, teams, voice links) and
// render requests. Everything here is per-user (07-MULTI-USER: podcast prompting and requests are
// private) and read through the identity seam's subject only.
import { z } from "../deps.ts";
import { Iso, uuid } from "./common.ts";

export const VoiceLink = z.object({
  id: z.string(),
  route: z.string().openapi({ example: "local-tts", description: "the LiteLLM route (gateway model name) that voices it" }),
  voice: z.string().openapi({ example: "bm_george" }),
  speed: z.number(),
}).openapi("PodcastVoiceLink");

export const Presenter = z.object({
  id: z.string().openapi({ example: "pod-fx-presenter-a" }),
  name: z.string(),
  personality: z.string(),
  backstory: z.string(),
  language: z.string(),
  origin: z.string().openapi({ description: "operator | on-capture" }),
  voice: VoiceLink,
}).openapi("PodcastPresenter");

export const Presenters = z.object({ presenters: z.array(Presenter) }).openapi("PodcastPresenters");

export const Team = z.object({
  id: z.string().openapi({ example: "pod-fx-team" }),
  name: z.string(),
  description: z.string(),
  origin: z.string(),
  presenters: z.array(z.object({ position: z.number().int(), presenter_id: z.string(), name: z.string() })),
  formats: z.array(z.object({ id: z.string(), name: z.string(), segments: z.number().int(), language: z.string(), script_route: z.string() })),
}).openapi("PodcastTeam");

export const Teams = z.object({ teams: z.array(Team) }).openapi("PodcastTeams");

export const PodcastEpisode = z.object({
  id: uuid("e7000000-0000-4000-8000-000000000001"),
  title: z.string(),
  team_id: z.string().nullable(),
  audio_format: z.string(),
  seconds: z.number().nullable(),
  shared: z.boolean(),
  mine: z.boolean().openapi({ description: "the caller requested it (else it is a shared render)" }),
  created_at: Iso,
}).openapi("PodcastEpisode");

export const Podcasts = z.object({ podcasts: z.array(PodcastEpisode) }).openapi("Podcasts");

const TurnIn = z.object({ presenterId: z.string().min(1), text: z.string().min(1).max(4000) });

export const RenderRequestBody = z.object({
  team_id: z.string().min(1),
  title: z.string().min(1).max(200),
  transcript: z.object({ title: z.string().min(1).max(200), turns: z.array(TurnIn).min(1).max(2000) }).optional()
    .openapi({ description: "a room transcript (the original input); send this OR from, never both" }),
  from: z.object({
    kind: z.string().min(1).max(40).openapi({ example: "idea", description: "run | report | document | idea | topic (discussion is registered, not usable yet: 409)" }),
    id: z.string().min(1).max(512).openapi({ description: "the id of one thing of that kind (a document is named by its path); it must be the caller's own, else it reads as missing (404)" }),
  }).optional().openapi({ description: "rwr-episode-from: make the episode from one of the caller's own things; send this OR transcript, never both" }),
  refinery_id: uuid("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
    "rw-p8a4-ideas: requested from inside this idea refinery (the caller's own): recorded as its member; an archived refinery refuses (409)").optional(),
}).openapi("PodcastRenderRequestBody");

export const RenderRequest = z.object({
  id: uuid("e8000000-0000-4000-8000-000000000001"),
  team_id: z.string(),
  title: z.string(),
  state: z.string().openapi({ description: "queued | rendering | done | failed" }),
  episode_id: z.string().nullable(),
  error: z.string().nullable(),
  turns: z.number().int(),
  created_at: Iso,
  updated_at: Iso,
}).openapi("PodcastRenderRequest");

export const RenderRequests = z.object({ requests: z.array(RenderRequest) }).openapi("PodcastRenderRequests");

// rwr-episode-from: the share step. The owner is shown the list, then confirms it by sending its fingerprint back.
export const DisclosureItem = z.object({
  type: z.string().openapi({ example: "idea", description: "episode | run | report | document | idea | claim | source | quote | transcript" }),
  id: z.string(),
  label: z.string(),
  marker: z.string().openapi({ description: "private | cloud" }),
}).openapi("PodcastDisclosureItem");

export const ShareDisclosure = z.object({
  episode_id: uuid("e7000000-0000-4000-8000-000000000001"),
  already_shared: z.boolean(),
  text: z.string().openapi({ description: "the sentence the owner reads, with the list in it" }),
  would_share: z.array(DisclosureItem).openapi({ description: "every private or cloud-derived item another user would then see" }),
  share_digest: z.string().openapi({ description: "fingerprint of exactly this list: send it with shared: true to confirm" }),
}).openapi("PodcastShareDisclosure");

export const PodcastPatchBody = z.object({
  shared: z.boolean().openapi({ description: "true shares the episode with the other users: only with share_digest; false unshares it" }),
  share_digest: z.string().min(1).max(128).optional().openapi({ description: "the digest of GET .../share-preview, read just before (a stale one is refused)" }),
}).strict().openapi("PodcastPatchBody");

export const PodcastPatchResult = z.object({
  episode_id: uuid("e7000000-0000-4000-8000-000000000001"),
  shared: z.boolean(),
  disclosed: z.number().int().openapi({ description: "how many items the confirmed list held (0 when unsharing)" }),
}).openapi("PodcastPatchResult");
