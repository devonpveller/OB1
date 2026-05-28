#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

/**
 * openbrain-digest entrypoint.
 *
 * Composition root only. Reads env, constructs clients + sections +
 * renderers, hands them to the orchestrator, and starts the HTTP server.
 * No business logic in this file — all of it lives under src/.
 *
 * Container is long-running. POST /run triggers a digest; openbrain-cron
 * fires it on the daily schedule in docker/cron/crontab.
 *
 * The legacy CLI one-shot mode is gone; for ad-hoc runs, use:
 *   docker exec openbrain-cron sh -c "curl -fsS -X POST http://openbrain-digest:8080/run"
 */

import { BrainClient } from "./src/clients/postgrest.ts";
import { LlmClient } from "./src/clients/llm.ts";
import { WttrClient } from "./src/clients/wttr.ts";
import { GoogleOAuth } from "./src/clients/google-oauth.ts";
import { GmailClient } from "./src/clients/gmail.ts";
import { GoogleCalendarClient } from "./src/clients/google-calendar.ts";
import { SemanticSearch } from "./src/considerations/semantic-search.ts";
import { LlmRelevanceFilter } from "./src/considerations/relevance-filter.ts";
import { WeatherSection } from "./src/sections/weather.ts";
import { CalendarSection } from "./src/sections/calendar.ts";
import { AiNewsSection } from "./src/sections/ai-news.ts";
import { HtmlRenderer } from "./src/renderers/html.ts";
import { MarkdownRenderer } from "./src/renderers/markdown.ts";
import { DigestOrchestrator } from "./src/digest.ts";
import { startServer } from "./src/server.ts";
import type { Section } from "./src/sections/section.ts";

// ─── Env ────────────────────────────────────────────────────────────────────

const env = (k: string, fallback = "") => Deno.env.get(k) ?? fallback;
const envInt = (k: string, fallback: number) => {
  const v = parseInt(Deno.env.get(k) ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
};

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;

const TO_EMAIL = env("DIGEST_TO");
const FROM_EMAIL = env("DIGEST_FROM", TO_EMAIL);
if (!TO_EMAIL) {
  console.error("DIGEST_TO is required (your own Gmail address).");
  Deno.exit(1);
}

// ─── Clients ────────────────────────────────────────────────────────────────

const brain = new BrainClient({
  baseUrl: env("OPEN_BRAIN_URL", "http://openbrain-rest"),
});

const llm = new LlmClient({
  chatBase: env("LOCAL_LLM_BASE", "http://llama-cpp:8080/v1"),
  chatModel: env("LOCAL_LLM_MODEL", "qwen36-27b:nothink"),
  embedBase: env("LOCAL_EMBED_BASE", "http://llama-cpp-embed:8080/v1"),
  embedModel: env("LOCAL_EMBED_MODEL", "bge-m3"),
  bearer: env("LOCAL_LLM_BEARER", "no-key"),
});

const wttr = new WttrClient();

const gmail = new GmailClient({
  oauth: new GoogleOAuth({
    credentialsPath: `${SCRIPT_DIR}credentials.json`,
    tokenPath: `${SCRIPT_DIR}token.json`,
  }),
});

// Separate OAuth instance for calendar (read-only scope; different token
// file). Same underlying OAuth client. Token is bootstrapped via
// setup-calendar-token.ts. If the calendar token isn't present, the
// CalendarSection's first API call throws and the orchestrator omits
// the section gracefully — digest still goes out.
const gcal = new GoogleCalendarClient({
  oauth: new GoogleOAuth({
    credentialsPath: `${SCRIPT_DIR}credentials.json`,
    tokenPath: `${SCRIPT_DIR}calendar-token.json`,
  }),
});

// ─── Sections ───────────────────────────────────────────────────────────────
// Order here is the order they appear in the email. Adding a new
// section: import it above, instantiate, append to this list. No edits
// to clients, renderers, orchestrator, or server.

// Shared "related from your brain" lookup. Reused by every section
// that wants per-item context (calendar today; todos later).
const considerations = new SemanticSearch(brain, llm, {
  k: envInt("CONSIDERATIONS_TOP_K", 3),
  threshold: Number(env("CONSIDERATIONS_THRESHOLD", "0.5")),
});

// Optional second pass — LLM asks "which of these embedding matches
// are ACTUALLY relevant to this event?" before they hit the digest.
// Filters out name-overlap-only matches (e.g. wife's old emails being
// pulled into every event tagged with her name). Off by default; turn
// on by setting CONSIDERATIONS_RERANK=true.
const relevanceFilter = env("CONSIDERATIONS_RERANK", "true").toLowerCase() === "true"
  ? new LlmRelevanceFilter(llm)
  : null;

const excludeCalendarIds = env("DIGEST_EXCLUDE_CALENDAR_IDS", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const sections: Section[] = [
  new WeatherSection(brain, wttr, llm),
  new CalendarSection(brain, gcal, considerations, relevanceFilter, {
    prepWindowDays: envInt("DIGEST_PREP_WINDOW_DAYS", 30),
    excludeCalendarIds,
    considerationsTopK: envInt("CONSIDERATIONS_TOP_K", 3),
    considerationsThreshold: Number(env("CONSIDERATIONS_THRESHOLD", "0.5")),
    considerationsCandidatePool: envInt("CONSIDERATIONS_POOL", 8),
  }),
  new AiNewsSection(brain, {
    windowHours: envInt("DIGEST_WINDOW_HOURS", 24),
    limit: envInt("DIGEST_LIMIT", 200),
  }),
];

// ─── Orchestrator + server ──────────────────────────────────────────────────

const orchestrator = new DigestOrchestrator({
  sections,
  htmlRenderer: new HtmlRenderer(),
  markdownRenderer: new MarkdownRenderer(),
  gmail,
  reportDir: "/reports",
  fromEmail: FROM_EMAIL,
  toEmail: TO_EMAIL,
});

startServer({ orchestrator, port: envInt("DIGEST_PORT", 8080) });
