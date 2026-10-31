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
  transcript: z.object({ title: z.string().min(1).max(200), turns: z.array(TurnIn).min(1).max(2000) }),
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
