/**
 * CalendarSection — today + tomorrow + a curated "needs prep" lookahead.
 *
 * Three-bucket model (per user spec, 2026-05-28):
 *
 *   Today        — every event scheduled for today
 *   Tomorrow     — every event scheduled for tomorrow
 *   Needs prep   — selected events in the next ~30 days that warrant
 *                  early visibility (flights, interviews, family
 *                  birthdays, anything tagged [prep] in the description)
 *
 * Sources:
 *   - Google Calendar — auto-discovered: queries every calendar visible
 *     on the account (primary + secondary + subscribed, e.g. Holidays).
 *     The user can opt out per calendar via DIGEST_EXCLUDE_CALENDAR_IDS.
 *   - Open Brain — calendar_event thoughts (manual captures), merged by
 *     event id when available.
 *
 * Family-name awareness: a profile_field/family_members entry in the
 * brain (comma- or newline-separated names) flags events whose summary
 * or attendees mention those people, even if no other prep keyword
 * matches. See docs/open-brain-profile-convention.md.
 */

import { BrainClient, Thought } from "../clients/postgrest.ts";
import { GoogleCalendarClient, CalendarEvent, CalendarListEntry } from "../clients/google-calendar.ts";
import { ConsiderationsSynthesizer } from "../considerations/synthesizer.ts";
import { Section, SectionData } from "./section.ts";

// ─── Payload ────────────────────────────────────────────────────────────────

export interface CalendarPayload {
  today: CalendarItem[];
  tomorrow: CalendarItem[];
  needsPrep: PrepItem[];
  liveSource: boolean;
  calendarsQueried: number;
  windowDays: number;
}

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
  calendarName: string;
  sources: Array<"google" | "openbrain">;
  /** LLM-synthesized "Related from your brain" paragraph. Null = nothing useful. */
  considerationsSummary: string | null;
  /** How many brain items the synthesis was grounded in (transparency). */
  considerationsSourceCount: number;
}

export interface PrepItem extends CalendarItem {
  /** Human-readable explanations for why this event needs prep. */
  reasons: string[];
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface CalendarSectionOptions {
  /** How many days ahead to scan for prep-worthy events. Default 30. */
  prepWindowDays: number;
  /** Calendar IDs to skip even when auto-discovered (e.g. noisy subs). */
  excludeCalendarIds?: string[];
  /** Override the default keyword list used to flag prep-worthy events. */
  prepKeywords?: PrepKeywords;
  /** Set false to skip the synthesis pass entirely. Default true. */
  synthesizeConsiderations?: boolean;
}

export interface PrepKeywords {
  travel: string[];
  interview: string[];
  milestone: string[];   // birthday, anniversary
  manual: string[];      // explicit [tag] markers in the description
}

const DEFAULT_PREP_KEYWORDS: PrepKeywords = {
  travel:    ["flight", "airline", "airport", "boarding", "plane", "train", "amtrak", "hotel", "lodging", "trip", "travel", "vacation", "road trip"],
  interview: ["interview", "panel"],
  milestone: ["birthday", "anniversary", "bday", "b-day", "wedding"],
  manual:    ["[prep]", "[important]", "[vip]"],
};

// ─── Section ────────────────────────────────────────────────────────────────

export class CalendarSection implements Section {
  readonly name = "calendar";

  constructor(
    private readonly brain: BrainClient,
    private readonly gcal: GoogleCalendarClient,
    private readonly synthesizer: ConsiderationsSynthesizer | null,
    private readonly opts: CalendarSectionOptions,
  ) {}

