/**
 * openbrain-digest composition (moved out of send-digest.ts so tests can
 * build the REAL service with stub endpoints, a recording mail stub and a
 * virtual clock). send-digest.ts calls buildDigestApp with the real
 * environment and nothing else.
 */

import { BrainClient } from "./clients/postgrest.ts";
import { LlmClient } from "./clients/llm.ts";
import { WttrClient } from "./clients/wttr.ts";
import { GoogleOAuth } from "./clients/google-oauth.ts";
import { GmailClient, MailTransport } from "./clients/gmail.ts";
import { GoogleCalendarClient } from "./clients/google-calendar.ts";
import { SemanticSearch } from "./considerations/semantic-search.ts";
import { ConsiderationsSynthesizer } from "./considerations/synthesizer.ts";
import { WeatherSection } from "./sections/weather.ts";
import { CalendarSection } from "./sections/calendar.ts";
import { AiNewsSection } from "./sections/ai-news.ts";
import { PodcastBriefSection } from "./sections/podcast-brief.ts";
import { HtmlRenderer } from "./renderers/html.ts";
import { MarkdownRenderer } from "./renderers/markdown.ts";
import { DigestOrchestrator } from "./digest.ts";
import type { Section } from "./sections/section.ts";
import { Clock, realClock } from "./routine/clock.ts";
import { probeModel } from "./routine/model-gate.ts";
import { MorningRoutine, routineConfigFromEnv } from "./routine/routine.ts";
import { RoutineStore } from "./routine/store.ts";
import { AlertSender, TelegramNotifier } from "./routine/telegram.ts";

export interface DigestAppDeps {
  env: (k: string) => string | undefined;
  /** Directory holding credentials.json / token.json / calendar-token.json. */
  scriptDir: string;
  clock?: Clock;
  mail?: MailTransport;
  alerts?: AlertSender;
  fetchFn?: typeof fetch;
}

