/**
 * HtmlRenderer — turns a list of SectionData into a single HTML body for
 * the email. Inline styles only (Gmail-safe). Dispatches on
 * SectionData.kind so adding a new section is one switch case.
 *
 * SOLID note: this file knows nothing about Open Brain, OAuth, LLMs, or
 * how to FETCH data — it only knows how to draw it. Section code knows
 * nothing about HTML. The two are deliberately decoupled.
 */

import { SectionData } from "../sections/section.ts";
import { WeatherPayload } from "../sections/weather.ts";
import { AiNewsPayload, EmailGroup } from "../sections/ai-news.ts";
import { CalendarItem, CalendarPayload } from "../sections/calendar.ts";

export class HtmlRenderer {
  render(sections: SectionData[], opts: { generatedAt: string }): string {
    const body = sections.map((s) => this.renderOne(s)).join("\n");
    return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;max-width:720px;margin:0 auto;padding:16px;color:#333;line-height:1.5;">
${body}
<div style="color:#999;font-size:12px;margin-top:32px;padding-top:12px;border-top:1px solid #eee;">
  Open Brain Daily Digest · generated ${escHtml(opts.generatedAt)} · audit copy at <code>D:\\_data\\openbrain-digest-latest.md</code>
</div>
</body></html>`;
  }

  private renderOne(s: SectionData): string {
    switch (s.kind) {
      case "weather":  return renderWeather(s.payload as WeatherPayload);
      case "calendar": return renderCalendar(s.payload as CalendarPayload);
      case "ai_news":  return renderAiNews(s.payload as AiNewsPayload);
      case "todos":    return ""; // wired in Phase 4
      default:         return "";
    }
  }
}

// ─── Weather ─────────────────────────────────────────────────────────────────

function renderWeather(w: WeatherPayload): string {
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

// ─── Calendar ───────────────────────────────────────────────────────────────

function renderCalendar(c: CalendarPayload): string {
  if (c.today.length === 0 && c.upcoming.length === 0) return "";
  const todayBlock = c.today.length > 0
    ? `<h2 style="border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:28px;font-size:18px;color:#222;">Today (${c.today.length})</h2>${c.today.map(renderEventCard).join("")}`
    : "";
  const upcomingBlock = c.upcoming.length > 0
    ? `<h2 style="border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:28px;font-size:18px;color:#222;">Upcoming (${c.upcoming.length})</h2>${c.upcoming.map(renderEventCard).join("")}`
    : "";
  const banner = c.liveSource
    ? ""
    : `<div style="background:#fff3e0;color:#7c5800;padding:6px 10px;font-size:12px;border-radius:4px;margin-bottom:8px;">⚠ Google Calendar unreachable this run; showing brain-only items.</div>`;
  return banner + todayBlock + upcomingBlock;
}

function renderEventCard(e: CalendarItem): string {
  const timeLabel = formatEventTime(e);
  const link = e.htmlLink
    ? ` · <a href="${escHtml(e.htmlLink)}" style="color:#1967d2;">Open in Calendar</a>`
    : "";
  const sourceTag = renderSourceTags(e.sources);
  const locationLine = e.location
    ? `<div style="color:#666;font-size:13px;margin:2px 0;">📍 ${escHtml(e.location)}</div>`
    : "";
  const peopleLine = e.attendees.length > 0
    ? `<div style="color:#666;font-size:13px;margin:2px 0;"><strong>With:</strong> ${e.attendees.slice(0, 6).map(escHtml).join(", ")}${e.attendees.length > 6 ? `, +${e.attendees.length - 6} more` : ""}</div>`
    : "";
  const descriptionLine = e.description
    ? `<div style="color:#444;font-size:13px;margin:6px 0;padding:6px 10px;border-left:2px solid #ddd;background:#fafafa;white-space:pre-wrap;">${escHtml(e.description.slice(0, 400))}${e.description.length > 400 ? "…" : ""}</div>`
    : "";
  const considerations = e.considerations.length > 0
    ? `<div style="background:#f3e5f5;border-left:3px solid #8e24aa;padding:8px 12px;margin:8px 0;border-radius:0 4px 4px 0;font-size:13px;"><strong>Related from your brain:</strong><ul style="margin:4px 0 0 0;padding-left:20px;">${e.considerations.map((r) => `<li>${escHtml(r.snippet)}${r.source ? ` <em style="color:#999;">(${escHtml(r.source)})</em>` : ""}</li>`).join("")}</ul></div>`
    : "";
  return `
<div style="margin:14px 0;padding:12px 16px;border-left:3px solid #34a853;background:#fff;">
  <h3 style="margin:0 0 4px 0;font-size:16px;">${escHtml(e.summary)} ${sourceTag}</h3>
  <div style="color:#777;font-size:13px;">${escHtml(timeLabel)}${link}</div>
  ${locationLine}
  ${peopleLine}
  ${descriptionLine}
  ${considerations}
</div>`;
}

function renderSourceTags(sources: Array<"google" | "openbrain">): string {
  return sources.map((s) =>
    s === "google"
      ? `<span style="display:inline-block;background:#e8f0fe;color:#1967d2;font-size:11px;padding:1px 6px;border-radius:3px;vertical-align:middle;">Google</span>`
      : `<span style="display:inline-block;background:#f3e5f5;color:#6a1b9a;font-size:11px;padding:1px 6px;border-radius:3px;vertical-align:middle;">Brain</span>`,
  ).join(" ");
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

// ─── AI News (emails) ───────────────────────────────────────────────────────

function renderAiNews(d: AiNewsPayload): string {
  const chunkSum = d.emails.reduce((s, e) => s + e.chunkCount, 0);
  const summary = renderAiNewsSummary(d, chunkSum);
  const senderSections = [...d.bySender.entries()]
    .map(([sender, group]) => renderSenderBlock(sender, group))
    .join("");
  const ungrouped = renderUngrouped(d);
  return `
<div style="background:#f5f5f5;padding:14px 18px;border-radius:6px;margin-bottom:24px;">
  <div style="font-size:13px;color:#666;margin-bottom:6px;">Captured in the last ${d.windowHours}h</div>
  ${summary}
</div>
${senderSections}
${ungrouped}`;
}

function renderAiNewsSummary(d: AiNewsPayload, chunkSum: number): string {
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
      .map((t) =>
        `<span style="display:inline-block;background:#e8f0fe;color:#1967d2;padding:2px 8px;border-radius:4px;font-size:12px;margin:2px;">${escHtml(t.topic)} (${t.count})</span>`,
      )
      .join(" ");
    items.push(`<li><strong>Top topics:</strong><br>${tags}</li>`);
  }
  return `<ul style="margin:0;padding-left:20px;">${items.join("")}</ul>`;
}

function renderSenderBlock(sender: string, group: EmailGroup[]): string {
  const cards = group.map(renderEmailCard).join("");
  return `<h2 style="border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:28px;font-size:18px;color:#222;">${escHtml(sender)} — ${group.length} email${group.length === 1 ? "" : "s"}</h2>${cards}`;
}

function renderEmailCard(e: EmailGroup): string {
  const subject = escHtml(e.header?.subject ?? "(no subject)");
  const date = escHtml(isoDateOnly(e.emailDate) || "(no date)");
  const chunkSuffix = e.chunkCount > 1 ? ` · ${e.chunkCount} chunks` : "";
  const gmailLink = `https://mail.google.com/mail/u/0/#inbox/${escHtml(e.gmailThreadId)}`;
  const topicTags = e.topics.length > 0
    ? `<div style="margin:6px 0;">${e.topics.map((t) =>
      `<span style="display:inline-block;background:#e8f0fe;color:#1967d2;padding:2px 8px;border-radius:4px;font-size:12px;margin-right:4px;margin-bottom:2px;">${escHtml(t)}</span>`
    ).join("")}</div>`
    : "";
  const peopleLine = e.people.length > 0
    ? `<div style="color:#666;font-size:13px;margin:4px 0;"><strong>People:</strong> ${e.people.map(escHtml).join(", ")}</div>`
    : "";
  const snippet = e.snippet
    ? `<div style="color:#444;font-size:14px;margin:8px 0;padding:6px 12px;border-left:2px solid #ddd;background:#fafafa;">${escHtml(e.snippet)}</div>`
    : "";
  const actions = e.actionItems.length > 0
    ? `<div style="background:#fff8e1;border-left:3px solid #f9a825;padding:8px 12px;margin:8px 0;border-radius:0 4px 4px 0;"><strong>Action items:</strong><ul style="margin:4px 0 0 0;padding-left:20px;">${e.actionItems.map((i) => `<li>${escHtml(i)}</li>`).join("")}</ul></div>`
    : "";
  return `
<div style="margin:16px 0;padding:12px 16px;border-left:3px solid #4285f4;background:#fff;">
  <h3 style="margin:0 0 4px 0;font-size:16px;">${subject}</h3>
  <div style="color:#777;font-size:13px;">${date}${chunkSuffix} · <a href="${gmailLink}" style="color:#1967d2;">Open in Gmail</a></div>
  ${topicTags}
  ${peopleLine}
  ${snippet}
  ${actions}
</div>`;
}

function renderUngrouped(d: AiNewsPayload): string {
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
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
