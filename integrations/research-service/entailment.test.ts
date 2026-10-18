/**
 * The entailment stage (research-workbench P3a, D10) replayed over the recorded fixture layer
 * (fixtures/entailment/*.entail.json: the cited text each line was judged against + the judge
 * response). No model is called: the judge is a replay stub that answers ONLY the exact prompt
 * the fixture recorded, and throws for any line it has no record of.
 * Run: deno test --allow-read entailment.test.ts
 */
import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyVerdicts, citedLines, citedWindows, ENTAIL_PROMPT_VERSION, ENTAIL_SYS, type JudgeDeps, judgeLines,
  judgeUserPrompt, type LineVerdict, parseVerdict, type VerdictEffect,
} from "./entailment.ts";
import { buildModel, lineCredibility } from "./credibility.ts";
import { seedSet } from "./fixtures/credibility-seeds.ts";
import { coverageFooter, emptySearchRecord, entailmentFooterLine } from "./report.ts";
import { ModelDownError } from "./llm.ts";

const seeds = seedSet();
const model = buildModel(seeds.rows, seeds.versions);
const EFFECTS: VerdictEffect[] = [...model.verdicts.values()].map((v) => ({ key: v.key, tagEffect: v.tagEffect }));
const VERDICT_KEYS = new Set(EFFECTS.map((e) => e.key));

interface FixtureLine { line: number; tag: string; text: string; cites: number[]; cited_text: Array<{ source: number; title: string; windows: string[] }>; judge_response: string; verdict: string }
interface EntailFixture { job_fixture: string; job_id: string; prompt_version: string; question: string; lines: FixtureLine[] }
interface Job { job_id: string; query: string; synthesis: string; cited_texts: Array<{ title: string; content: string }> }

const read = <T>(rel: string): T => JSON.parse(Deno.readTextFileSync(new URL(rel, import.meta.url)));
const FIXTURES = ["job-100hz", "job-optiplex"];

/** The replay judge: answers only a prompt the fixture recorded, byte for byte. */
function replayJudge(fx: EntailFixture, job: Job): JudgeDeps & { asked: number } {
  const byPrompt = new Map<string, string>();
  for (const l of fx.lines) {
    const cl = citedLines(job.synthesis).find((c) => c.index === l.line);
    if (!cl) continue;
    byPrompt.set(judgeUserPrompt(fx.question, cl, l.cited_text), l.judge_response);
  }
  const deps = {
    asked: 0,
    chat(sys: string, user: string): Promise<string> {
      if (sys !== ENTAIL_SYS) throw new Error("not the entailment judge");
      deps.asked++;
      const r = byPrompt.get(user);
      if (r === undefined) throw new Error(`no recorded judge response for prompt: ${user.split("\n")[2]?.slice(0, 120)}`);
      return Promise.resolve(r);
    },
  };
  return deps;
}

async function replay(name: string): Promise<{ job: Job; fx: EntailFixture; verdicts: LineVerdict[] }> {
  const job = read<Job>(`./fixtures/${name}.json`);
  const fx = read<EntailFixture>(`./fixtures/entailment/${name}.entail.json`);
  const judge = replayJudge(fx, job);
  // A recorded line the judge cannot be asked about would be a hole in the layer: the strict
  // stub turns it into a no_verdict (fail-closed), which the per-line check below rejects.
  const strict: JudgeDeps = { chat: (s, u) => judge.chat(s, u).catch((e) => { throw new Error(`REPLAY GAP: ${e.message}`); }) };
  const verdicts = await judgeLines(strict, job.synthesis, {
    question: fx.question, pool: job.cited_texts, verdicts: EFFECTS, concurrency: 1,
  });
  return { job, fx, verdicts };
}

for (const name of FIXTURES) {
  Deno.test(`fixture layer ${name}: the recorded cited text is exactly what the stage cuts`, () => {
    const job = read<Job>(`./fixtures/${name}.json`);
    const fx = read<EntailFixture>(`./fixtures/entailment/${name}.entail.json`);
    assertEquals(fx.prompt_version, ENTAIL_PROMPT_VERSION);
    assertEquals(fx.job_id, job.job_id);
    const lines = citedLines(job.synthesis);
    assertEquals(fx.lines.map((l) => l.line), lines.map((l) => l.index), "one recorded entry per cited line");
    for (const l of lines) {
      const rec = fx.lines.find((x) => x.line === l.index)!;
      for (const c of rec.cited_text) {
        assertEquals(c.windows, citedWindows(l.text, job.cited_texts[c.source - 1].content), `line ${l.index} source ${c.source}`);
      }
    }
  });

  Deno.test(`replay ${name}: one registered verdict per cited line, as recorded; a line without one FAILS`, async () => {
    const { job, fx, verdicts } = await replay(name);
    const lines = citedLines(job.synthesis);
    assertEquals(verdicts.length, lines.length);
    for (const l of lines) {
      const v = verdicts.find((x) => x.line === l.index);
      assert(v, `cited line ${l.index} has no verdict`);
      assert(VERDICT_KEYS.has(v.verdict), `line ${l.index}: '${v.verdict}' is not a registered verdict`);
      assertEquals(v.basis, "judge", `line ${l.index} was not judged from the recorded response (${v.rationale})`);
      assertEquals(v.verdict, fx.lines.find((x) => x.line === l.index)!.verdict);
    }
  });
}

