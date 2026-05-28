/**
 * AiNewsSection — emails ingested into the brain in the digest window.
 *
 * Groups thoughts by gmail_id so a single newsletter's 15-chunk split
 * collapses to one entry. Pulls the per-email metadata (topics, people,
 * action_items, gmail labels) that the metadata-extraction pass on
 * capture has already populated. No LLM calls here — purely mechanical.
 */

import { BrainClient, Thought } from "../clients/postgrest.ts";
import { Section, SectionData } from "./section.ts";

export interface AiNewsPayload {
  windowHours: number;
  emails: EmailGroup[];
  ungrouped: Thought[];
  bySender: Map<string, EmailGroup[]>;
  topTopics: Array<{ topic: string; count: number }>;
  totalActionItems: number;
}

export interface EmailHeader {
  sender: string;
  address: string;
  subject: string;
  date: string;
}

export interface EmailGroup {
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

export interface AiNewsSectionOptions {
  windowHours: number;
  limit: number;
}

export class AiNewsSection implements Section {
  readonly name = "ai_news";

  constructor(
    private readonly brain: BrainClient,
    private readonly opts: AiNewsSectionOptions,
  ) {}

  async produce(): Promise<SectionData<AiNewsPayload> | null> {
    const thoughts = await this.brain.fetchRecentThoughts({
      windowHours: this.opts.windowHours,
      limit: this.opts.limit,
      // profile_field is internal config, not news. Calendar/todo events
      // will get their own sections so don't leak in here either.
      excludeTypes: ["profile_field", "calendar_event", "todo"],
    });
    if (thoughts.length === 0) return null;

    const { emails, ungrouped } = this.groupGmail(thoughts);
    const bySender = this.groupBySender(emails);
    return {
      kind: "ai_news",
      payload: {
        windowHours: this.opts.windowHours,
        emails,
        ungrouped,
        bySender,
        topTopics: this.topTopics(emails, 6),
        totalActionItems: emails.reduce((s, e) => s + e.actionItems.length, 0),
      },
    };
  }

  private groupGmail(thoughts: Thought[]): { emails: EmailGroup[]; ungrouped: Thought[] } {
    const byId = new Map<string, Thought[]>();
    const ungrouped: Thought[] = [];

    for (const t of thoughts) {
      const id = t.metadata?.gmail_id;
      if (typeof id === "string" && id.length > 0) {
        const existing = byId.get(id);
        if (existing) existing.push(t);
        else byId.set(id, [t]);
      } else {
        ungrouped.push(t);
      }
    }

    const emails: EmailGroup[] = [];
    for (const [gmailId, chunks] of byId) {
      const header = chunks.find((c) => Number(c.metadata?.chunk_index) === 0) ?? chunks[0];
      const meta = header.metadata ?? {};
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

  private groupBySender(emails: EmailGroup[]): Map<string, EmailGroup[]> {
    const by = new Map<string, EmailGroup[]>();
    for (const e of emails) {
      const key = e.header ? `${e.header.sender} <${e.header.address}>` : "(unknown sender)";
      if (!by.has(key)) by.set(key, []);
      by.get(key)!.push(e);
    }
    return by;
  }

  private topTopics(emails: EmailGroup[], limit: number) {
    const counts = new Map<string, number>();
    for (const e of emails) for (const t of e.topics) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([topic, count]) => ({ topic, count }));
  }
}

function parseEmailHeader(content: string): EmailHeader | null {
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
