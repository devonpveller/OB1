#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

/**
 * Open Brain — Daily Digest
 *
 * Queries the local Open Brain via PostgREST, groups recent thoughts by
 * metadata.type, formats a plain-text digest, and delivers it as a
 * self-addressed Gmail message. Also writes a markdown copy to /reports
 * as a guaranteed audit trail (in case Gmail delivery fails).
 *
 * Local-only by design (no cloud LLM): the digest is mechanical
 * formatting, not summarization. Source of truth is the metadata.type
 * already populated by capture (or by the metadata backfill recipe).
 *
 * OAuth: reuses the gmail-pull OAuth client (same credentials.json)
 * but maintains its own token.json with the gmail.send scope. Bootstrap
 * the token once via setup-token.ts on the host before scheduling.
 *
 * Usage (inside container):
 *   deno run --allow-net --allow-read --allow-write --allow-env send-digest.ts
 */

// ─── Paths ───────────────────────────────────────────────────────────────────

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const CREDENTIALS_PATH = `${SCRIPT_DIR}credentials.json`;
const TOKEN_PATH = `${SCRIPT_DIR}token.json`;
const REPORT_DIR = "/reports";

// ─── Configuration ───────────────────────────────────────────────────────────

const REST_URL = (Deno.env.get("OPEN_BRAIN_URL") || "http://openbrain-rest").replace(/\/$/, "");
const TO_EMAIL = Deno.env.get("DIGEST_TO") || "";
const FROM_EMAIL = Deno.env.get("DIGEST_FROM") || TO_EMAIL;
const WINDOW_HOURS = parseInt(Deno.env.get("DIGEST_WINDOW_HOURS") || "24", 10);
const LIMIT = parseInt(Deno.env.get("DIGEST_LIMIT") || "200", 10);

if (!TO_EMAIL) {
  console.error("DIGEST_TO is required (your own Gmail address).");
  Deno.exit(1);
}

// ─── OAuth (mirrors pull-gmail.ts) ───────────────────────────────────────────

interface OAuthCredentials {
  installed: { client_id: string; client_secret: string; redirect_uris: string[] };
}

interface TokenData {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number;
}

async function refreshAccessToken(
  creds: OAuthCredentials,
  token: TokenData,
): Promise<TokenData> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.installed.client_id,
      client_secret: creds.installed.client_secret,
      refresh_token: token.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  }
  const updated: TokenData = {
    access_token: data.access_token,
    refresh_token: token.refresh_token,
    token_type: data.token_type,
    expiry_date: Date.now() + data.expires_in * 1000,
  };
  await Deno.writeTextFile(TOKEN_PATH, JSON.stringify(updated, null, 2));
  return updated;
}

async function getAccessToken(): Promise<string> {
  let creds: OAuthCredentials;
  try {
    creds = JSON.parse(await Deno.readTextFile(CREDENTIALS_PATH));
  } catch {
    throw new Error(
      `No credentials.json at ${CREDENTIALS_PATH}. Mount the OAuth client secret from secrets/google/openbrain-digest/.`,
    );
  }

  let token: TokenData;
  try {
    token = JSON.parse(await Deno.readTextFile(TOKEN_PATH));
  } catch {
    throw new Error(
      `No token.json at ${TOKEN_PATH}. Run setup-token.ts on the host once to bootstrap (one-time OAuth consent for gmail.send scope).`,
    );
  }

  if (Date.now() < token.expiry_date - 60_000) return token.access_token;
  return (await refreshAccessToken(creds, token)).access_token;
}

// ─── PostgREST query ─────────────────────────────────────────────────────────

