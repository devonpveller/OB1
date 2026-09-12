/**
 * meta-judge-prompt.test.ts — the LLM judge's PROMPT, held to its own examples.
 *
 * The deterministic filter (`classifyMetaClaim`) has been measured against 7 744
 * live claims. The judge behind it never had a test at all, and it is the half
 * that has been losing facts: across the two live OWUI runs on the deployed
 * stack it refused FOUR claims, and three of them were about the world.
 *
 *   33250e9b  "The same used-purchase analysis RECOMMENDS the Dell OptiPlex
 *              3060 ... as a better secondhand option"          - attribution
 *   64ac38cf  "The OptiPlex 3050 SFF's proprietary PSU connector MAY also limit
 *              ... IF the original 180 W unit is failing"       - hedge
 *   64ac38cf  "The user in that thread SPECULATED that the CPU may have been
 *              damaged during the thermal-paste service"        - attribution + hedge
 *
 * The fourth, "Whether the 'Solved!' tag ... is unclear, as no solution text is
 * visible in the provided source content", is a genuine META question and the
 * findings say so - so it must STAY refused. A test that turned all four into
 * WORLD would be fixing the number rather than the defect.
 *
 * HOW THIS TESTS A PROMPT. The judge is a model; mocking it with my own opinion
 * would test nothing. So the mock reads the PROMPT: it extracts the attribution
 * verbs, the hedge markers and the META phrases from the prompt's own example
 * lines and classifies by those alone. If someone deletes the examples, the mock
 * cannot tell these sentences apart and the test fails - which is the property
 * worth pinning, because the prompt is the whole of the instruction the real
 * judge gets.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyMetaClaim, headClause, META_JUDGE_SYS } from "./claims.ts";

type ClaimFixture = { claims: Array<{ id: string; text: string; tag: string }> };
const fx = (n: string): ClaimFixture =>
  JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));

// ── A judge that knows only what the prompt says ───────────────────────────

/** Verbs the prompt's ATTRIBUTED example names, taken from the prompt. */
function attributionVerbs(prompt: string): string[] {
  const line = prompt.split("\n").find((l) => /ATTRIBUTED:/.test(l)) ?? "";
  const inside = line.match(/<source or user>\s*([^"<]*?)\s*<content>/);
  return (inside?.[1] ?? "").split("/").map((v) => v.trim()).filter(Boolean);
}

/** Hedge markers the prompt's HEDGED example names, taken from the prompt. */
function hedgeMarkers(prompt: string): string[] {
  const line = prompt.split("\n").find((l) => /HEDGED:/.test(l)) ?? "";
  const out = new Set<string>();
  for (const quoted of line.match(/"[^"]+"/g) ?? []) {
    for (const w of ["may", "likely", "reported"]) {
      if (quoted.toLowerCase().includes(w)) out.add(w);
    }
  }
  return [...out];
}

/** The META example sentences, taken from the prompt's own bullet list. */
function metaExamples(prompt: string): string[] {
  const metaHalf = prompt.split("META =")[1] ?? "";
  return (metaHalf.split("\n")
    .filter((l) => /^\s+- "/.test(l))
    .map((l) => (l.match(/"([^"]+)"/)?.[1] ?? "").toLowerCase())
    .filter(Boolean));
}

/**
 * Classify using ONLY what the prompt states. The precedence is the prompt's
 * own last rule: "When a sentence carries both a fact and a caveat about the
 * evidence, judge the FACT."
 */
function promptFaithfulJudge(prompt: string, text: string): "WORLD" | "META" {
  const t = text.toLowerCase();
  const verbs = attributionVerbs(prompt);
  const hedges = hedgeMarkers(prompt);
  assert(verbs.length >= 3, "the prompt names no attribution verbs");
  assert(hedges.length >= 2, "the prompt names no hedge markers");

  const attributed = verbs.some((v) => new RegExp(`\\b${v}\\b`).test(t));
  const hedged = hedges.some((h) => new RegExp(`\\b${h}\\b`).test(t));

  // A META example matches when the sentence shares two or more of its words -
  // the same "one is a coincidence" floor the rest of this engine uses. Word
  // overlap rather than substring, because the examples are templates ("A",
  // "Y") and the sentences are real.
  // Articles and conjunctions are not topic words: "the" shared between a
  // sentence and an example says nothing, and counting it made "…the thread was
  // marked \"Solved!\"" look like the prompt's example about a Solved tag.
  const FUNCTION_WORDS = new Set(
    ["the", "and", "for", "that", "this", "these", "those", "was", "were", "are",
     "with", "from", "its", "has", "had", "have", "its", "but", "any", "all"]);
  const words = (x: string) =>
    new Set((x.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []).filter((w) => !FUNCTION_WORDS.has(w)));
  const tw = words(t);
  const examples = metaExamples(prompt);
  const metaish = (target: Set<string>) =>
    examples.some((ex) => {
      let shared = 0;
      for (const w of words(ex)) if (target.has(w)) shared++;
      return shared >= 2;
    });

  // The prompt's own precedence, and it is READ FROM THE SENTENCE the way the
  // module already reads one: `headClause` is what the deterministic filter
  // uses to separate a claim from its caveat tail.
  //   1. the MAIN CLAUSE is about the evidence -> META, "however many
  //      world-sounding words it contains". The poison claim "…errors REPORTED
  //      alongside thermal issues PERTAIN TO the DGX Spark, NOT the OptiPlex"
  //      is exactly that: a hedge word inside a sentence about the source set.
  //   2. otherwise an attributed or hedged claim is a claim -> WORLD, and its
  //      caveat tail ("…, though no source confirms…") does not change that.
  //   3. otherwise fall back to the whole sentence.
  if (metaish(words(headClause(text)))) return "META";
  if (attributed || hedged) return "WORLD";   // the fact, not the caveat
  return metaish(tw) ? "META" : "WORLD";
}

// ── The four the judge refused ─────────────────────────────────────────────

const REFUSED_WORLD = [
  // 33250e9b, attribution phrasing
  "The same used-purchase analysis recommends the Dell OptiPlex 3060 (8th-gen Intel) as a " +
  "better secondhand option for Windows 11 compatibility, noting it is typically available " +
  "for under $200, while the 3050 is positioned as a Linux-oriented budget option.",
  // 64ac38cf, hedge + an honest caveat about the evidence
  "The OptiPlex 3050 SFF's proprietary PSU connector may also limit the ability to replace " +
  "the PSU with a higher-wattage Dell unit if the original 180 W unit is failing, though no " +
  "source explicitly confirms whether Dell sells a direct-replacement 180 W SFF PSU separately.",
  // 64ac38cf, attribution + hedge
  "The user in that thread speculated that the CPU may have been damaged during the " +
  'thermal-paste service, and the thread was marked "Solved!" but contained no posted solution.',
];

const REFUSED_META =
  'Whether the "Solved!" tag on the DIMM-slot-2-only forum thread (Source 17) indicates the ' +
  "issue was ultimately resolved by a specific fix (e.g., reseating the CPU, replacing the " +
  "motherboard) is unclear, as no solution text is visible in the provided source content.";

Deno.test("ACCEPTANCE 5: the three attributed/hedged world claims classify WORLD", () => {
  for (const text of REFUSED_WORLD) {
    assertEquals(promptFaithfulJudge(META_JUDGE_SYS, text), "WORLD", text.slice(0, 80));
    // …and the deterministic layer, which never fired on them, still does not.
    assertEquals(classifyMetaClaim(text), "world", text.slice(0, 80));
  }
});

Deno.test("ACCEPTANCE 5: the fourth refusal was right, and stays META", () => {
  // The findings call this one "a genuine meta question". Turning all four into
  // WORLD would be fixing the count, not the defect.
  assertEquals(promptFaithfulJudge(META_JUDGE_SYS, REFUSED_META), "META");
});

Deno.test("ACCEPTANCE 5: the eight poison claims still classify META", () => {
  const poison = fx("claims-poison").claims;
  assertEquals(poison.length, 8);
  for (const c of poison) {
    // The deterministic layer catches all eight before the judge is ever asked;
    // this is the belt, and the line below is the braces.
    assertEquals(classifyMetaClaim(c.text), "meta", c.text.slice(0, 70));
  }
  // …and a judge reading only the prompt refuses the ones whose shape the
  // prompt's META examples actually name. The others are not the judge's job:
  // it is asked ONLY about claims the deterministic layer did not recognise,
  // and the layer above recognises all eight. Asserting that a prompt-reading
  // mock also catches, say, "(Source 3) concern mechanical oscillation
  // frequencies, not audio" would be asserting that the prompt enumerates every
  // poison sentence, which is the pattern-list mistake four items in this
  // workstream have already made.
  const bySubject = poison.filter((c) =>
    /provided sources contain|not confirmed|pertain to/i.test(c.text));
  assert(bySubject.length >= 3, "the poison fixture changed shape");
  for (const c of bySubject) {
    assertEquals(promptFaithfulJudge(META_JUDGE_SYS, c.text), "META", c.text.slice(0, 70));
  }
});

Deno.test("the prompt actually carries the two shapes, in its own words", () => {
  // The mock above is only as good as what it can find in the prompt. These
  // assertions are what make a deleted example fail loudly rather than quietly.
  assert(/ATTRIBUTED:/.test(META_JUDGE_SYS), "the attributed-claim example is gone");
  assert(/HEDGED:/.test(META_JUDGE_SYS), "the hedged-claim example is gone");
  assert(META_JUDGE_SYS.includes("recommends"), "the recommending-source verb is gone");
  assert(META_JUDGE_SYS.includes("speculates"), "the speculating-user verb is gone");
  assert(/may <effect> if <condition>/.test(META_JUDGE_SYS), "the hedge template is gone");
  assert(/judge the FACT/.test(META_JUDGE_SYS), "the fact-over-caveat rule is gone");
  // …and the META side still names what it always named.
  for (const phrase of ["contain no information", "not confirmed", "no source documents", "pertain to"]) {
    assert(META_JUDGE_SYS.includes(phrase), `the META example "${phrase}" is gone`);
  }
});
