/**
 * CalendarSection — today's + upcoming events.
 *
 * Sources:
 *   - Google Calendar (live fetch via API, source of truth for events)
 *   - Open Brain (calendar_event thoughts captured manually as notes)
 *
 * Both are merged by event id when possible; brain entries without a
 * matching Google id appear as standalone items. Considerations
 * (semantically related brain context per event) are wired in Phase 3.
 *
 * Returns null when:
 *   - no calendar token is bootstrapped (graceful skip; weather + AI
 *     news still render),
 *   - Google API hard-errors (caught and surfaced via SectionData
 *     omission, see DigestOrchestrator.runSections).
 *
 * Time windows are computed in the user's local timezone via the TZ env
 * passed to the container (TZ=America/New_York for the user's setup).
 * The Section doesn't know the actual zone — Deno's Date handles it.
 */

import { BrainClient, Thought } from "../clients/postgrest.ts";
import { GoogleCalendarClient, CalendarEvent } from "../clients/google-calendar.ts";
import { SemanticSearch } from "../considerations/semantic-search.ts";
import { Section, SectionData } from "./section.ts";

export interface CalendarPayload {
  /** Events whose start time falls within today (local). */
  today: CalendarItem[];
  /** Events later than today's end, within the upcoming window. */
  upcoming: CalendarItem[];
  /** Did we successfully reach Google Calendar this run? */
  liveSource: boolean;
}

/** A normalized event displayed in the digest — may originate in Google or the brain. */
export interface CalendarItem {
  id: string;
  summary: string;
  description: string;
  location: string;
  start: string;
  end: string;
  allDay: boolean;
  attendees: string[];
  organizer: string;
  htmlLink: string;
  sources: Array<"google" | "openbrain">;
  /** Top-K semantically related brain thoughts. Populated in Phase 3. */
  considerations: ConsiderationRef[];
}

export interface ConsiderationRef {
  id: number;
  snippet: string;
  source: string | null;     // e.g. "gmail", or null for manual captures
}

export interface CalendarSectionOptions {
  /** How many days ahead (exclusive of today) to include in "upcoming". */
  upcomingDays: number;
  /** Calendar IDs to query. Default ["primary"]. */
  calendarIds?: string[];
  /** Top-K considerations per event. 0 disables the considerations pass. */
  considerationsTopK?: number;
  /** Minimum similarity (0–1) for an event consideration. */
  considerationsThreshold?: number;
}

export class CalendarSection implements Section {
  readonly name = "calendar";

  constructor(
    private readonly brain: BrainClient,
    private readonly gcal: GoogleCalendarClient,
    private readonly considerations: SemanticSearch,
    private readonly opts: CalendarSectionOptions,
  ) {}

  async produce(): Promise<SectionData<CalendarPayload> | null> {
    const { todayStart, todayEnd, upcomingEnd } = this.windowBounds();

    const gcalEvents = await this.fetchGoogleSafe(todayStart, upcomingEnd);
    const brainEvents = await this.fetchBrain(todayStart, upcomingEnd);

    // Empty everywhere = nothing to render. Drop the section.
    if (gcalEvents.events.length === 0 && brainEvents.length === 0) return null;

    const merged = this.merge(gcalEvents.events, brainEvents);
    await this.populateConsiderations(merged);

    const today = merged.filter((e) => isWithin(e.start, todayStart, todayEnd));
    const upcoming = merged
      .filter((e) => !isWithin(e.start, todayStart, todayEnd))
      .filter((e) => e.start <= upcomingEnd);

    return {
      kind: "calendar",
      payload: { today, upcoming, liveSource: gcalEvents.ok },
    };
  }

  /**
   * For each event, ask the brain for the top-K related thoughts. Runs
   * lookups concurrently. Failure here doesn't fail the section — events
   * just render without their "Related from your brain" block.
   */
  private async populateConsiderations(items: CalendarItem[]): Promise<void> {
    const k = this.opts.considerationsTopK ?? 3;
    if (k <= 0 || items.length === 0) return;
    const threshold = this.opts.considerationsThreshold ?? 0.5;
    await Promise.all(items.map(async (item) => {
      const query = [item.summary, item.location, item.description]
        .filter(Boolean)
        .join(". ")
        .slice(0, 800);
      const related = await this.considerations.findRelated(query, { k, threshold });
      // Drop self-matches: a brain calendar_event thought IS the event.
      item.considerations = related.filter((r) => !item.sources.includes("openbrain") || r.id !== Number(item.id.replace(/^brain-/, "")));
    }));
  }