interface Thought {
  id: number;
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

async function fetchThoughts(): Promise<Thought[]> {
  const since = new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString();
  // openbrain-rest (Caddy) strips the /rest/v1 prefix and forwards to
  // PostgREST at root. Same convention supabase-js uses; the base URL
  // is /openbrain-rest/, and /rest/v1 is the well-known path mount.
  // metadata->>'type'=neq.profile_field excludes user-profile fields
  // from the AI-news section (they have their own consumer).
  const url =
    `${REST_URL}/rest/v1/thoughts?select=id,content,metadata,created_at` +
    `&created_at=gte.${encodeURIComponent(since)}` +
    `&metadata->>type=not.eq.profile_field` +
    `&order=created_at.desc&limit=${LIMIT}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`PostgREST query failed: ${res.status} ${msg}`);
  }
  return await res.json();
}

// ─── Profile lookup ─────────────────────────────────────────────────────────
//
// User profile data (address, name, timezone, etc.) lives in the same
// thoughts table, tagged metadata.type=profile_field with a
// metadata.field_name discriminator. Latest-by-created_at wins so the
// user can update by capturing a new thought without touching SQL.
// See: docs/open-brain-profile-convention.md.

async function fetchProfileField(fieldName: string): Promise<string | null> {
  const url =
    `${REST_URL}/rest/v1/thoughts?select=content` +
    `&metadata->>type=eq.profile_field` +
    `&metadata->>field_name=eq.${encodeURIComponent(fieldName)}` +
    `&order=created_at.desc&limit=1`;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const rows: Array<{ content: string }> = await res.json();
    return rows[0]?.content?.trim() || null;
  } catch (err) {
    console.warn(`Profile lookup for "${fieldName}" failed: ${err}`);
    return null;
  }
}

// ─── Weather (wttr.in + local LLM brief) ────────────────────────────────────
//
// wttr.in returns structured JSON (?format=j1) with current conditions
// plus today's 8 three-hour blocks plus 2 more days. We render a small
// HTML card from the structured data, then ask the local llama-cpp to
// generate a 1–2 sentence morning brief grounded in the same data.

interface WttrCurrent {
  temp_F: string; temp_C: string; FeelsLikeF: string; FeelsLikeC: string;
  weatherDesc: Array<{ value: string }>; humidity: string;
  windspeedMiles: string; winddir16Point: string;
}
interface WttrHourly {
  time: string; tempF: string; tempC: string;
  weatherDesc: Array<{ value: string }>; chanceofrain: string;
}
interface WttrDay {
  date: string; maxtempF: string; maxtempC: string;
  mintempF: string; mintempC: string;
  hourly: WttrHourly[];
}
interface WttrPayload {
  current_condition: WttrCurrent[];
  weather: WttrDay[];
}

interface WeatherBlock {
  location: string;
  currentDesc: string;
  currentTempF: string;
  currentTempC: string;
  feelsLikeF: string;
  feelsLikeC: string;
  humidity: string;
  windMph: string;
  windDir: string;
  todayHighF: string;
  todayLowF: string;
  todayHighC: string;
  todayLowC: string;
  tomorrowHighF: string;
  tomorrowLowF: string;
  tomorrowDesc: string;
  brief: string | null;
  payload: WttrPayload;
}

async function fetchWeather(location: string): Promise<WeatherBlock | null> {
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "openbrain-digest/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`wttr.in returned ${res.status} for "${location}"`);
      return null;
    }
    const data = await res.json() as WttrPayload;
    const cur = data.current_condition?.[0];
    const today = data.weather?.[0];
    const tomorrow = data.weather?.[1];
    if (!cur || !today) return null;

    const tomorrowMidday = tomorrow?.hourly?.find((h) => h.time === "1200")
      ?? tomorrow?.hourly?.[Math.floor((tomorrow?.hourly?.length ?? 0) / 2)];

    return {
      location,
      currentDesc: cur.weatherDesc?.[0]?.value?.trim() ?? "—",
      currentTempF: cur.temp_F,
      currentTempC: cur.temp_C,
      feelsLikeF: cur.FeelsLikeF,
      feelsLikeC: cur.FeelsLikeC,
      humidity: cur.humidity,
      windMph: cur.windspeedMiles,
      windDir: cur.winddir16Point,
      todayHighF: today.maxtempF,
      todayLowF: today.mintempF,
      todayHighC: today.maxtempC,
      todayLowC: today.mintempC,
      tomorrowHighF: tomorrow?.maxtempF ?? "",
      tomorrowLowF: tomorrow?.mintempF ?? "",
      tomorrowDesc: tomorrowMidday?.weatherDesc?.[0]?.value?.trim() ?? "",
      brief: null,
      payload: data,
    };
  } catch (err) {
    console.warn(`Weather fetch failed for "${location}": ${err}`);
    return null;
  }
}

const LLM_BASE = (Deno.env.get("LOCAL_LLM_BASE") || "http://llama-cpp:8080/v1").replace(/\/$/, "");
const LLM_MODEL = Deno.env.get("LOCAL_LLM_MODEL") || "qwen36-27b:nothink";
const LLM_BEARER = Deno.env.get("LOCAL_LLM_BEARER") || "no-key";

async function llmWeatherBrief(weather: WeatherBlock): Promise<string | null> {
  // Single-shot summarization grounded in the wttr.in data. No tool use;
  // the LLM doesn't search the web — it just summarizes the structured
  // payload we already fetched. Keeps the round-trip cheap (~1–2s on
  // qwen36-27b) and avoids hallucinated facts the user can't verify.
  const prompt = `Write a 1-2 sentence morning weather brief for ${weather.location}. Use Fahrenheit. Be concrete and practical (mention if a jacket/umbrella is needed, what the day feels like). Plain text, no markdown, no preamble.

Current: ${weather.currentDesc}, ${weather.currentTempF}°F, feels like ${weather.feelsLikeF}°F, humidity ${weather.humidity}%, wind ${weather.windMph}mph ${weather.windDir}.
Today's high/low: ${weather.todayHighF}°F / ${weather.todayLowF}°F.
Tomorrow: ${weather.tomorrowDesc}, high ${weather.tomorrowHighF}°F low ${weather.tomorrowLowF}°F.`;
  try {
    const res = await fetch(`${LLM_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LLM_BEARER}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 120,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return (d.choices?.[0]?.message?.content as string | undefined)?.trim() || null;
  } catch (err) {
    console.warn(`LLM weather brief failed: ${err}`);
    return null;
  }
}

