/**
 * MarkdownRenderer — same SectionData input as HtmlRenderer, plain
 * markdown output for the D:\_data audit copy. Lets a digest run survive
 * email-send failure: the markdown file is written before Gmail is
 * touched.
 */

import { SectionData } from "../sections/section.ts";
import { WeatherPayload } from "../sections/weather.ts";
import { AiNewsPayload, EmailGroup } from "../sections/ai-news.ts";
import { CalendarItem, CalendarPayload, PrepItem } from "../sections/calendar.ts";
import { PodcastBriefPayload } from "../sections/podcast-brief.ts";

export class MarkdownRenderer {
  render(sections: SectionData[], opts: { subject: string }): string {
    if (sections.length === 0) return `${opts.subject}\n\n(no content this run)\n`;
    const blocks = sections.map((s) => this.renderOne(s)).filter(Boolean);
    return `# ${opts.subject}\n\n${blocks.join("\n")}`;
  }

  private renderOne(s: SectionData): string {
    switch (s.kind) {
      case "weather":  return renderWeather(s.payload as WeatherPayload);
      case "calendar": return renderCalendar(s.payload as CalendarPayload);
      case "ai_news":  return renderAiNews(s.payload as AiNewsPayload);
      case "podcast_brief": return renderPodcastBrief(s.payload as PodcastBriefPayload);
      case "todos":    return ""; // Phase 4
      default:         return "";
    }
  }
}

function renderPodcastBrief(d: PodcastBriefPayload): string {
  const lines: string[] = ["## Today's deep dive", ""];
  if (d.episode) {
    lines.push(`🎧 **Today's episode:** ${d.episode.title}`);
    if (d.episode.viewUrl) lines.push(`▶ Open in Open Notebook: ${d.episode.viewUrl}`);
    if (d.episode.downloadUrl) lines.push(`⬇ Download: ${d.episode.downloadUrl}`);
    if (!d.episode.viewUrl && !d.episode.downloadUrl) lines.push(`(audio still rendering)`);
    lines.push("");
  }
  for (const s of d.segments) {
    if (!s.items.length) continue;
    const label = (s.label.split("/").pop() ?? s.label).replace(/[-_]+/g, " ");
    lines.push(`### ${label}`, "");
    for (const it of s.items) {
      lines.push(`**[${it.title || it.url}](${it.url})**`);
      if (it.emailOnly) lines.push(`- _Only the newsletter blurb — couldn't open the article._`);
      for (const p of it.keyPoints) lines.push(`- ${p}`);
      if (it.preliminary[0]) lines.push(`- _Preliminary: ${it.preliminary[0]}_`);
      lines.push("");
    }
  }
  if (d.followUps.length) {
    lines.push("### Open threads to follow up", "");
    for (const g of d.followUps) lines.push(`- ${g}`);
    lines.push("");
  }
  return lines.join("\n");
}

function renderCalendar(c: CalendarPayload): string {
  if (c.today.length === 0 && c.tomorrow.length === 0 && c.needsPrep.length === 0) return "";
  const lines: string[] = [];
  if (!c.liveSource) {
    lines.push(`> ⚠ Google Calendar unreachable this run; showing brain-only items.`);
    lines.push("");
  }

  lines.push(`## Today (${c.today.length})`, "");
  if (c.today.length === 0) {
    lines.push("*Nothing scheduled.*", "");
  } else {
    for (const e of c.today) lines.push(...renderEventLines(e));
  }

  lines.push(`## Tomorrow (${c.tomorrow.length})`, "");
  if (c.tomorrow.length === 0) {
    lines.push("*Nothing scheduled.*", "");
  } else {
    for (const e of c.tomorrow) lines.push(...renderEventLines(e));
  }

  if (c.needsPrep.length > 0) {
    lines.push(`## Needs prep — next ${c.windowDays}d (${c.needsPrep.length})`, "");
    for (const p of c.needsPrep) lines.push(...renderEventLines(p, p.reasons));
  }
  return lines.join("\n");
}

function renderEventLines(e: CalendarItem, prepReasons?: string[]): string[] {
  const out: string[] = [];
  const sourceTag = `[${e.sources.join(",")}]`;
  const calName = e.calendarName && e.calendarName !== "primary"
    ? ` *(cal: ${e.calendarName.replace(/@.*$/, "").slice(0, 24)})*`
    : "";
  out.push(`### ${e.summary} ${sourceTag}${calName}`);
  out.push(`*${formatEventTime(e)}*${e.htmlLink ? ` · [Open in Calendar](${e.htmlLink})` : ""}`);
  if (prepReasons && prepReasons.length > 0) {
    out.push(`**Flagged for prep:** ${prepReasons.join("; ")}`);
  }
  if (e.location) out.push(`**Location:** ${e.location}`);
  if (e.attendees.length > 0) {
    out.push(
      `**With:** ${e.attendees.slice(0, 6).join(", ")}${e.attendees.length > 6 ? `, +${e.attendees.length - 6} more` : ""}`,
    );
  }
  if (e.description) {
    out.push("");
    out.push(`> ${e.description.replace(/\n/g, "\n> ").slice(0, 400)}${e.description.length > 400 ? "…" : ""}`);
  }
  if (e.considerationsSummary) {
    out.push("");
    out.push(`**Related from your brain** *(synthesized from ${e.considerationsSourceCount} brain item${e.considerationsSourceCount === 1 ? "" : "s"})*`);
    out.push("");
    out.push(`> ${e.considerationsSummary.replace(/\n/g, "\n> ")}`);
  }
  out.push("");
  return out;
}

function formatEventTime(e: CalendarItem): string {
  if (e.allDay) return `${e.start.slice(0, 10)} · all day`;
  const start = new Date(e.start);
  const end = e.end ? new Date(e.end) : null;
  const dateStr = start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const startTime = start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (!end) return `${dateStr} · ${startTime}`;
  const endTime = end.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${dateStr} · ${startTime} – ${endTime}`;
}

function renderWeather(w: WeatherPayload): string {
  const lines: string[] = [`## Weather — ${w.location}`, ""];
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
  return lines.join("\n");
}

function renderAiNews(d: AiNewsPayload): string {
  const chunkSum = d.emails.reduce((s, e) => s + e.chunkCount, 0);
  const lines: string[] = ["## Summary", ""];

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
    for (const e of group) lines.push(...renderEmailLines(e));
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

function renderEmailLines(e: EmailGroup): string[] {
  const out: string[] = [];
  const date = isoDateOnly(e.emailDate) || "(no date)";
  const subject = e.header?.subject ?? "(no subject)";
  const chunkSuffix = e.chunkCount > 1 ? ` · ${e.chunkCount} chunks` : "";
  const gmailLink = `https://mail.google.com/mail/u/0/#inbox/${e.gmailThreadId}`;
  out.push(`### ${subject}`);
  out.push(`*${date}${chunkSuffix} · [Open in Gmail](${gmailLink})*`);
  out.push("");
  if (e.topics.length > 0) out.push(`**Topics:** ${e.topics.join(", ")}`);
  if (e.people.length > 0) out.push(`**People:** ${e.people.join(", ")}`);
  if (e.snippet) {
    out.push("");
    out.push(`> ${e.snippet}`);
  }
  if (e.actionItems.length > 0) {
    out.push("");
    out.push(`**Action items:**`);
    for (const item of e.actionItems) out.push(`- ${item}`);
  }
  out.push("");
  return out;
}

function isoDateOnly(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(values.filter((v): v is string => typeof v === "string" && v.trim().length > 0)),
  );
}
