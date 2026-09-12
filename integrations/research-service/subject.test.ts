/**
 * The subject is a SET of distinctive tokens (research-trust-core, attempt 2).
 *
 * This file REPLACES `entity.test.ts` and `entity-core.test.ts`, whose subject
 * was `entityCore()` — a single core phrase a page had to carry verbatim. That
 * idea is gone, and with it the length tiebreak and the QUALIFIERS list. Four
 * rules stood on it, each passing every subject somebody had written down and
 * failing on the first one nobody had:
 *
 *   1. eight pattern strings          (research-trust)
 *   2. a 7-character token length     (research-trust attempt 2)
 *   3. the token before the first digit   (research-trust-entity)
 *   4. the longest token              (research-trust-core attempt 1)
 *
 * The tester's counter-examples for the fourth, all live and all genuinely on
 * subject: "50 micrograms semaglutide" (core `50 micrograms`, share 0.00),
 * "Nikon Z 6III autofocus firmware" (core `6 iii`, 0.05 — and `6 iii` can never
 * match "Z6III" at all), "Mullvad WireGuard port forwarding" (core
 * `port forwarding`, 1.00 on router junk), "2026 budget" (`budget`),
 * "Raspberry Pi 5 NVMe HAT" (`5 nvme`).
 *
 * Every behavioural assertion those two files made is re-expressed here against
 * the set rule; none was dropped.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyHits, entityShare, entityStatusFor, hitCarriesSubject,
  subjectTokens, tokenSet, type SearchHit,
} from "./search-quality.ts";

type Fx = { query: string; entity: string; hits: SearchHit[] };
const fx = (n: string): Fx =>
  JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));
const hit = (title: string, snippet = ""): SearchHit => ({ url: "u", title, snippet });

// ── The token set: one spelling must match the other ────────────────────────
Deno.test("tokenSet offers a run, its parts, and the glued neighbours", () => {
  assert(tokenSet("Z6III Firmware").has("z6iii"));
  assert(tokenSet("Z6III Firmware").has("6iii"));
  assert(tokenSet("Z6III Firmware").has("z"));
  // …and the same subject written apart yields the glued form too.
  assert(tokenSet("Nikon Z 6III").has("z6iii"));
  assert(tokenSet("a pure tone at 100 Hz").has("100hz"));
  assert(tokenSet("100Hz sound therapy").has("100"));
  assert(tokenSet("100Hz sound therapy").has("hz"));
});

// ── The distinctive set, on every subject the anchor and the tester name ────
Deno.test("subjectTokens: digits, capitals, and anything uncommon", () => {
  const cases: Array<[string, string[]]> = [
    // Measured against the GENERAL word list (NLTK stopwords + unit names), not
    // one tuned to these subjects. A domain word the planner did not capitalise
    // - "audio", "motion", "port" - is distinctive now, which costs nothing: the
    // half rule raises the bar by half a token and gives one more way to clear
    // it, and every live set still scores 0.35 or better (findings H.3).
    ["100Hz audio VR motion sickness", ["100hz", "audio", "vr", "motion", "sickness"]],
    ["Dell OptiPlex 3050", ["dell", "optiplex", "3050"]],
    ["50 micrograms semaglutide", ["50", "semaglutide"]],
    ["Mullvad WireGuard port forwarding", ["mullvad", "wireguard", "port", "forwarding"]],
    ["Raspberry Pi 5 NVMe HAT", ["raspberry", "pi", "5", "nvme", "hat"]],
    ["Kubernetes CrashLoopBackOff", ["kubernetes", "crashloopbackoff"]],
    ["MacBook Air M2", ["macbook", "air", "m2"]],
    ["2026 Toyota Prius", ["toyota", "prius"]],
    ["Python 3.12 asyncio", ["python", "312", "asyncio"]],
    ["100 Hz", ["100", "hz"]],
  ];
  for (const [e, want] of cases) assertEquals(subjectTokens(e), want, e);
});

Deno.test("subjectTokens: a bare YEAR dates a subject, it does not name one", () => {
  // CHANGED by the general word list: "budget" is not an NLTK stopword, so
  // "2026 budget" names something and is USED rather than rejected. Its live set
  // is genuinely about budgets and scores 0.75. The earlier rejection came from
  // a word list tuned after the fact (findings H.3).
  assertEquals(subjectTokens("2026 budget"), ["budget"]);
  assertEquals(subjectTokens("2026 Toyota Prius"), ["toyota", "prius"]);
  // A number that is not a plausible year is a model, and stays.
  assertEquals(subjectTokens("OptiPlex 3050"), ["optiplex", "3050"]);
});

Deno.test("subjectTokens keeps a one-letter model designator the planner capitalised", () => {
  assertEquals(subjectTokens("Nikon Z 6III autofocus firmware"),
    ["nikon", "z", "6iii", "autofocus", "firmware"]);
});

// ── The half rule ───────────────────────────────────────────────────────────
Deno.test("a hit carries the subject at half its tokens, rounded up", () => {
  const s = subjectTokens("Dell OptiPlex 3050");            // 3 tokens -> needs 2
  assert(hitCarriesSubject(hit("OptiPlex 3050 Owner's Manual"), s), "2 of 3");
  assert(hitCarriesSubject(hit("Dell OptiPlex 3050 SFF"), s), "3 of 3");
  assert(!hitCarriesSubject(hit("Computers, Monitors & Technology | Dell USA"), s), "1 of 3");
  assert(!hitCarriesSubject(hit("Capacitor - Wikipedia"), s), "0 of 3");
});

Deno.test("a BARE NUMBER never carries a subject on its own", () => {
  // "100 Hz" is two tokens and half of two is one. Every hit in the recorded
  // the100 fixture carries "100" - The 100, the TV series - which is the
  // failure this module exists for.
  const s = subjectTokens("100 Hz");
  assert(!hitCarriesSubject(hit("The 100 (TV series) - Wikipedia"), s));
  assert(hitCarriesSubject(hit("Exposure to a pure tone at 100 Hz"), s));
  // …unless the subject is nothing but numbers, when there is nothing else to ask for.
  assert(hitCarriesSubject(hit("Boeing 737 MAX"), subjectTokens("737")));
});

Deno.test("the tester's five subjects, on their own live hit sets", () => {
  for (const [name, expectOk] of [
    ["live-semaglutide50", true], ["live-nikonz6iii", true],
    ["live-mullvad", true], ["live-rpi5nvme", true],
  ] as Array<[string, boolean]>) {
    const f = fx(name);
    const v = classifyHits(f.query, f.hits, f.entity);
    assertEquals(v.verdict === "ok", expectOk,
      `${name} -> ${v.verdict} at ${v.entityShare} (status ${v.entityStatus})`);
    assert((v.entityShare ?? 0) >= 0.3, `${name} share ${v.entityShare}`);
  }
});

Deno.test("a subject that names nothing is REJECTED, not guessed at", () => {
  // An EMPTY subject, and a subject the query is not about, are both refused
  // and both counted. ("2026 budget" is no longer empty - see the year test.)
  assertEquals(entityStatusFor("anything at all", ""), "missing");
  assertEquals(entityStatusFor("anything at all", "   "), "missing");
  assertEquals(entityStatusFor("Dell OptiPlex 3050 thermal", "Nikon Z 6III"), "rejected");
  const junk: SearchHit[] = Array.from({ length: 10 }, (_, i) => ({
    url: `u${i}`, title: "Unrelated page", snippet: "nothing",
  }));
  const v = classifyHits("Dell OptiPlex 3050 thermal", junk, "Nikon Z 6III");
  assertEquals(v.entityStatus, "rejected");
  assertEquals(v.entityShare, undefined, "a rejected subject is not scored");
});

// ── Regressions: everything the replaced files asserted ─────────────────────
// Per fixture, so a failure names the SET rather than a loop index.
const COLLAPSE_SETS: Array<[string, string]> = [
  ["search-collapsed-dell", "Dell OptiPlex 3050"],
  ["search-collapsed-most", "Dell OptiPlex 3050"],
  ["search-collapsed-the100", "100 Hz"],
  ["probe-collapsed-capacitor", "OptiPlex 3050"],
  ["probe-collapsed-motherboard", "OptiPlex 3050"],
  ["probe-collapsed-vestibular", "100 Hz"],
];
for (const [name, entity] of COLLAPSE_SETS) {
  Deno.test(`REGRESSION collapse: ${name}`, () => {
    const f = fx(name);
    const v = classifyHits(f.query, f.hits, entity);
    assert(v.verdict !== "ok", `${name} -> ${v.verdict} at ${v.entityShare}`);
    assertEquals(v.entityShare, 0, name);
  });
}

const GOOD_SETS: Array<[string, string]> = [
  ["probe-good-oomkilled", "OOMKilled"],
  ["probe-good-iphone", "iPhone 18 Pro"],
  ["search-good-optiplex", "Dell OptiPlex 3050"],
  ["live-optiplex-health", "Dell OptiPlex 3050"],
  ["live-optiplex-thermal", "Dell OptiPlex 3050"],
  ["live-100hz-mechanism", "100Hz audio VR motion sickness"],
  ["live-100hz-studies", "100Hz audio VR motion sickness"],
  ["live-prius", "2026 Toyota Prius"],
  ["live-python312", "Python 3.12 asyncio"],
  ["live-crashloop", "Kubernetes CrashLoopBackOff"],
  ["live-semaglutide50", "50 micrograms semaglutide"],
  ["live-nikonz6iii", "Nikon Z 6III autofocus firmware"],
  ["live-mullvad", "Mullvad WireGuard port forwarding"],
  ["live-rpi5nvme", "Raspberry Pi 5 NVMe HAT"],
];
for (const [name, entity] of GOOD_SETS) {
  Deno.test(`REGRESSION ok: ${name}`, () => {
    const f = fx(name);
    const v = classifyHits(f.query, f.hits, entity);
    assertEquals(v.verdict, "ok", `${name} -> ${v.verdict} at ${v.entityShare}`);
    // The floor costs share on sets whose pages name the subject and little
    // else: live-semaglutide50 measures 0.35 (findings H.3). Still twice the line.
    assert((v.entityShare ?? 0) >= 0.3, `${name} share ${v.entityShare}`);
  });
}

Deno.test("REGRESSION: the failing dry run's own subject passes its own hit set", () => {
  const f = fx("live-100hz-mechanism");
  const v = classifyHits(f.query, f.hits, "100Hz audio VR motion sickness");
  assertEquals(v.verdict, "ok");
  assert((v.entityShare ?? 0) >= 0.4, `share ${v.entityShare}`);
  assert(f.hits.some((h) => /pmc11955832|jstage|1-min exposure to a pure tone/i.test(
    `${h.url} ${h.title}`)), "the Nagoya paper must be in the recorded set");
});

Deno.test("REGRESSION: a page that omits the brand still carries the subject", () => {
  assert(hitCarriesSubject(hit("ThinkCentre M910q Tiny teardown"),
    subjectTokens("Lenovo ThinkCentre M910q")));
  assert(hitCarriesSubject(hit("EliteDesk 800 G4 Mini review"),
    subjectTokens("HP EliteDesk 800 G4")));
  assert(hitCarriesSubject(hit("OptiPlex 3050 SFF owner's manual"),
    subjectTokens("Dell OptiPlex 3050")));
});

Deno.test("REGRESSION: an unrelated product does not carry the subject", () => {
  // The M.2 case the previous item guarded: "MacBook Air M2" must not be
  // satisfied by an SSD form factor.
  assert(!hitCarriesSubject(
    hit("All My Dell Optiplex 3050 SFF M.2 SSD Slots overheat"),
    subjectTokens("Apple MacBook Air M2")));
  assert(!hitCarriesSubject(hit("ThinkCentre M920q review"),
    subjectTokens("Lenovo ThinkCentre M910q")));
  assert(!hitCarriesSubject(hit("Best Buy Deals"), subjectTokens("OptiPlex 3050")));
});

/**
 * DECLARED COST of the set rule, measured rather than hidden. A sibling model
 * now carries the subject: "OptiPlex 3060" holds 2 of {dell, optiplex, 3050}.
 * The previous phrase rule refused it, and that refusal is what produced four
 * successive false search failures. This detector answers "did the engine
 * understand the SUBJECT", and a page about a neighbouring OptiPlex is evidence
 * that it did; deciding whether that page answers the NEED is the relevance
 * gate's job, one page at a time.
 */