// ─── Digest formatting ──────────────────────────────────────────────────────
//
// The brain has many chunks per source (gmail-pull splits a newsletter into
// ~15 paragraph-level chunks that share the same per-email metadata). A
// useful digest groups by source — one entry per email, not per chunk —
// and surfaces the metadata that has already been extracted at capture
// time (topics, people, action_items). No LLM call.

interface EmailHeader {
  sender: string;
  address: string;
  subject: string;
  date: string;
}

interface EmailGroup {
  gmailId: string;
  gmailThreadId: string;
  header: EmailHeader | null;
  emailDate: string;
  chunkCount: number;
  topics: string[];
  people: string[];
  actionItems: string[];
  gmailLabels: string[];
  snippet: string;
}

function parseEmailHeader(content: string): EmailHeader | null {
  // The chunk_index=0 row's content starts with the marker the gmail-pull
  // script writes: `[Email from <sender> <<addr>> | Subject: <s> | Date: <d>]`.
  // Sender may have double-spaces (HTML normalization quirk); tolerate it.
  const m = content.match(
    /\[Email from ([^<|]+?)\s*<([^>]+)>\s*\|\s*Subject:\s*(.+?)\s*\|\s*Date:\s*([^\]]+?)\]/,
  );
  if (!m) return null;
  return {
    sender: m[1].trim(),
    address: m[2].trim(),
    subject: m[3].trim(),
    date: m[4].trim(),
  };
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(values.filter((v): v is string => typeof v === "string" && v.trim().length > 0)),
  );
}