  // ─── Window math ─────────────────────────────────────────────────────────

  private windowBounds(): { todayStart: string; todayEnd: string; upcomingEnd: string } {
    const now = new Date();
    const todayStart = startOfLocalDay(now).toISOString();
    const tomorrowStart = startOfLocalDay(addDays(now, 1)).toISOString();
    const upcomingEnd = startOfLocalDay(addDays(now, this.opts.upcomingDays + 1)).toISOString();
    return { todayStart, todayEnd: tomorrowStart, upcomingEnd };
  }

  // ─── Google fetch (with skip-on-failure semantics) ──────────────────────

  private async fetchGoogleSafe(
    timeMin: string,
    timeMax: string,
  ): Promise<{ events: CalendarEvent[]; ok: boolean }> {
    const calendars = this.opts.calendarIds ?? ["primary"];
    const out: CalendarEvent[] = [];
    let allOk = true;
    for (const id of calendars) {
      try {
        const events = await this.gcal.listEvents({
          calendarId: id,
          timeMin,
          timeMax,
        });
        out.push(...events);
      } catch (err) {
        allOk = false;
        console.warn(`Calendar fetch failed for "${id}": ${err}`);
      }
    }
    return { events: out, ok: allOk };
  }

  // ─── Brain fetch (manual calendar_event captures) ───────────────────────

  private async fetchBrain(timeMin: string, timeMax: string): Promise<Thought[]> {
    try {
      return await this.brain.fetchThoughtsOfType({
        type: "calendar_event",
        limit: 100,
        extraFilters: [
          ["metadata->>event_start", `gte.${timeMin}`],
          ["metadata->>event_start", `lte.${timeMax}`],
        ],
      });
    } catch (err) {
      console.warn(`Brain calendar fetch failed: ${err}`);
      return [];
    }
  }

  // ─── Merge (dedupe by event id when possible) ────────────────────────────

  private merge(gcal: CalendarEvent[], brain: Thought[]): CalendarItem[] {
    const byId = new Map<string, CalendarItem>();

    for (const e of gcal) {
      byId.set(e.id || crypto.randomUUID(), this.fromGoogle(e));
    }

    for (const t of brain) {
      const eventId = (t.metadata?.event_id as string | undefined) ?? "";
      const existing = eventId ? byId.get(eventId) : undefined;
      if (existing) {
        // Brain thought enriches an existing Google event with notes.
        existing.sources.push("openbrain");
        if (t.content && !existing.description.includes(t.content)) {
          existing.description = existing.description
            ? `${existing.description}\n\n[Brain note] ${t.content}`
            : `[Brain note] ${t.content}`;
        }
      } else {
        const standalone = this.fromBrainThought(t);
        if (standalone) byId.set(standalone.id, standalone);
      }
    }

    return [...byId.values()].sort((a, b) => a.start.localeCompare(b.start));
  }

  private fromGoogle(e: CalendarEvent): CalendarItem {
    return {
      id: e.id,
      summary: e.summary,
      description: e.description,
      location: e.location,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      attendees: e.attendees,
      organizer: e.organizer,
      htmlLink: e.htmlLink,
      sources: ["google"],
      considerations: [],
    };
  }

  private fromBrainThought(t: Thought): CalendarItem | null {
    const meta = t.metadata ?? {};
    const start = meta.event_start as string | undefined;
    if (!start) return null;
    return {
      id: (meta.event_id as string) ?? `brain-${t.id}`,
      summary: (meta.summary as string) ?? t.content.slice(0, 80),
      description: t.content,
      location: (meta.location as string) ?? "",
      start,
      end: (meta.event_end as string) ?? start,
      allDay: Boolean(meta.all_day),
      attendees: Array.isArray(meta.attendees) ? (meta.attendees as string[]) : [],
      organizer: (meta.organizer as string) ?? "",
      htmlLink: (meta.html_link as string) ?? "",
      sources: ["openbrain"],
      considerations: [],
    };
  }
}

// ─── Time helpers (local day boundaries) ───────────────────────────────────

function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function isWithin(iso: string, startIso: string, endIso: string): boolean {
  return iso >= startIso && iso < endIso;
}