  async produce(): Promise<SectionData<CalendarPayload> | null> {
    const bounds = this.windowBounds();
    const familyNames = await this.loadFamilyNames();
    const keywords = this.opts.prepKeywords ?? DEFAULT_PREP_KEYWORDS;
    const exclude = new Set(this.opts.excludeCalendarIds ?? []);

    const gcalResult = await this.fetchAllGoogle(bounds.windowStart, bounds.windowEnd, exclude);
    const brainEvents = await this.fetchBrain(bounds.windowStart, bounds.windowEnd);

    if (gcalResult.events.length === 0 && brainEvents.length === 0) {
      if (!gcalResult.ok) {
        throw new Error(
          gcalResult.errorMessage ?? "Google Calendar fetch failed and no brain fallback.",
        );
      }
      return null;
    }

    const merged = this.merge(gcalResult.events, brainEvents);

    const today = merged.filter((e) => withinDay(e.start, bounds.todayStart, bounds.tomorrowStart));
    const tomorrow = merged.filter((e) => withinDay(e.start, bounds.tomorrowStart, bounds.dayAfterTomorrowStart));
    const lookahead = merged
      .filter((e) => e.start >= bounds.dayAfterTomorrowStart && e.start < bounds.windowEnd);

    const needsPrep = lookahead
      .map((item) => this.classifyPrep(item, keywords, familyNames))
      .filter((p): p is PrepItem => p !== null);

    // Populate considerations only for events that will be rendered.
    const visible = [...today, ...tomorrow, ...needsPrep];
    await this.populateConsiderations(visible);

    return {
      kind: "calendar",
      payload: {
        today,
        tomorrow,
        needsPrep,
        liveSource: gcalResult.ok,
        calendarsQueried: gcalResult.calendarsQueried,
        windowDays: this.opts.prepWindowDays,
      },
    };
  }

  // ─── Family-name awareness ──────────────────────────────────────────────

  private async loadFamilyNames(): Promise<Set<string>> {
    try {
      const raw = await this.brain.fetchProfileField("family_members");
      if (!raw) return new Set();
      return new Set(
        raw
          .split(/[,\n]/)
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length >= 2),
      );
    } catch {
      return new Set();
    }
  }

  // ─── Prep classification ────────────────────────────────────────────────

  private classifyPrep(
    item: CalendarItem,
    keywords: PrepKeywords,
    familyNames: Set<string>,
  ): PrepItem | null {
    const reasons: string[] = [];
    const haystack = `${item.summary} ${item.description} ${item.location}`.toLowerCase();
    const attendeesLower = item.attendees.map((a) => a.toLowerCase());

    matchKeywords(haystack, keywords.travel, (k) => reasons.push(`travel keyword: ${k}`));
    matchKeywords(haystack, keywords.interview, (k) => reasons.push(`interview keyword: ${k}`));
    matchKeywords(haystack, keywords.milestone, (k) => reasons.push(`milestone keyword: ${k}`));
    matchKeywords(haystack, keywords.manual, (k) => reasons.push(`tag: ${k}`));

    for (const name of familyNames) {
      if (haystack.includes(name) || attendeesLower.some((a) => a.includes(name))) {
        reasons.push(`family: ${name}`);
      }
    }

    if (reasons.length === 0) return null;
    return { ...item, reasons };
  }

  // ─── Multi-calendar Google fetch ─────────────────────────────────────────

  private async fetchAllGoogle(
    timeMin: string,
    timeMax: string,
    exclude: Set<string>,
  ): Promise<{ events: CalendarEvent[]; ok: boolean; errorMessage?: string; calendarsQueried: number }> {
    let calendars: CalendarListEntry[];
    try {
      calendars = await this.gcal.listCalendars();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`calendarList failed: ${msg}`);
      // Fall back to primary alone if listing fails — better than nothing.
      return await this.fetchSpecific(["primary"], timeMin, timeMax, msg);
    }

    const targetIds = calendars
      .filter((c) => !exclude.has(c.id))
      .map((c) => c.id);

