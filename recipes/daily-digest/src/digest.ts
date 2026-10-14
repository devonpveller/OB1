/**
 * DigestOrchestrator — composes sections, renders them, writes the
 * markdown audit copy, and (optionally) sends the email.
 *
 * Sections run concurrently (Promise.all). A section that throws is
 * logged but does NOT fail the whole digest — its slot is simply
 * omitted. This makes the digest robust to wttr.in outages, brain
 * downtime on one query, etc.
 *
 * WHEN to send and whether a send is allowed (send-by deadline, send-once
 * marker, follow-up) is the MorningRoutine's job (src/routine/routine.ts);
 * this class only builds and sends what it is asked to.
 */

import { MailTransport } from "./clients/gmail.ts";
import { HtmlRenderer } from "./renderers/html.ts";
import { MarkdownRenderer } from "./renderers/markdown.ts";
import { Section, SectionData } from "./sections/section.ts";
import { RoutineNoticePayload } from "./sections/routine-notice.ts";

export interface DigestOrchestratorOptions {
  sections: Section[];
  htmlRenderer: HtmlRenderer;
  markdownRenderer: MarkdownRenderer;
  gmail: MailTransport;
  reportDir: string;       // where to drop the markdown audit copy (e.g. /reports)
  fromEmail: string;
  toEmail: string;
  /** Bound on each section's produce() (round 4): a slow model can never hold a send. Default 60 s. */
  sectionTimeoutMs?: number;
}

export interface DigestRunOptions {
  /** Subject override (the routine passes its LOCAL date). */
  subject?: string;
  /** Section names NOT to run (e.g. a podcast brief that is not today's). */
  skipSections?: string[];
  /** Run ONLY these sections (the follow-up email). */
  onlySections?: string[];
  /** Boxes rendered first: what is still running / failed. */
  notices?: RoutineNoticePayload[];
  /** Audit-copy file stem (default openbrain-digest). */
  reportStem?: string;
  generatedAt?: string;
}

/** A digest rendered and audit-copied but NOT sent (round 2: build first,
 *  claim the send-once marker only right before the transport). */
export interface BuiltDigest {
  subject: string;
  html: string;
  sectionsRun: string[];
  sectionsOmitted: string[];
  sectionErrors: Record<string, string>;
  reportPath: string;
}

export interface DigestResult {
  subject: string;
  sectionsRun: string[];
  sectionsOmitted: string[];
  sectionErrors: Record<string, string>;
  sent: boolean;
  reportPath: string;
}

export class DigestOrchestrator {
  constructor(private readonly opts: DigestOrchestratorOptions) {}

  get sectionNames(): string[] {
    return this.opts.sections.map((s) => s.name);
  }

  async run(o: DigestRunOptions = {}): Promise<DigestResult> {
    const b = await this.build(o);
    await this.send(b);
    return { ...b, sent: true };
  }

  /** Transport only. */
  async send(b: BuiltDigest, marker?: string): Promise<void> {
    await this.opts.gmail.sendHtml({ from: this.opts.fromEmail, to: this.opts.toEmail, subject: b.subject, htmlBody: b.html, marker });
  }

  /** Dependency check for the routine (Gmail auth). */
  async checkMailAuth(): Promise<void> {
    await this.opts.gmail.checkAuth?.();
  }

  /** Sections + render + audit copy; nothing is sent. */
  async build(o: DigestRunOptions = {}): Promise<BuiltDigest> {
    const generatedAt = o.generatedAt ?? new Date().toISOString();
    const subject = o.subject ?? `Open Brain Daily Digest — ${generatedAt.slice(0, 10)}`;

    const selected = this.opts.sections.filter((s) =>
      (o.onlySections ? o.onlySections.includes(s.name) : true) && !(o.skipSections ?? []).includes(s.name)
    );
    const { sectionData, ran, omitted, errors } = await this.runSections(selected);
    const notices: SectionData[] = (o.notices ?? []).map((n) => ({ kind: "routine_notice", payload: n }));
    const all = [...notices, ...sectionData];

    // Always write the markdown audit copy first. If Gmail send fails
    // afterward, the report is still on disk for diagnosis.
    const markdown = this.opts.markdownRenderer.render(all, { subject });
    const reportPath = await this.writeReport(subject, markdown, o.reportStem ?? "openbrain-digest");

    // Render HTML and send. A throw here surfaces in DigestResult so
    // the HTTP layer can return a meaningful status to the caller.
    const html = this.opts.htmlRenderer.render(all, { generatedAt });
    return { subject, html, sectionsRun: ran, sectionsOmitted: omitted, sectionErrors: errors, reportPath };
  }

  private async runSections(sections: Section[]): Promise<{
    sectionData: SectionData[];
    ran: string[];
    omitted: string[];
    errors: Record<string, string>;
  }> {
    const ran: string[] = [];
    const omitted: string[] = [];
    const errors: Record<string, string> = {};
    const sectionData: SectionData[] = [];

    const bound = this.opts.sectionTimeoutMs ?? 60_000;
    const results = await Promise.allSettled(
      sections.map(async (section) => {
        let t: ReturnType<typeof setTimeout> | undefined;
        try {
          const data = await Promise.race([
            section.produce(),
            new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`section timed out after ${bound} ms`)), bound))),
          ]);
          return { section, data };
        } finally {
          clearTimeout(t);
        }
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const sectionName = sections[i].name;
      if (r.status === "rejected") {
        errors[sectionName] = String(r.reason);
        console.warn(`Section "${sectionName}" failed: ${r.reason}`);
        omitted.push(sectionName);
        continue;
      }
      const { data } = r.value;
      if (data === null) {
        omitted.push(sectionName);
        continue;
      }
      ran.push(sectionName);
      sectionData.push(data);
    }
    return { sectionData, ran, omitted, errors };
  }

  private async writeReport(subject: string, markdown: string, stem: string): Promise<string> {
    try {
      await Deno.mkdir(this.opts.reportDir, { recursive: true });
      const latest = `${this.opts.reportDir}/${stem}-latest.md`;
      await Deno.writeTextFile(latest, markdown);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      await Deno.writeTextFile(`${this.opts.reportDir}/${stem}-${ts}.md`, markdown);
      return latest;
    } catch (err) {
      console.warn(`Report write failed: ${err}`);
      return "";
    }
  }
}
