// The per-section bound (DigestOrchestrator.sectionTimeoutMs, round 4) and the
// "not ready at send time" line (round 5, F1), on the REAL build path: the real
// orchestrator and the real HTML / markdown renderers, with a scaled bound.
// Y3 / Y4 / Y5 are the tester's attempt-4 attacks adopted in-suite (F2); Y5
// gained a hung section so that it, too, fails without the bound (as written it
// passed with no bound at all). Without the bound Y3 / Y4 / Y5 never finish.
//
// Run: deno test --allow-all src/digest.section-timeout.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { DigestOrchestrator, NOT_READY_LINE } from "./digest.ts";
import { HtmlRenderer } from "./renderers/html.ts";
import { MarkdownRenderer } from "./renderers/markdown.ts";
import type { Section, SectionData } from "./sections/section.ts";

function orchestrator(sections: Section[], bound: number, dir: string) {
  return new DigestOrchestrator({
    sections,
    htmlRenderer: new HtmlRenderer(),
    markdownRenderer: new MarkdownRenderer(),
    gmail: { sendHtml: () => Promise.reject(new Error("no send in this test")) } as never,
    reportDir: dir,
    fromEmail: "a@example.test",
    toEmail: "a@example.test",
    sectionTimeoutMs: bound,
  });
}
const good: Section = {
  name: "good",
  produce: () => Promise.resolve({ kind: "routine_notice", payload: { tone: "info", title: "GOOD-SECTION-RENDERED", lines: [] } } as SectionData),
};
const hung = (name: string): Section => ({ name, produce: () => new Promise<SectionData | null>(() => {}) });
const boom = (name: string, detail = "boom"): Section => ({ name, produce: () => Promise.reject(new Error(detail)) });

Deno.test({
  // sanitizers ON: a bound timer left running after build() would fail this test
  name: "Y3 a hung section is cut at the bound, the rest renders, the bound timer is cleared (op sanitizer ON)",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "digest-y3-" });
    try {
      const t0 = performance.now();
      const b = await orchestrator([hung("calendar"), good], 300, dir).build({ subject: "s" });
      const ms = performance.now() - t0;
      assert(ms < 1_000, `build took ${ms} ms`);
      assertEquals(b.sectionsRun, ["good"]);
      assertEquals(b.sectionsOmitted, ["calendar"]);
      assert(/timed out after 300 ms/.test(b.sectionErrors.calendar));
      assert(b.html.includes("GOOD-SECTION-RENDERED"));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "Y4 three hung sections: the delay is ONE bound (parallel), not three",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "digest-y4-" });
    try {
      const t0 = performance.now();
      const b = await orchestrator([hung("weather"), hung("calendar"), hung("x"), good], 400, dir).build({ subject: "s" });
      const ms = performance.now() - t0;
      assert(ms < 800, `build took ${ms} ms (serial?)`);
      assertEquals(b.sectionsOmitted.sort(), ["calendar", "weather", "x"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "Y5 a section answering inside the bound is kept; a throwing one and a hung one are omitted",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "digest-y5-" });
    try {
      const slowOk: Section = {
        name: "slowok",
        produce: () => new Promise((r) => setTimeout(() => r({ kind: "routine_notice", payload: { tone: "info", title: "SLOW-OK", lines: [] } } as SectionData), 150)),
      };
      const b = await orchestrator([slowOk, boom("boom"), hung("stuck")], 400, dir).build({ subject: "s" });
      assertEquals(b.sectionsRun, ["slowok"]);
      assertEquals(b.sectionsOmitted, ["boom", "stuck"]);
      assert(b.html.includes("SLOW-OK"));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "F1 a timed-out and a throwing section each render ONE fixed line 'not ready at send time' (html + audit copy), no error detail; a section with no data says nothing",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "digest-f1-" });
    try {
      const empty: Section = { name: "ai_news", produce: () => Promise.resolve(null) };
      const b = await orchestrator([hung("calendar"), boom("weather", "SECRET-DETAIL wttr 503 at https://x.test"), empty, good], 300, dir)
        .build({ subject: "s" });
      assertEquals(b.sectionsOmitted.sort(), ["ai_news", "calendar", "weather"]);
      const md = await Deno.readTextFile(b.reportPath);
      for (const doc of [b.html, md]) {
        assert(doc.includes(`calendar: ${NOT_READY_LINE}`), "the timed-out section is said");
        assert(doc.includes(`weather: ${NOT_READY_LINE}`), "the throwing section is said");
        assert(!doc.includes(`ai_news: ${NOT_READY_LINE}`), "a section that simply had nothing is not a failure");
        assert(!/SECRET-DETAIL|timed out after|https:\/\/x\.test/.test(doc), "no error detail in the email");
        assertEquals(doc.split(NOT_READY_LINE).length - 1, 2, "one line per failed section");
      }
      assert(b.html.includes("GOOD-SECTION-RENDERED"));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "F1b nothing failed -> no 'not ready' box at all",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "digest-f1b-" });
    try {
      const b = await orchestrator([good], 300, dir).build({ subject: "s" });
      assert(!b.html.includes(NOT_READY_LINE));
      assert(!/Not ready at send time/i.test(b.html));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