    return await this.fetchSpecific(targetIds, timeMin, timeMax);
  }

  private async fetchSpecific(
    ids: string[],
    timeMin: string,
    timeMax: string,
    seedError?: string,
  ): Promise<{ events: CalendarEvent[]; ok: boolean; errorMessage?: string; calendarsQueried: number }> {
    const tasks = ids.map((id) =>
      this.gcal.listEvents({ calendarId: id, timeMin, timeMax }).then(
        (events) => ({ id, events, error: null as string | null }),
        (err) => ({ id, events: [] as CalendarEvent[], error: err instanceof Error ? err.message : String(err) }),
      )
    );
    const results = await Promise.all(tasks);

    const out: CalendarEvent[] = [];
    let lastError = seedError;
    let allOk = !seedError;
    for (const r of results) {
      if (r.error) {
        allOk = false;
        lastError = r.error;
        const oneLine = r.error.replace(/\s+/g, " ").slice(0, 240);
        console.warn(`Calendar fetch failed for "${r.id}": ${oneLine}`);
      } else {
        // Tag events with their calendar id so the renderer can show
        // which calendar each event came from (BP, Holidays, etc.).
        for (const e of r.events) out.push({ ...e, calendarId: r.id });
      }
    }
    return { events: out, ok: allOk, errorMessage: lastError, calendarsQueried: ids.length };
  }

  // ─── Brain calendar_event thoughts (manual captures) ────────────────────

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

  // ─── Merge (dedupe by event id) ─────────────────────────────────────────

  private merge(gcal: CalendarEvent[], brain: Thought[]): CalendarItem[] {
    const byId = new Map<string, CalendarItem>();
    for (const e of gcal) {
      byId.set(e.id || crypto.randomUUID(), this.fromGoogle(e));
    }
    for (const t of brain) {
      const eventId = (t.metadata?.event_id as string | undefined) ?? "";
      const existing = eventId ? byId.get(eventId) : undefined;
      if (existing) {
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
      calendarName: e.calendarId,
      sources: ["google"],
      considerationsSummary: null,
      considerationsSourceCount: 0,
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
      calendarName: (meta.calendar_id as string) ?? "openbrain",
      sources: ["openbrain"],
      considerationsSummary: null,
      considerationsSourceCount: 0,
    };
  }

  // ─── Considerations enrichment ──────────────────────────────────────────

  /**
   * Per-event synthesis: ask the ConsiderationsSynthesizer to produce
   * one 1–3 sentence brief grounded in semantically related brain
   * items. Returns null when nothing actually useful exists — events
   * with no synthesis render no "Related from your brain" block at
   * all (better than filler).
   *
   * Synthesizer-internal logic decides strategy:
   *   - Birthday events → targeted query about the person (gifts,
   *     interests, personality), de-prioritizes location/activity noise.
   *   - Generic events → bridge via event title + description.
   */
  private async populateConsiderations(items: CalendarItem[]): Promise<void> {
    if (!this.synthesizer || items.length === 0) return;

    await Promise.all(items.map(async (item) => {
      try {
        const result = await this.synthesizer!.forEvent({
          summary: item.summary,
          description: item.description,
          location: item.location,
        });
        if (result) {
          item.considerationsSummary = result.summary;
          item.considerationsSourceCount = result.sourceCount;
        }
      } catch (err) {
        // Synthesis failure is non-fatal — event just renders without
        // the brain block.
        console.warn(
          `Synthesis failed for "${item.summary}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }));
  }

  // ─── Time windows ───────────────────────────────────────────────────────

  private windowBounds() {
    const now = new Date();
    const todayStart = startOfLocalDay(now).toISOString();
    const tomorrowStart = startOfLocalDay(addDays(now, 1)).toISOString();
    const dayAfterTomorrowStart = startOfLocalDay(addDays(now, 2)).toISOString();
    const windowStart = todayStart;
    const windowEnd = startOfLocalDay(addDays(now, this.opts.prepWindowDays + 1)).toISOString();
    return { todayStart, tomorrowStart, dayAfterTomorrowStart, windowStart, windowEnd };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function withinDay(iso: string, startIso: string, endIso: string): boolean {
  return iso >= startIso && iso < endIso;
}

function matchKeywords(haystack: string, words: string[], onHit: (word: string) => void) {
  for (const w of words) {
    if (haystack.includes(w.toLowerCase())) onHit(w);
  }
}