function groupGmail(thoughts: Thought[]): {
  emails: EmailGroup[];
  ungrouped: Thought[];
} {
  const byId = new Map<string, Thought[]>();
  const ungrouped: Thought[] = [];

  for (const t of thoughts) {
    const id = t.metadata?.gmail_id;
    if (typeof id === "string" && id.length > 0) {
      (byId.get(id) ?? byId.set(id, []).get(id)!).push(t);
    } else {
      ungrouped.push(t);
    }
  }

  const emails: EmailGroup[] = [];
  for (const [gmailId, chunks] of byId) {
    // Find the header chunk (chunk_index=0) — fall back to the first
    // chunk we have if the index-0 chunk is missing from the window.
    const header =
      chunks.find((c) => Number(c.metadata?.chunk_index) === 0) ?? chunks[0];
    const meta = header.metadata ?? {};
    // Body snippet: strip the [Email from ...] header from the chunk
    // content, normalize whitespace, truncate. Gives a readable teaser
    // without needing to open the email itself.
    const bodyOnly = header.content.replace(/^\[Email from[^\]]+\]\s*/, "");
    const snippet = bodyOnly.replace(/\s+/g, " ").trim().slice(0, 280);
    emails.push({
      gmailId,
      gmailThreadId: String(meta.gmail_thread_id ?? gmailId),
      header: parseEmailHeader(header.content),
      emailDate: String(meta.email_date ?? header.created_at ?? ""),
      chunkCount: Number(meta.chunk_count ?? chunks.length),
      topics: uniqueStrings(meta.topics),
      people: uniqueStrings(meta.people),
      actionItems: uniqueStrings(meta.action_items),
      gmailLabels: uniqueStrings(meta.gmail_labels),
      snippet: snippet + (snippet.length === 280 ? "…" : ""),
    });
  }

  emails.sort((a, b) => (b.emailDate ?? "").localeCompare(a.emailDate ?? ""));
  return { emails, ungrouped };
}