export function buildDigestApp(d: DigestAppDeps): { routine: MorningRoutine; orchestrator: DigestOrchestrator } {
  const env = (k: string, fallback = "") => d.env(k) ?? fallback;
  const envInt = (k: string, fallback: number) => {
    const v = parseInt(d.env(k) ?? "", 10);
    return Number.isFinite(v) ? v : fallback;
  };

  const TO_EMAIL = env("DIGEST_TO");
  const FROM_EMAIL = env("DIGEST_FROM", TO_EMAIL);
  if (!TO_EMAIL) throw new Error("DIGEST_TO is required (your own Gmail address).");
  const REPORT_DIR = env("DIGEST_REPORT_DIR", "/reports");

  // ─── Clients ──────────────────────────────────────────────────────────────
  const brain = new BrainClient({ baseUrl: env("OPEN_BRAIN_URL", "http://openbrain-rest") });
  const llm = new LlmClient({
    chatBase: env("LOCAL_LLM_BASE", "http://llama-cpp:8080/v1"),
    chatModel: env("LOCAL_LLM_MODEL", "local-small"),
    embedBase: env("LOCAL_EMBED_BASE", "http://llama-cpp-embed:8080/v1"),
    embedModel: env("LOCAL_EMBED_MODEL", "local-embed"),
    bearer: env("LOCAL_LLM_BEARER", "no-key"),
  });
  const wttr = new WttrClient();
  const gmail = d.mail ?? new GmailClient({
    oauth: new GoogleOAuth({ credentialsPath: `${d.scriptDir}credentials.json`, tokenPath: `${d.scriptDir}token.json` }),
  });
  // Separate OAuth instance for calendar (read-only scope; different token
  // file). If the calendar token isn't present, the CalendarSection's first
  // API call throws and the orchestrator omits the section gracefully.
  const gcal = new GoogleCalendarClient({
    oauth: new GoogleOAuth({ credentialsPath: `${d.scriptDir}credentials.json`, tokenPath: `${d.scriptDir}calendar-token.json` }),
  });

  // ─── Sections (order = order in the email) ────────────────────────────────
  const semanticSearch = new SemanticSearch(brain, llm);
  const synthesizer = env("CONSIDERATIONS_SYNTH", "true").toLowerCase() === "true"
    ? new ConsiderationsSynthesizer(semanticSearch, llm, {
      candidatePoolSize: envInt("CONSIDERATIONS_POOL", 8),
      similarityThreshold: Number(env("CONSIDERATIONS_THRESHOLD", "0.5")),
    })
    : null;
  const excludeCalendarIds = env("DIGEST_EXCLUDE_CALENDAR_IDS", "").split(",").map((s) => s.trim()).filter(Boolean);
  const briefPath = env("PODCAST_BRIEF_PATH", `${REPORT_DIR}/podcast-brief-latest.json`);
  const clock = d.clock ?? realClock;

  const sections: Section[] = [
    new WeatherSection(brain, wttr, llm),
    new CalendarSection(brain, gcal, synthesizer, {
      prepWindowDays: envInt("DIGEST_PREP_WINDOW_DAYS", 30),
      excludeCalendarIds,
    }),
    // Researched "deep dive" + episode link from the podcast pipeline. The
    // routine includes it only when it is TODAY's (else it is marked pending).
    new PodcastBriefSection({ path: briefPath, maxAgeMs: envInt("PODCAST_BRIEF_MAX_AGE_MS", 12 * 3600 * 1000), now: () => clock.now() }),
    new AiNewsSection(brain, {
      windowHours: envInt("DIGEST_WINDOW_HOURS", 24),
      limit: envInt("DIGEST_LIMIT", 200),
    }),
  ];

  const orchestrator = new DigestOrchestrator({
    sections,
    htmlRenderer: new HtmlRenderer(),
    markdownRenderer: new MarkdownRenderer(),
    gmail,
    reportDir: REPORT_DIR,
    fromEmail: FROM_EMAIL,
    toEmail: TO_EMAIL,
  });

  // ─── Morning routine (mr-routine-outage) ──────────────────────────────────
  const fetchFn = d.fetchFn ?? fetch;
  const podcastHealthUrl = env("PODCAST_HEALTH_URL");
  // gmail-pull / gmail-prune GET /health ({running, last_run_at, last_error}):
  // lets the deadline digest say "the chain stopped after pull" instead of
  // promising a follow-up that cannot come.
  const stepHealth = (url: string) =>
    url
      ? async () => {
        try {
          const r = await fetchFn(url, { signal: AbortSignal.timeout(5_000) });
          if (!r.ok) return null;
          const j = await r.json() as { running?: boolean; last_run_at?: string | null; last_error?: string | null };
          return { running: !!j.running, last_run_at: j.last_run_at ?? null, last_error: j.last_error ?? null };
        } catch {
          return null;
        }
      }
      : undefined;
  const routine = new MorningRoutine({
    cfg: routineConfigFromEnv(d.env),
    clock,
    store: new RoutineStore(env("ROUTINE_STATE_DIR", `${REPORT_DIR}/routine`)),
    digest: orchestrator,
    probe: () =>
      probeModel({
        chatBase: env("MODEL_GATE_CHAT_BASE", env("LOCAL_LLM_BASE", "http://llama-cpp:8080/v1")),
        model: env("MODEL_GATE_MODEL", env("LOCAL_LLM_MODEL", "local-small")),
        apiKey: env("LOCAL_LLM_BEARER", "no-key"),
        fetchFn,
      }),
    gateInitialMs: envInt("MODEL_GATE_INITIAL_MS", 30_000),
    gateMaxMs: envInt("MODEL_GATE_MAX_MS", 300_000),
    podcastHealth: podcastHealthUrl
      ? async () => {
        try {
          const r = await fetchFn(podcastHealthUrl, { signal: AbortSignal.timeout(5_000) });
          if (!r.ok) return null;
          const j = await r.json() as { running?: boolean };
          return { running: !!j.running };
        } catch {
          return null;
        }
      }
      : undefined,
    pullHealth: stepHealth(env("PULL_HEALTH_URL")),
    pruneHealth: stepHealth(env("PRUNE_HEALTH_URL")),
    briefPath,
    alerts: d.alerts ?? new TelegramNotifier({
      token: env("SYSADMIN_TELEGRAM_BOT_TOKEN"),
      chatId: env("SYSADMIN_TELEGRAM_CHAT_ID"),
      fetchFn,
    }),
    chainHeadUrl: env("CHAIN_HEAD_URL") || undefined,
    fetchFn,
  });
  return { routine, orchestrator };
}