Deno.test("DECLARED: a sibling model counts as carrying the subject", () => {
  assert(hitCarriesSubject(hit("DELL OPTIPLEX 3060 AMBER LIGHT BLINKING"),
    subjectTokens("Dell OptiPlex 3050")));
  // The junk that motivated the module is still refused, which is the line that
  // matters: Dell's own home page carries only "dell".
  assert(!hitCarriesSubject(hit("Computers, Monitors & Technology Solutions | Dell USA"),
    subjectTokens("Dell OptiPlex 3050")));
});

// ── The display form ────────────────────────────────────────────────────────
Deno.test("entityShare is the fraction of hits carrying the subject", () => {
  const s = subjectTokens("OptiPlex 3050");
  const hits = [hit("OptiPlex 3050 manual"), hit("OptiPlex 3050 teardown"),
                hit("Best Buy Deals"), hit("Capacitor - Wikipedia")];
  assertEquals(entityShare(s, hits), 0.5);
  assertEquals(entityShare([], hits), 0);
});

// ── The T7 candidates attempt 1 LISTED but never pinned ─────────────────────
// The tester's second finding: naming candidates in a plan without pinning them
// lets a skipped optional half read as clean. Each is asserted here with the
// set the rule produces and a judgement of whether that set names the thing.
Deno.test("T7 candidate: a model number that comes FIRST", () => {
  assertEquals(subjectTokens("3050 OptiPlex thermal"), ["3050", "optiplex", "thermal"]);
  assert(hitCarriesSubject(hit("OptiPlex 3050 thermal design"), subjectTokens("3050 OptiPlex thermal")));
  // Order is irrelevant to a set, which is the point: the fourth rule failed
  // precisely because it depended on where the number sat.
  assertEquals(subjectTokens("3050 OptiPlex"), subjectTokens("OptiPlex 3050").slice().reverse());
});

