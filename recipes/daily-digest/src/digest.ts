/**
 * DigestOrchestrator — composes sections, renders them, writes the
 * markdown audit copy, and (optionally) sends the email.
 *
 * Sections run concurrently (Promise.all). A section that throws is
 * logged but does NOT fail the whole digest — its slot is simply
 * omitted. This makes the digest robust to wttr.in outages, brain
 * downtime on one query, etc.
 */

import { GmailClient } from "./clients/gmail.ts";
import { HtmlRenderer } from "./renderers/html.ts";
import { MarkdownRenderer } from "./renderers/markdown.ts";
import { Section, SectionData } from "./sections/section.ts";

export interface DigestOrchestratorOptions {
  sections: Section[];
  htmlRenderer: HtmlRenderer;
  markdownRenderer: MarkdownRenderer;
  gmail: GmailClient;
  reportDir: string;       // where to drop the markdown audit copy (e.g. /reports)
  fromEmail: string;
  toEmail: string;
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

  async run(): Promise<DigestResult> {
    const generatedAt = new Date().toISOString();
    const subject = `Open Brain Daily Digest — ${generatedAt.slice(0, 10)}`;

    const { sectionData, ran, omitted, errors } = await this.runSections();

    // Always write the markdown audit copy first. If Gmail send fails
    // afterward, the report is still on disk for diagnosis.
    const markdown = this.opts.markdownRenderer.render(sectionData, { subject });
    const reportPath = await this.writeReport(subject, markdown);

    // Render HTML and send. A throw here surfaces in DigestResult so
    // the HTTP layer can return a meaningful status to the caller.
    const html = this.opts.htmlRenderer.render(sectionData, { generatedAt });
    await this.opts.gmail.sendHtml({
      from: this.opts.fromEmail,
      to: this.opts.toEmail,
      subject,
      htmlBody: html,
    });

    return {
      subject,
      sectionsRun: ran,
      sectionsOmitted: omitted,
      sectionErrors: errors,
      sent: true,
      reportPath,
    };
  }

  private async runSections(): Promise<{
    sectionData: SectionData[];
    ran: string[];
    omitted: string[];
    errors: Record<string, string>;
  }> {
    const ran: string[] = [];
    const omitted: string[] = [];
    const errors: Record<string, string> = {};
    const sectionData: SectionData[] = [];

    const results = await Promise.allSettled(
      this.opts.sections.map(async (section) => ({
        section,
        data: await section.produce(),
      })),
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const sectionName = this.opts.sections[i].name;
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

  private async writeReport(subject: string, markdown: string): Promise<string> {
    try {
      await Deno.mkdir(this.opts.reportDir, { recursive: true });
      const latest = `${this.opts.reportDir}/openbrain-digest-latest.md`;
      await Deno.writeTextFile(latest, markdown);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      await Deno.writeTextFile(`${this.opts.reportDir}/openbrain-digest-${ts}.md`, markdown);
      return latest;
    } catch (err) {
      console.warn(`Report write failed: ${err}`);
      return "";
    }
  }
}
