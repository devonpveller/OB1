/**
 * RED-first tests for reducing a TOPIC to the NAME inside it
 * (harness item research-trust-core, 2026-09-11).
 *
 * The artefact: live dry run 6975d982, recorded at
 * `documentation/evidence/research-trust-core/dryrun-6975d982.json`. KEYWORDIZE
 * returned the subject `"100Hz audio VR motion sickness"` — five words, where
 * its own examples are "OptiPlex 3050" and "semaglutide". `entityCore` anchors
 * on the token BEFORE the first digit-bearing token; here the digit token is
 * first, so nothing was dropped and the core became all six tokens — a phrase
 * no page carries. Share 0.00 on a hit set where "100 Hz" is in 9 of 20 hits
 * and PMC11955832 is hit #1; `collapsed onto "motion"` three times;
 * `search_degraded`; nothing fetched.
 *
 * The previous rule is right for a NAME and wrong for a TOPIC handed to it as
 * if it were one. Nothing bounded the entity's length, and `entityStatusFor`
 * only checked that the query contained it.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyHits, entityCore, entityShare, shortenEntity, type SearchHit,
} from "./search-quality.ts";

type Fx = { query: string; entity: string; hits: SearchHit[] };
const fx = (n: string): Fx =>
  JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));

// ── ACCEPTANCE 1: the subject that failed in production ─────────────────────
Deno.test("ACCEPTANCE 1: the five-word subject reduces to the name inside it", () => {
  assertEquals(entityCore("100Hz audio VR motion sickness"), ["100", "hz"]);
});

Deno.test("ACCEPTANCE 1: and the recorded hit set then satisfies it at >= 0.4", () => {
  const f = fx("live-100hz-mechanism");
  const share = entityShare(entityCore("100Hz audio VR motion sickness"), f.hits);
  assert(share >= 0.4, `share ${share}`);
  const v = classifyHits(f.query, f.hits, "100Hz audio VR motion sickness");
  assertEquals(v.verdict, "ok", `${v.verdict} at share ${v.entityShare}`);
  // The paper the run was sent to find is in the set it threw away.
  assert(f.hits.some((h) => /pmc11955832|jstage|1-min exposure to a pure tone/i.test(
    `${h.url} ${h.title}`)), "the Nagoya paper must be in the recorded set");
});

Deno.test("ACCEPTANCE 1: all three of that run's queries classify ok", () => {
  for (const name of ["live-100hz-mechanism", "live-100hz-studies"]) {
    const f = fx(name);
    assertEquals(classifyHits(f.query, f.hits, "100Hz audio VR motion sickness").verdict,
      "ok", name);
  }
  // The third query really is off-need (it asks about SSQ scores) and stays a
  // search failure. That is correct, not a regression — findings E.8.
  const ssq = fx("live-100hz-ssq");
  assert(classifyHits(ssq.query, ssq.hits, "100Hz audio VR motion sickness").verdict !== "ok");
});

// ── ACCEPTANCE 2: the rule, on the five subjects the anchor names ───────────
// Each expected core is measured against a real hit set below, not asserted.
Deno.test("ACCEPTANCE 2: the five named subjects reduce as the rule says", () => {
  assertEquals(entityCore("100Hz audio VR motion sickness"), ["100", "hz"]);
  assertEquals(entityCore("2026 Toyota Prius"), ["toyota", "prius"]);
  assertEquals(entityCore("Python 3.12 asyncio"), ["python", "3", "12"]);
  assertEquals(entityCore("Dell OptiPlex 3050 used purchase"), ["optiplex", "3050"]);
  assertEquals(entityCore("Kubernetes CrashLoopBackOff"), ["kubernetes", "crashloopbackoff"]);
});

Deno.test("ACCEPTANCE 2: a bare YEAR is not the name - measured, not assumed", () => {
  // Live set for "2026 Toyota Prius fuel economy":
  //   toyota prius       0.95   <- the name
  //   2026 toyota prius  0.80
  //   2026 prius         0.20
  // Publishers write the model, and only sometimes the year.
  const f = fx("live-prius");
  const core = entityCore("2026 Toyota Prius");
  assertEquals(core, ["toyota", "prius"]);
  const share = entityShare(core, f.hits);
  assert(share >= 0.9, `share ${share}`);
  assert(share > entityShare(["2026", "toyota", "prius"], f.hits),
    "dropping the year must not cost share");
  assertEquals(classifyHits(f.query, f.hits, "2026 Toyota Prius").verdict, "ok");
});

Deno.test("ACCEPTANCE 2: a VERSION number keeps its language - and is the thinnest name", () => {
  // Live set for "Python 3.12 asyncio TaskGroup":
  //   python 3 12        0.35   <- the name; thin, and above the 0.175 line
  //   3 12               0.55   (would match any 3.12 anywhere)
  //   python 3 12 asyncio 0.05  (the whole subject: a topic, not a name)
  const f = fx("live-python312");
  const core = entityCore("Python 3.12 asyncio");
  assertEquals(core, ["python", "3", "12"]);
  const share = entityShare(core, f.hits);
  assert(share >= 0.3, `share ${share}`);
  assert(share > entityShare(["python", "3", "12", "asyncio"], f.hits));
  assertEquals(classifyHits(f.query, f.hits, "Python 3.12 asyncio").verdict, "ok");
});

Deno.test("ACCEPTANCE 2: a two-word technical name keeps both words", () => {
  // Live set for "Kubernetes CrashLoopBackOff diagnose":
  //   crashloopbackoff            1.00
  //   kubernetes crashloopbackoff 0.40   <- what the rule yields; passes
  // The rule's job is to pass a good set, not to maximise the share.
  const f = fx("live-crashloop");
  const core = entityCore("Kubernetes CrashLoopBackOff");
  assertEquals(core, ["kubernetes", "crashloopbackoff"]);
  assert(entityShare(core, f.hits) >= 0.3);
  assertEquals(classifyHits(f.query, f.hits, "Kubernetes CrashLoopBackOff").verdict, "ok");
});

Deno.test("ACCEPTANCE 2: a product subject with trailing intent keeps the model", () => {
  const f = fx("live-optiplex-thermal");
  assertEquals(entityCore("Dell OptiPlex 3050 used purchase"), ["optiplex", "3050"]);
  assertEquals(classifyHits(f.query, f.hits, "Dell OptiPlex 3050 used purchase").verdict, "ok");
});

// ── The window rule's own edges ─────────────────────────────────────────────
Deno.test("a token typed as ONE word is never split across the window boundary", () => {
  // "M910q" is one run; splitting it for MATCHING must not split it for NAMING.
  assertEquals(entityCore("Lenovo ThinkCentre M910q"), ["thinkcentre", "m", "910", "q"]);
  assertEquals(entityCore("100Hz"), ["100", "hz"]);
});

Deno.test("the window is bounded, and the bound is in WORDS not tokens", () => {
  // The cap counts runs - words as they were typed. "EliteDesk 800 G4" is three
  // words and five tokens; cutting it at three TOKENS would drop the "G4" and
  // let a different variant satisfy it. So the observable token bound is 4, not
  // 3, and only for an entity whose words split.
  const cases: Array<[string, number]> = [
    ["100Hz audio VR motion sickness", 2],
    ["Dell OptiPlex 3050 used purchase", 2],
    ["Python 3.12 asyncio", 3],
    ["2026 Toyota Prius", 2],
    ["the best 2026 Toyota Prius hybrid review", 3],  // "toyota prius hybrid" - a trim word the QUALIFIERS list does not carry
    ["how to diagnose Kubernetes CrashLoopBackOff in production", 2],
    ["HP EliteDesk 800 G4", 4],
    ["Lenovo ThinkCentre M910q", 4],
  ];
  for (const [e, n] of cases) {
    assertEquals(entityCore(e).length, n, `${e} -> ${JSON.stringify(entityCore(e))}`);
  }
});

Deno.test("a subject with no digits and no long word is left alone", () => {
  assert(entityCore("VR").length > 0);
  assertEquals(entityCore(""), []);
});

// ── ACCEPTANCE 3: the entity is bounded at extraction, and the cut is counted ─
Deno.test("ACCEPTANCE 3: a five-word subject is shortened to the name inside it", () => {
  assertEquals(shortenEntity("100Hz audio VR motion sickness"), "100Hz");
  assertEquals(shortenEntity("Dell OptiPlex 3050 used purchase"), "OptiPlex 3050");
  assertEquals(shortenEntity("the best 2026 Toyota Prius hybrid review"), "Toyota Prius hybrid");
});

Deno.test("ACCEPTANCE 3: shortening keeps the CALLER's spelling", () => {
  // The log line and the footer name what was searched on; "Python 3 12" would
  // be a different string from anything the planner or a page ever wrote.
  assertEquals(shortenEntity("Python 3.12 asyncio"), "Python 3.12");
  assertEquals(shortenEntity("100Hz audio"), "100Hz");
});

Deno.test("ACCEPTANCE 3: a subject that IS a name is returned unchanged", () => {
  // The caller compares identity to decide whether to count a correction, so an
  // untouched name must come back byte-identical.
  for (const e of ["OptiPlex 3050", "semaglutide", "Kubernetes CrashLoopBackOff", "100 Hz", ""]) {
    assertEquals(shortenEntity(e), e);
  }
});