function isoDateOnly(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

function groupEmailsBySender(emails: EmailGroup[]): Map<string, EmailGroup[]> {
  const bySender = new Map<string, EmailGroup[]>();
  for (const e of emails) {
    const key = e.header
      ? `${e.header.sender} <${e.header.address}>`
      : "(unknown sender)";
    if (!bySender.has(key)) bySender.set(key, []);
    bySender.get(key)!.push(e);
  }
  return bySender;
}

function topTopics(emails: EmailGroup[], limit: number): Array<{ topic: string; count: number }> {
  const counts = new Map<string, number>();
  for (const e of emails) {
    for (const t of e.topics) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([topic, count]) => ({ topic, count }));
}

interface DigestData {
  generatedAt: string;
  windowHours: number;
  weather: WeatherBlock | null;
  emails: EmailGroup[];
  ungrouped: Thought[];
  bySender: Map<string, EmailGroup[]>;
  topTopics: Array<{ topic: string; count: number }>;
  totalActionItems: number;
}

async function buildDigestData(
  thoughts: Thought[],
  windowHours: number,
): Promise<DigestData> {
  const { emails, ungrouped } = groupGmail(thoughts);

  // Weather. Skip silently if the user hasn't set profile_field/address
  // yet (capture via Claude Code: "remember my address is X"). Skip
  // also if wttr.in is unreachable or the LLM brief fails — partial
  // weather is better than no digest.
  let weather: WeatherBlock | null = null;
  const location = await fetchProfileField("address");
  if (location) {
    weather = await fetchWeather(location);
    if (weather) {
      weather.brief = await llmWeatherBrief(weather);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    windowHours,
    weather,
    emails,
    ungrouped,
    bySender: groupEmailsBySender(emails),
    topTopics: topTopics(emails, 6),
    totalActionItems: emails.reduce((s, e) => s + e.actionItems.length, 0),
  };
}

// ─── Markdown renderer (audit trail) ────────────────────────────────────────

function renderMarkdownWeather(w: WeatherBlock | null): string[] {
  if (!w) return [];
  const lines: string[] = [
    `## Weather — ${w.location}`,
    "",
  ];
  if (w.brief) {
    lines.push(`> ${w.brief}`);
    lines.push("");
  }
  lines.push(
    `**Now:** ${w.currentDesc}, ${w.currentTempF}°F (feels like ${w.feelsLikeF}°F). ` +
      `Wind ${w.windMph}mph ${w.windDir}. Humidity ${w.humidity}%.`,
  );
  lines.push(`**Today:** high ${w.todayHighF}°F / low ${w.todayLowF}°F.`);
  if (w.tomorrowHighF) {
    lines.push(
      `**Tomorrow:** ${w.tomorrowDesc || "—"}, high ${w.tomorrowHighF}°F / low ${w.tomorrowLowF}°F.`,
    );
  }
  lines.push("");
  return lines;
}

function renderMarkdown(d: DigestData): string {
  if (d.emails.length === 0 && d.ungrouped.length === 0 && !d.weather) {
    return `No new thoughts captured in the last ${d.windowHours}h, and no weather available.\n`;
  }
  const lines: string[] = [];
  const chunkSum = d.emails.reduce((s, e) => s + e.chunkCount, 0);

  // Weather block goes first — the user's morning ground-truth.
  lines.push(...renderMarkdownWeather(d.weather));

  lines.push(`## Summary`);
  lines.push("");
  if (d.emails.length > 0) {
    lines.push(
      `- **${d.emails.length} email${d.emails.length === 1 ? "" : "s"}** from ${d.bySender.size} sender${d.bySender.size === 1 ? "" : "s"} (${chunkSum} paragraph chunk${chunkSum === 1 ? "" : "s"})`,
    );
  }
  if (d.ungrouped.length > 0) {
    lines.push(`- **${d.ungrouped.length} other capture${d.ungrouped.length === 1 ? "" : "s"}**`);
  }
  if (d.totalActionItems > 0) {
    lines.push(`- **${d.totalActionItems} action item${d.totalActionItems === 1 ? "" : "s"}** extracted`);
  }
  if (d.topTopics.length > 0) {
    lines.push(
      `- **Top topics:** ${d.topTopics.map((t) => `${t.topic} (${t.count})`).join(", ")}`,
    );
  }
  lines.push("");

  for (const [sender, group] of d.bySender) {
    lines.push(`## ${sender} — ${group.length} email${group.length === 1 ? "" : "s"}`);
    lines.push("");
    for (const e of group) {
      const date = isoDateOnly(e.emailDate) || "(no date)";
      const subject = e.header?.subject ?? "(no subject)";
      const chunkSuffix = e.chunkCount > 1 ? ` · ${e.chunkCount} chunks` : "";
      const gmailLink = `https://mail.google.com/mail/u/0/#inbox/${e.gmailThreadId}`;
      lines.push(`### ${subject}`);
      lines.push(`*${date}${chunkSuffix} · [Open in Gmail](${gmailLink})*`);
      lines.push("");
      if (e.topics.length > 0) {
        lines.push(`**Topics:** ${e.topics.join(", ")}`);
      }
      if (e.people.length > 0) {
        lines.push(`**People:** ${e.people.join(", ")}`);
      }
      if (e.snippet) {
        lines.push("");
        lines.push(`> ${e.snippet}`);
      }
      if (e.actionItems.length > 0) {
        lines.push("");
        lines.push(`**Action items:**`);
        for (const item of e.actionItems) lines.push(`- ${item}`);
      }
      lines.push("");
    }
  }

  if (d.ungrouped.length > 0) {
    lines.push(`## Other captures (${d.ungrouped.length})`);
    lines.push("");
    for (const t of d.ungrouped) {
      const snippet = t.content.replace(/\s+/g, " ").trim().slice(0, 200);
      const ellipsis = snippet.length === 200 ? "…" : "";
      const topics = uniqueStrings(t.metadata?.topics);
      const tag = topics.length > 0 ? ` *(${topics.join(", ")})*` : "";
      lines.push(`- ${snippet}${ellipsis}${tag}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── HTML renderer (email body) ──────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderHtmlWeather(w: WeatherBlock | null): string {
  if (!w) return "";
  const briefBlock = w.brief
    ? `<div style="font-size:15px;color:#222;margin:6px 0 12px 0;line-height:1.45;">${escHtml(w.brief)}</div>`
    : "";
  const tomorrowRow = w.tomorrowHighF
    ? `<tr><td style="color:#777;font-size:12px;padding:2px 8px 2px 0;">Tomorrow</td><td style="font-size:13px;">${escHtml(w.tomorrowDesc || "—")}, ${escHtml(w.tomorrowHighF)}°F / ${escHtml(w.tomorrowLowF)}°F</td></tr>`
    : "";
  return `
<div style="background:linear-gradient(180deg,#e3f2fd 0%,#f5f7fa 100%);padding:16px 18px;border-radius:8px;margin-bottom:24px;">
  <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:6px;">
    <h2 style="margin:0;font-size:17px;color:#1565c0;">Weather — ${escHtml(w.location)}</h2>
    <div style="font-size:24px;font-weight:600;color:#1565c0;">${escHtml(w.currentTempF)}°F</div>
  </div>
  <div style="color:#555;font-size:14px;margin-bottom:4px;">${escHtml(w.currentDesc)} · feels ${escHtml(w.feelsLikeF)}°F · wind ${escHtml(w.windMph)}mph ${escHtml(w.windDir)} · humidity ${escHtml(w.humidity)}%</div>
  ${briefBlock}
  <table style="border-collapse:collapse;font-size:13px;color:#333;margin-top:8px;">
    <tr><td style="color:#777;font-size:12px;padding:2px 8px 2px 0;">Today</td><td style="font-size:13px;">high ${escHtml(w.todayHighF)}°F / low ${escHtml(w.todayLowF)}°F</td></tr>
    ${tomorrowRow}
  </table>
</div>`;
}

function renderHtml(d: DigestData): string {
  const chunkSum = d.emails.reduce((s, e) => s + e.chunkCount, 0);
  const weatherHtml = renderHtmlWeather(d.weather);

  const summary = (() => {
    if (d.emails.length === 0 && d.ungrouped.length === 0) {
      return `<p>No new thoughts captured in the last ${d.windowHours}h.</p>`;
    }
    const items: string[] = [];
    if (d.emails.length > 0) {
      items.push(
        `<li><strong>${d.emails.length} email${d.emails.length === 1 ? "" : "s"}</strong> from ${d.bySender.size} sender${d.bySender.size === 1 ? "" : "s"} (${chunkSum} paragraph chunk${chunkSum === 1 ? "" : "s"})</li>`,
      );
    }
    if (d.ungrouped.length > 0) {
      items.push(
        `<li><strong>${d.ungrouped.length} other capture${d.ungrouped.length === 1 ? "" : "s"}</strong></li>`,
      );
    }
    if (d.totalActionItems > 0) {
      items.push(
        `<li><strong>${d.totalActionItems} action item${d.totalActionItems === 1 ? "" : "s"}</strong> extracted</li>`,
      );
    }
    if (d.topTopics.length > 0) {
      const tags = d.topTopics
        .map(
          (t) =>
            `<span style="display:inline-block;background:#e8f0fe;color:#1967d2;padding:2px 8px;border-radius:4px;font-size:12px;margin:2px;">${escHtml(t.topic)} (${t.count})</span>`,
        )
        .join(" ");
      items.push(`<li><strong>Top topics:</strong><br>${tags}</li>`);
    }
    return `<ul style="margin:0;padding-left:20px;">${items.join("")}</ul>`;
  })();

  const senderSections: string[] = [];
  for (const [sender, group] of d.bySender) {
    const senderHtml = escHtml(sender);
    const emailCards = group
      .map((e) => {
        const subject = escHtml(e.header?.subject ?? "(no subject)");
        const date = escHtml(isoDateOnly(e.emailDate) || "(no date)");
        const chunkSuffix = e.chunkCount > 1 ? ` · ${e.chunkCount} chunks` : "";
        const gmailLink = `https://mail.google.com/mail/u/0/#inbox/${escHtml(e.gmailThreadId)}`;

        const topicTags =
          e.topics.length > 0
            ? `<div style="margin:6px 0;">${e.topics
                .map(
                  (t) =>
                    `<span style="display:inline-block;background:#e8f0fe;color:#1967d2;padding:2px 8px;border-radius:4px;font-size:12px;margin-right:4px;margin-bottom:2px;">${escHtml(t)}</span>`,
                )
                .join("")}</div>`
            : "";

        const peopleLine =
          e.people.length > 0
            ? `<div style="color:#666;font-size:13px;margin:4px 0;"><strong>People:</strong> ${e.people.map(escHtml).join(", ")}</div>`
            : "";

        const snippetBlock = e.snippet
          ? `<div style="color:#444;font-size:14px;margin:8px 0;padding:6px 12px;border-left:2px solid #ddd;background:#fafafa;">${escHtml(e.snippet)}</div>`
          : "";

        const actionBlock =
          e.actionItems.length > 0
            ? `<div style="background:#fff8e1;border-left:3px solid #f9a825;padding:8px 12px;margin:8px 0;border-radius:0 4px 4px 0;"><strong>Action items:</strong><ul style="margin:4px 0 0 0;padding-left:20px;">${e.actionItems
                .map((i) => `<li>${escHtml(i)}</li>`)
                .join("")}</ul></div>`
            : "";

        return `
<div style="margin:16px 0;padding:12px 16px;border-left:3px solid #4285f4;background:#fff;">
  <h3 style="margin:0 0 4px 0;font-size:16px;">${subject}</h3>
  <div style="color:#777;font-size:13px;">${date}${chunkSuffix} · <a href="${gmailLink}" style="color:#1967d2;">Open in Gmail</a></div>
  ${topicTags}
  ${peopleLine}
  ${snippetBlock}
  ${actionBlock}
</div>`;
      })
      .join("");

    senderSections.push(
      `<h2 style="border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:28px;font-size:18px;color:#222;">${senderHtml} — ${group.length} email${group.length === 1 ? "" : "s"}</h2>${emailCards}`,
    );
  }

  const ungroupedHtml = (() => {
    if (d.ungrouped.length === 0) return "";
    const items = d.ungrouped
      .map((t) => {
        const snippet = escHtml(t.content.replace(/\s+/g, " ").trim().slice(0, 200));
        const ellipsis = snippet.length === 200 ? "…" : "";
        const topics = uniqueStrings(t.metadata?.topics);
        const tag = topics.length > 0 ? ` <em style="color:#888;">(${topics.map(escHtml).join(", ")})</em>` : "";
        return `<li style="margin:6px 0;">${snippet}${ellipsis}${tag}</li>`;
      })
      .join("");
    return `<h2 style="border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:28px;font-size:18px;color:#222;">Other captures (${d.ungrouped.length})</h2><ul>${items}</ul>`;
  })();

  return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:720px;margin:0 auto;padding:16px;color:#333;line-height:1.5;">
${weatherHtml}
<div style="background:#f5f5f5;padding:14px 18px;border-radius:6px;margin-bottom:24px;">
  <div style="font-size:13px;color:#666;margin-bottom:6px;">Captured in the last ${d.windowHours}h</div>
  ${summary}
</div>
${senderSections.join("")}
${ungroupedHtml}
<div style="color:#999;font-size:12px;margin-top:32px;padding-top:12px;border-top:1px solid #eee;">
  Open Brain Daily Digest · generated ${escHtml(d.generatedAt)} · audit copy at <code>D:\\_data\\openbrain-digest-latest.md</code>
</div>
</body></html>`;
}

// ─── Gmail send ──────────────────────────────────────────────────────────────

function base64UrlEncode(text: string): string {
  // btoa handles ASCII; encode UTF-8 first.
  const utf8 = unescape(encodeURIComponent(text));
  return btoa(utf8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sendEmail(
  accessToken: string,
  subject: string,
  html: string,
): Promise<void> {
  // RFC 2822 with UTF-8 subject (encoded-word). HTML body — most modern
  // clients render the HTML; for clients that don't, gmail offers a
  // "View original" path. Single-part is fine; no plain-text alternative
  // needed since the markdown audit copy lives on disk for diff/grep.
  const encodedSubject = `=?UTF-8?B?${base64UrlEncode(subject).replace(/-/g, "+").replace(/_/g, "/")}?=`;
  const raw = [
    `From: ${FROM_EMAIL}`,
    `To: ${TO_EMAIL}`,
    `Subject: ${encodedSubject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    "",
    html,
  ].join("\r\n");

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: base64UrlEncode(raw) }),
    },
  );

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Gmail send failed: ${res.status} ${err}`);
  }
}

// ─── Audit-trail report ─────────────────────────────────────────────────────

async function writeReport(subject: string, body: string): Promise<void> {
  try {
    await Deno.mkdir(REPORT_DIR, { recursive: true });
    const content = `# ${subject}\n\n${body}`;
    await Deno.writeTextFile(`${REPORT_DIR}/openbrain-digest-latest.md`, content);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    await Deno.writeTextFile(`${REPORT_DIR}/openbrain-digest-${ts}.md`, content);
  } catch (err) {
    console.warn(`Could not write report to ${REPORT_DIR}: ${err}`);
  }
}