Deno.test("the replay FAILS when the fixture layer lacks a line (the check is real)", async () => {
  const job = read<Job>("./fixtures/job-100hz.json");
  const fx = read<EntailFixture>("./fixtures/entailment/job-100hz.entail.json");
  const holed = { ...fx, lines: fx.lines.filter((l) => l.line !== 6) };
  const verdicts = await judgeLines(replayJudge(holed, job), job.synthesis, {
    question: fx.question, pool: job.cited_texts, verdicts: EFFECTS, concurrency: 1,
  });
  const six = verdicts.find((v) => v.line === 6)!;
  assertEquals(six.basis, "no_verdict");                  // the per-line assertion above would reject this
  assertEquals(six.verdict, "unsupported");               // ...and in production it fails CLOSED
});

Deno.test("100 Hz replay: 4 of 13 cited lines demoted, line 15 (contradicted by its own source) to [GAP]", async () => {
  const { job, verdicts } = await replay("job-100hz");
  const { synthesis, record } = applyVerdicts(job.synthesis, verdicts, EFFECTS);
  assertEquals(record.lines, 13);
  assertEquals(record.demoted, 4);
  assertEquals(record.by_verdict, { supports: 8, partial: 4, unsupported: 1 });
  const out = synthesis.split("\n");
  assertEquals(out.length, job.synthesis.split("\n").length, "index-safe: line count preserved");
  assert(out[15].startsWith("[GAP]") && !/\[Source/.test(out[15]), out[15]);
  assert(out[6].startsWith("[UNCERTAIN]") && out[6].includes("[Source 5, 9]"), out[6]);
  assert(out[17].startsWith("[UNCERTAIN]"), "already UNCERTAIN: partial does not demote it again");
  assertEquals(record.audit.map((a) => a.line), [6, 8, 15, 16]);
});

// ── acceptance: the ce398d06 meta-statement is not filed as a 0.85 claim ──
Deno.test("REPLAY ce398d06: the synthesiser's meta-statement is judged unsupported and leaves as a [GAP]", async () => {
  const { job, verdicts } = await replay("job-optiplex");
  assertEquals(job.job_id.slice(0, 8), "ce398d06");
  const meta = verdicts.find((v) => v.line === 0)!;
  assertStringIncludes(meta.text, "The provided sources contain no information specific to the Dell OptiPlex 3050");
  assertEquals(meta.verdict, "unsupported");
  const { synthesis, record } = applyVerdicts(job.synthesis, verdicts, EFFECTS);
  const line0 = synthesis.split("\n")[0];
  assert(line0.startsWith("[GAP]"), line0);
  assert(!/\[Source/.test(line0), "a [GAP] carries no citation, so it cannot ground a claim");
  assertEquals(record.demoted, 4);
  // ...and under the D15 model the line carries no credibility at all (it was 0.85 in the store).
  assertEquals(lineCredibility(model, "practical", 0, meta.verdict, [{ total: 0.9 }]).total, 0);
  // the 95 C line the numeric gate caught is also unsupported here (grounding.ts agrees)
  assertEquals(verdicts.find((v) => v.line === 14)!.verdict, "unsupported");
});

Deno.test({
  name: "REPLAY ce398d06 through the curator's own parser: nothing about the run is filed as a claim",
  ignore: (() => { try { Deno.statSync(new URL("../research-curator/claims.ts", import.meta.url)); return false; } catch { return true; } })(),
  async fn() {
    const { parseSynthesisClaims } = await import("../research-curator/claims.ts");
    const { job, verdicts } = await replay("job-optiplex");
    const before = parseSynthesisClaims(job.synthesis).claims.map((c: { text: string }) => c.text);
    assert(before.some((t: string) => t.startsWith("The provided sources contain no information")),
      "precondition: without the stage the curator parse WOULD file the meta-statement");
    const { synthesis } = applyVerdicts(job.synthesis, verdicts, EFFECTS);
    const after = parseSynthesisClaims(synthesis);
    assert(!after.claims.some((c: { text: string }) => /provided sources contain no information/i.test(c.text)),
      "the meta-statement must not be parsed as a claim");
    assert(after.gaps.some((g: string) => /provided sources contain no information/i.test(g)), "it is recorded as a gap");
    assert(!after.claims.some((c: { text: string }) => /95/.test(c.text)), "the unsupported 95 C line is not a claim either");
  },
});

// ── acceptance: the Skeptic's recorded downgrades are reproduced (D10) ──
Deno.test("the entailment stage reproduces every recorded Skeptic downgrade byte for byte", () => {
  const fx = read<{ synthesis: string; cases: Array<{ name: string; verdicts: string[]; skeptic_output: string; skeptic_applied: number }> }>(
    "./fixtures/skeptic-regression.json");
  for (const c of fx.cases) {
    const lines = citedLines(fx.synthesis);
    const verdicts: LineVerdict[] = lines.map((l, i) => ({
      line: l.index, text: l.text, tag: l.tag, cites: l.cites, verdict: c.verdicts[i], basis: "judge", rationale: "", cited_text: [],
    }));
    const { synthesis, record } = applyVerdicts(fx.synthesis, verdicts, EFFECTS);
    assertEquals(synthesis, c.skeptic_output, c.name);
    assertEquals(record.demoted, c.skeptic_applied, c.name);
  }
});

// ── fail-closed, and the footer ──
Deno.test("a judge that gives no usable verdict fails CLOSED (unsupported, counted), after one retry", async () => {
  let calls = 0;
  const v = await judgeLines({ chat: () => { calls++; return Promise.resolve("I think it is fine"); } },
    "[SOURCED] Cats purr. [Source 1]", { question: "q", pool: [{ title: "t", content: "Cats purr at 25 Hz." }], verdicts: EFFECTS });
  assertEquals(calls, 2);
  assertEquals(v[0].verdict, "unsupported");
  assertEquals(v[0].basis, "no_verdict");
  const { record } = applyVerdicts("[SOURCED] Cats purr. [Source 1]", v, EFFECTS);
  assertEquals(record.no_verdict, 1);
  assertEquals(record.demoted, 1);
});

Deno.test("a latched model-down error is not swallowed: it reaches the job layer", async () => {
  await assertRejects(() => judgeLines({ chat: () => Promise.reject(new ModelDownError("down", true)) },
    "[SOURCED] Cats purr. [Source 1]", { question: "q", pool: [{ title: "t", content: "Cats purr." }], verdicts: EFFECTS }));
});

Deno.test("a citation that resolves to no text is unsupported without asking the judge", async () => {
  const v = await judgeLines({ chat: () => { throw new Error("must not be called"); } },
    "[SOURCED] Cats purr. [Source 4]", { question: "q", pool: [{ title: "t", content: "x" }], verdicts: EFFECTS });
  assertEquals([v[0].verdict, v[0].basis], ["unsupported", "no_cited_text"]);
});

Deno.test("verdicts are registry keys: an unknown one is refused, never guessed", () => {
  assertEquals(parseVerdict('{"verdict":"maybe"}', VERDICT_KEYS), null);
  assertEquals(parseVerdict('```json\n{"verdict":"Supports","rationale":"x"}\n```', VERDICT_KEYS)?.verdict, "supports");
  assertThrows(() => applyVerdicts("[SOURCED] a [Source 1]", [{ line: 0, text: "a", tag: "SOURCED", cites: [1], verdict: "maybe", basis: "judge", rationale: "", cited_text: [] }], EFFECTS),
    Error, "'maybe'");
});

Deno.test("the report footer prints the demoted count (and prints it when it is zero)", () => {
  const f = coverageFooter([{ need: "n", status: "answered" }], emptySearchRecord(), "complete", null, null,
    { lines: 13, demoted: 4 }, { value: 0.41, model_version: "d15 weights v1 paper p1", kind: "general_theory" });
  assertStringIncludes(f, "entailment: 4 of 13 cited line(s) demoted");
  assertStringIncludes(f, "report credibility 0.41 (d15 weights v1 paper p1, kind general_theory)");
  assertStringIncludes(entailmentFooterLine({ lines: 9, demoted: 0 }, null), "entailment: 0 of 9 cited line(s) demoted");
});