Deno.test("T7 candidate: a unit longer than four characters", () => {
  // "hertz" and "micrograms" are unit words and common; the number and the
  // substance carry the subject.
  assertEquals(subjectTokens("100 hertz tone"), ["100", "hertz", "tone"]);
  assert(hitCarriesSubject(hit("A pure tone at 100 hertz"), subjectTokens("100 hertz tone")));
  assertEquals(subjectTokens("50 micrograms semaglutide"), ["50", "semaglutide"]);
});

Deno.test("T7 candidate: a three-part version", () => {
  // "17.2.1" glues into one token, so a page writing it exactly matches, and a
  // page writing "Postgres 17" carries the product name half.
  // A three-part version glues to one token. A single global replace left
  // "172.1", because the two dot-matches overlap on the digit between them.
  assertEquals(subjectTokens("Postgres 17.2.1 logical replication"),
    ["postgres", "1721", "logical", "replication"]);
  assert(hitCarriesSubject(
    hit("Postgres 17.2.1 logical replication changes"),
    subjectTokens("Postgres 17.2.1 logical replication")));
  assert(!hitCarriesSubject(hit("MySQL 8 replication"),
    subjectTokens("Postgres 17.2.1 logical replication")));
});

Deno.test("T7 candidate: two named things in one subject", () => {
  const s = subjectTokens("OptiPlex 3050 versus ThinkCentre M910q");
  assertEquals(s, ["optiplex", "3050", "versus", "thinkcentre", "m910q"]);
  // A comparison page carrying either machine plus the comparison word passes;
  // a page about neither does not.
  assert(hitCarriesSubject(
    hit("OptiPlex 3050 versus ThinkCentre M910q: which mini PC"), s));
  assert(!hitCarriesSubject(hit("Best Buy Deals on laptops"), s));
});