// ─── Run + HTTP server ──────────────────────────────────────────────────────
//
// Container is long-running and triggered via HTTP. openbrain-cron POSTs
// /run on the daily cadence in docker/cron/crontab. Manual ad-hoc runs:
//   curl -fsS -X POST http://openbrain-digest:8080/run
//
// Concurrent /run calls return 409. Pattern mirrors openbrain-wiki's
// /recompile endpoint (docker/wiki-service/wiki-service.mjs).

interface RunResult {
  thoughts: number;
  emails: number;
  senders: number;
  ungrouped: number;
  actionItems: number;
  subject: string;
}

async function runDigest(): Promise<RunResult> {
  console.log(
    `Digest run — window=${WINDOW_HOURS}h limit=${LIMIT} to=${TO_EMAIL}`,
  );
  const thoughts = await fetchThoughts();
  console.log(`  Found ${thoughts.length} thought(s).`);

  const data = await buildDigestData(thoughts, WINDOW_HOURS);
  const dateStr = new Date().toISOString().slice(0, 10);
  const subject = `Open Brain Daily Digest — ${dateStr}`;

  console.log(
    `  ${data.emails.length} email(s) from ${data.bySender.size} sender(s), ${data.ungrouped.length} other capture(s), ${data.totalActionItems} action item(s).`,
  );
  console.log(
    `  Weather: ${data.weather ? `${data.weather.location} — ${data.weather.currentDesc}, ${data.weather.currentTempF}°F` : "(no profile_field/address set; section skipped)"}.`,
  );

  // File first — guaranteed audit trail even if email fails.
  const markdown = renderMarkdown(data);
  await writeReport(subject, markdown);

  // Then email. OAuth issues raise here; the markdown report is already
  // on disk for morning review.
  const html = renderHtml(data);
  const accessToken = await getAccessToken();
  await sendEmail(accessToken, subject, html);
  console.log(`  Sent "${subject}" to ${TO_EMAIL}.`);

  return {
    thoughts: thoughts.length,
    emails: data.emails.length,
    senders: data.bySender.size,
    ungrouped: data.ungrouped.length,
    actionItems: data.totalActionItems,
    subject,
  };
}

const PORT = parseInt(Deno.env.get("DIGEST_PORT") || "8080", 10);

let running = false;
let lastRunAt: string | null = null;
let lastResult: RunResult | null = null;
let lastError: string | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    return jsonResponse({
      service: "openbrain-digest",
      running,
      last_run_at: lastRunAt,
      last_result: lastResult,
      last_error: lastError,
    });
  }

  if (req.method === "POST" && url.pathname === "/run") {
    if (running) {
      return jsonResponse(
        { started: false, reason: "run already in progress" },
        409,
      );
    }
    running = true;
    lastError = null;
    // Fire and forget — return 202 immediately, the caller (cron) shouldn't
    // hold a connection for the duration of the digest.
    (async () => {
      try {
        lastResult = await runDigest();
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        lastResult = null;
        console.error(`Digest run failed: ${lastError}`);
      } finally {
        running = false;
        lastRunAt = new Date().toISOString();
      }
    })();
    return jsonResponse({ started: true }, 202);
  }

  return jsonResponse({ error: "not found", path: url.pathname }, 404);
});

console.log(`openbrain-digest listening on :${PORT}`);
