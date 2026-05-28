/**
 * GoogleCalendarClient — read-only access to the user's calendars.
 *
 * Single responsibility: list events in a time window, parse them into a
 * shape the rest of the digest can consume. Knows nothing about
 * rendering, the brain, or what "today" means in the user's timezone —
 * callers supply the timeMin/timeMax bounds.
 */

import { GoogleOAuth } from "./google-oauth.ts";

export interface CalendarEvent {
  id: string;
  calendarId: string;
  summary: string;
  description: string;
  location: string;
  start: string;        // ISO timestamp (or YYYY-MM-DD for all-day)
  end: string;
  allDay: boolean;
  attendees: string[];
  organizer: string;
  status: "confirmed" | "tentative" | "cancelled";
  htmlLink: string;
}

export interface GoogleCalendarClientOptions {
  oauth: GoogleOAuth;
}

export interface ListEventsOptions {
  /** Calendar ID. "primary" = the user's default calendar. */
  calendarId?: string;
  /** ISO timestamp; events with `end` after this are returned. */
  timeMin: string;
  /** ISO timestamp; events with `start` before this are returned. */
  timeMax: string;
  /** Hard ceiling. The API maxes at 2500; default 50 is plenty for a day. */
  maxResults?: number;
  /** Skip cancelled events. Default true. */
  excludeCancelled?: boolean;
}

export interface CalendarListEntry {
  id: string;
  summary: string;
  /** "owner" | "writer" | "reader" | "freeBusyReader" */
  accessRole: string;
  /** True for the account's primary calendar. */
  primary: boolean;
}

export class GoogleCalendarClient {
  constructor(private readonly opts: GoogleCalendarClientOptions) {}

  /**
   * Enumerate every calendar visible on the account. Used by the
   * digest to auto-discover secondary calendars (family, shared,
   * subscribed Holidays, etc.) instead of hard-coding IDs.
   */
  async listCalendars(): Promise<CalendarListEntry[]> {
    const accessToken = await this.opts.oauth.getAccessToken();
    const url = "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=100";
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`calendarList failed: ${res.status} ${err}`);
    }
    const data = await res.json();
    const items: Array<Record<string, unknown>> = data.items ?? [];
    return items.map((c) => ({
      id: String(c.id ?? ""),
      summary: String(c.summaryOverride ?? c.summary ?? c.id ?? ""),
      accessRole: String(c.accessRole ?? "reader"),
      primary: Boolean(c.primary),
    }));
  }

  async listEvents(args: ListEventsOptions): Promise<CalendarEvent[]> {
    const accessToken = await this.opts.oauth.getAccessToken();
    const calendarId = args.calendarId ?? "primary";
    const params = new URLSearchParams({
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      maxResults: String(args.maxResults ?? 50),
      singleEvents: "true",
      orderBy: "startTime",
    });
    const url =
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`Calendar list failed: ${res.status} ${err}`);
    }
    const data = await res.json();
    const items: unknown[] = data.items ?? [];
    const excludeCancelled = args.excludeCancelled ?? true;
    return items
      .map((raw) => this.parseEvent(raw, calendarId))
      .filter((e): e is CalendarEvent => e !== null)
      .filter((e) => !excludeCancelled || e.status !== "cancelled");
  }

  private parseEvent(raw: unknown, calendarId: string): CalendarEvent | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const start = r.start as Record<string, string> | undefined;
    const end = r.end as Record<string, string> | undefined;
    if (!start) return null;

    const allDay = !start.dateTime && !!start.date;
    const startIso = start.dateTime ?? start.date ?? "";
    const endIso = end?.dateTime ?? end?.date ?? "";

    const attendees = Array.isArray(r.attendees)
      ? (r.attendees as Array<Record<string, string>>)
        .map((a) => a.displayName || a.email || "")
        .filter(Boolean)
      : [];

    const organizer = (r.organizer as Record<string, string> | undefined)?.displayName ||
      (r.organizer as Record<string, string> | undefined)?.email ||
      "";

    return {
      id: String(r.id ?? ""),
      calendarId,
      summary: String(r.summary ?? "(no title)"),
      description: String(r.description ?? ""),
      location: String(r.location ?? ""),
      start: startIso,
      end: endIso,
      allDay,
      attendees,
      organizer,
      status: (r.status as CalendarEvent["status"]) ?? "confirmed",
      htmlLink: String(r.htmlLink ?? ""),
    };
  }
}