Deno.test("T7 candidate: a hyphen-heavy subject", () => {
  assertEquals(subjectTokens("e-bike 750 W hub motor"), ["e", "bike", "750", "w", "hub", "motor"]);
  assert(hitCarriesSubject(hit("750 W hub motor for an e-bike"),
    subjectTokens("e-bike 750 W hub motor")));
});

// ── The entity is still bounded and the fallback still counted ─────────────
Deno.test("entityStatusFor: used, missing, rejected", () => {
  assertEquals(entityStatusFor("Dell OptiPlex 3050 thermal problems", "Dell OptiPlex 3050"), "used");
  assertEquals(entityStatusFor("anything at all", ""), "missing");
  assertEquals(entityStatusFor("anything at all", "   "), "missing");
  // A subject the query is not about is refused rather than trusted.
  assertEquals(entityStatusFor("Dell OptiPlex 3050 thermal", "Nikon Z 6III"), "rejected");
  // …and a subject that names nothing is refused too.
  assertEquals(entityStatusFor("something else entirely", "2026 budget"), "rejected");
});

Deno.test("entityStatusFor accepts a query carrying half the subject", () => {
  // A DEEPEN query need not repeat every word of the subject.
  assertEquals(entityStatusFor("OptiPlex 3050 thermal throttling", "Dell OptiPlex 3050"), "used");
  assertEquals(entityStatusFor("100Hz audio VR motion sickness mechanism",
    "100Hz audio VR motion sickness"), "used");
});
