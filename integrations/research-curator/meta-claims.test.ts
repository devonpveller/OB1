/**
 * RED-first tests for the meta-claim filter (PLAN-research-trust Phase 3).
 *
 * The artefact (audit 2026-09-11): the OptiPlex run's synthesis opened with
 *   "[SOURCED] The provided sources contain no information specific to the Dell
 *    OptiPlex 3050 model … [Source 1..11]"
 * and the curator stored it as a grounded claim at confidence 0.85, together
 * with four "documented for the DGX Spark, NOT the OptiPlex" claims at 0.51 and
 * three more from the 100 Hz run. Eight statements ABOUT A RUN are sitting in
 * the claims table carrying the query's own vocabulary, where the next query on
 * the subject will recall them as known facts.
 *
 * The fixtures are the real rows, exported from the live DB on 2026-09-11.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyMetaClaim, isOmnibusCitation, parseSynthesisClaims, writeClaims,
  type WriteClaimsOpts,
} from "./claims.ts";

type ClaimFixture = { claims: Array<{ id: string; text: string; tag: string }> };
const fx = (n: string): ClaimFixture =>
  JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));

const POISON = fx("claims-poison").claims;
const WORLD = fx("claims-100hz-world").claims;

Deno.test("the deterministic layer rejects the source-referential poison", () => {
  const verdicts = POISON.map((c) => ({ id: c.id, v: classifyMetaClaim(c.text) }));
  const kept = verdicts.filter((x) => x.v !== "meta");
  assertEquals(kept, [], `these 8 poison claims were not caught: ${JSON.stringify(kept)}`);
});

Deno.test("the deterministic layer keeps every factual 100 Hz claim", () => {
  // The anchor says "the 13 factual 100 Hz claims". The run wrote 13 claims in
  // TOTAL and 3 of them are in claims-poison.json, so the number that must
  // survive is 10. See TEST-PLAN case 7.
  assertEquals(WORLD.length, 10);
  const dropped = WORLD.filter((c) => classifyMetaClaim(c.text) === "meta");
  assertEquals(dropped.map((c) => c.text.slice(0, 70)), [],
    "a factual claim was rejected as meta");
});

Deno.test("classifyMetaClaim: the shapes, not the eight strings", () => {
  assertEquals(classifyMetaClaim("The provided sources contain no information about X."), "meta");
  assertEquals(classifyMetaClaim("No source documents a recall campaign for the 3050."), "meta");
  assertEquals(classifyMetaClaim("This is NOT confirmed as a threshold for the OptiPlex."), "meta");
  assertEquals(classifyMetaClaim("Out-of-RAM errors pertain to the DGX Spark, not the OptiPlex."), "meta");
  assertEquals(classifyMetaClaim("The 0.2 Hz threshold (Source 3) concerns mechanical oscillation."), "meta");
  // World claims that merely MENTION studies or evidence must survive.
  assertEquals(classifyMetaClaim("The GVS study explicitly states its findings facilitate new countermeasures."), "world");
  assertEquals(classifyMetaClaim("An EEG study of 14 subjects found a shift toward 1-10 Hz power."), "world");
  assertEquals(classifyMetaClaim("The OptiPlex 3050 uses an LGA 1151 socket."), "world");
  assertEquals(classifyMetaClaim("Vestibular rehabilitation therapy uses personalised exercises."), "world");
});

/**
 * The five the TESTER found, 2026-09-11, by running the shipped classifier over
 * all 7 744 active claims and reading every match. Each is a standalone fact
 * with an honest epistemic TAIL, and the filter deleted the fact along with the
 * tail. Ids are live claim ids; the texts are the stored rows.
 *
 * The rule these force: the deterministic source-referential and
 * absence-of-evidence patterns are judged on the HEAD CLAUSE only — a caveat
 * after the first `;` / `, but` / `, though` describes the evidence, and every
 * real claim is entitled to one.
 */
const TESTER_WORLD_CLAIMS: Array<[string, string]> = [
  ["51254103-920b-4446-87e0-08babb5ad6ea",
    "If the company is dissolved, the applicant must wait six months after closure before " +
    "applying; submitting an SR01 before that six-month period has elapsed could constitute " +
    "a ground for rejection, though no source explicitly states this as a rejection criterion."],
  ["219dbaa6-c81c-4c29-b6e1-9991f55601c6",
    "The SR01 form requires specific information (title, full name, former business names, " +
    "date of birth, correspondence address, email, the address(es) to remove, and a new " +
    "service address unless the company is dissolved or the applicant no longer holds a " +
    "relevant position); failure to supply any of these could logically constitute a ground " +
    "for rejection, but no source explicitly confirms this."],
  ["c1e411e4-5035-4114-bd6a-2ca036595721",
    "A new registered office address must be in place before the home address can be removed " +
    "as a registered office address; attempting to remove the home address without first " +
    "establishing a replacement registered office could constitute a ground for rejection, " +
    "though no source explicitly frames this as a rejection ground."],
  ["d039348b-d38a-4fc5-a8e0-3e66c3f18e45",
    "The Conventional Commits type keywords (feat, fix, etc.) are used in commit messages, " +
    "not in branch names; the sources do not indicate that these same prefixes are applied " +
    "to branch names."],
  ["70f6a17c-1edb-4587-9624-41841e607679",
    "WSO2 API Manager appears to be an open-source API management platform that includes " +
    "monitoring and observability features, but the sources do not explicitly state its " +
    "license type or confirm it is \"open source\" in the SaaS API monitoring context."],
];

Deno.test("a world fact with an epistemic TAIL survives (the five the tester found)", () => {
  const eaten = TESTER_WORLD_CLAIMS
    .filter(([, text]) => classifyMetaClaim(text) === "meta")
    .map(([id]) => id);
  assertEquals(eaten, [], "the filter is still deleting world facts with a caveat tail");
});

Deno.test("the head clause is what is judged, and a tail alone never condemns a claim", () => {
  // Same tail, two different heads: only the one whose SUBJECT is the evidence
  // set is meta.
  assertEquals(
    classifyMetaClaim("The pump is rated to 12 bar; the sources do not state its duty cycle."),
    "world",
  );
  assertEquals(
    classifyMetaClaim("The sources do not state the pump's duty cycle; it is rated to 12 bar."),
    "meta",
  );
  assertEquals(
    classifyMetaClaim("Ticket prices rose 8% in 2025, but no source confirms the 2026 figure."),
    "world",
  );
});

Deno.test("B4: absence-of-EVIDENCE statements are meta even without the word 'source'", () => {
  for (const t of [
    "No evidence exists that a 100 Hz tone reduces motion sickness.",
    "There is no published research linking 100 Hz audio to vestibular suppression.",
    "Nothing in the reviewed material addresses the Dell OptiPlex 3050.",
    "The literature is silent on whether a 100 Hz tone affects the vestibular system.",
    "No information specific to the Dell OptiPlex 3050 was found.",
    "The retrieved pages were all about Dell the company rather than the OptiPlex 3050.",
    "This report could not find any OptiPlex 3050 failure data.",
    "No study has tested a 100 Hz tone against VR motion sickness.",
  ]) {
    assertEquals(classifyMetaClaim(t), "meta", t);
  }
});

// ── X1 (tester, attempt 2) ─────────────────────────────────────────────────
// `SOURCE_SUBJECT` is ^-anchored on the head clause, so a LEADING subordinate
// clause walked straight past it: attempt 1 caught this restatement of the 0.85
// poison and attempt 2 did not. The head sentence has more than one clause, and
// the subject of ANY of them can be the evidence set.
Deno.test("X1: a leading subordinate clause does not hide the subject", () => {
  for (const t of [
    "While the provided sources do not address the Dell OptiPlex 3050, they describe " +
    "the NVIDIA DGX Spark, the Compaq d220 and ASUS motherboards.",
    "Although the sources contain no information specific to the OptiPlex 3050, all of " +
    "them reference other platforms.",
    "Though no source mentions the OptiPlex 3050, several cover other Dell desktops.",
    "Whereas the retrieved pages cover the DGX Spark, none covers the machine asked about.",
  ]) {
    assertEquals(classifyMetaClaim(t), "meta", t.slice(0, 60));
  }
});

Deno.test("X1: a REASON clause about the sources is a justification, not a subject", () => {
  // Live claim `083b830e`, which the first version of the multi-clause rule ate.
  // "…, since the sources describe these as independent properties" justifies a
  // world claim; it is the same kind of tail as "…, but no source confirms it".
  assertEquals(
    classifyMetaClaim(
      "EFS's design implies a separation of concerns: the data-residency/privacy layer " +
      "(customer-controlled cloud infrastructure) is architecturally distinct from the " +
      "adversarial-prevention layer (safety classifiers and model-level safeguards), since " +
      "the sources describe these as independent properties of the system rather than one " +
      "enabling the other.",
    ),
    "world",
  );
  assertEquals(
    classifyMetaClaim("The pump is rated to 12 bar, because the sources give its test pressure."),
    "world",
  );
});

Deno.test("X1: a leading subordinate clause about the WORLD is still a world claim", () => {
  // The rule must read the clause's SUBJECT, not merely notice a subordinator.
  for (const t of [
    "While the pump is rated to 12 bar, the housing is rated to 8.",
    "Although the OptiPlex 3050 uses an LGA 1151 socket, the 3060 does not.",
    "Though semaglutide is approved for weight loss, it is not approved for gastroparesis.",
    "While the study enrolled thirty participants, only fourteen completed it.",
  ]) {
    assertEquals(classifyMetaClaim(t), "world", t.slice(0, 60));
  }
});

Deno.test("B4: absence in the WORLD is not absence of evidence", () => {
  for (const t of [
    "There is no evidence of tampering on the chassis.",
    "No evidence of corrosion was present on the connector pins.",
    "The technician found no sign of liquid damage.",
    "No study participants reported nausea after the intervention.",
    "There is no research budget allocated to the programme this year.",
  ]) {
    assertEquals(classifyMetaClaim(t), "world", t);
  }
});

Deno.test("attributing a statement to a NAMED party is not a transfer disclaimer", () => {
  // The three the second live sweep (2026-09-11, 7 744 active claims) turned up
  // after the head-clause rewrite. All three are ordinary attributions that the
  // transfer heuristic's "in" branch and optional "that" swallowed.
  for (const t of [
    "The article notes that in August 2026, several AI browsers were demonstrated " +
    "vulnerable to attacks, and while the cloud browser was not among them, it now " +
    "possesses the persistent-session ingredient that makes such attacks dangerous.",
    "The NYT's framing that \"AI companies simply need to pay fairly\" mirrors the broader " +
    "industry argument (as noted in CNN's coverage) that commercial AI operators must " +
    "license content or face legal damages rather than accessing it for free.",
    "OpenAI stated that for Astra specifically, it \"invested in unspecified new techniques " +
    "designed to make the model safer,\" meaning the exact techniques were not publicly detailed.",
  ]) {
    assertEquals(classifyMetaClaim(t), "world", t.slice(0, 60));
  }
  // …while the real transfer disclaimer still fires.
  assertEquals(
    classifyMetaClaim(
      "Thermal throttling and automatic shutdown at approximately 95 C is documented for " +
      "the NVIDIA DGX Spark under heavy AI workloads; this is NOT confirmed as a threshold " +
      "or behavior for the Dell OptiPlex 3050.",
    ),
    "meta",
  );
  assertEquals(
    classifyMetaClaim("The endpoint is documented for Python 3.12 and later."),
    "world",
    "a plain 'documented for X' with no contrast is an ordinary fact",
  );
});

Deno.test("world claims the FIRST version of these patterns wrongly ate", () => {
  // Both found by running the shipped classifier over all 7 744 active claims
  // on 2026-09-11 (findings sink section 3.7). A filter that deletes knowledge
  // when a sentence ends in an honest caveat is worse than the poison it removes.
  assertEquals(
    classifyMetaClaim(
      'The reference to "advertising controls in account settings" suggests the consent ' +
      "mechanism is embedded within the ChatGPT application's own settings interface " +
      "rather than being handled by a separate third-party CMP, though the exact UI " +
      "pattern (toggle, checkbox, modal) is not confirmed.",
    ),
    "world",
  );
  assertEquals(
    classifyMetaClaim(
      "Upon opening the Low-effort output, the author found no Sources sheet and no " +
      "Checks sheet, meaning the analysis could be followed but the assumptions' " +
      "provenance had to be traced manually.",
    ),
    "world",
  );
});

Deno.test("isOmnibusCitation: one line citing more than four sources is a smell", () => {
  assertEquals(isOmnibusCitation([1, 2, 3, 4]), false);
  assertEquals(isOmnibusCitation([1, 2, 3, 4, 5]), true);
  // The audited 0.85 claim cited all eleven.
  assertEquals(isOmnibusCitation([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), true);
});

Deno.test("an omnibus [SOURCED] line is parsed as UNCERTAIN and writes no 'states' edge", () => {
  const p = parseSynthesisClaims(
    "[SOURCED] All of them agree the socket is LGA 1151. [Source 1, 2, 3, 4, 5, 6]");
  assertEquals(p.claims.length, 1);
  assertEquals(p.claims[0].tag, "uncertain");
  assertEquals(p.claims[0].edges.some((e) => e.edgeType === "states"), false);
  assertEquals(p.claims[0].edges.length, 6);
});

Deno.test("a normal [SOURCED] line is untouched by the omnibus rule", () => {
  const p = parseSynthesisClaims("[SOURCED] The socket is LGA 1151. [Source 1, 2]");
  assertEquals(p.claims[0].tag, "sourced");
  assertEquals(p.claims[0].edges[0].edgeType, "states");
  assertEquals(p.claims[0].edges[1].edgeType, "corroborates");
});

// ── writeClaims: the gate, with a stub DB ───────────────────────────────────
function stubClient(written: string[]) {
  return {
    // deno-lint-ignore no-explicit-any
    queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }> {
      if (/find_or_create_claim/.test(sql)) {
        written.push(String((args || [])[0]));
        return Promise.resolve({ rows: [{ id: `c${written.length}`, was_duplicate: false }] as unknown as T[] });
      }
      return Promise.resolve({ rows: [] as T[] });
    },
  };
}
const opts = (extra: Partial<WriteClaimsOpts> = {}): WriteClaimsOpts => ({
  threadId: "t1", synthesisId: "s1",
  sourceIds: Array.from({ length: 12 }, (_, i) => `src${i + 1}`),
  ...extra,
});

Deno.test("writeClaims never persists a meta claim, and counts what it refused", async () => {
  const written: string[] = [];
  const synthesis = POISON.map((c) => `[SOURCED] ${c.text} [Source 1]`).join("\n") +
    "\n[SOURCED] The OptiPlex 3050 uses an LGA 1151 socket. [Source 2]";
  const res = await writeClaims(stubClient(written), synthesis, opts());
  assertEquals(res.metaSkipped, 8);
  assertEquals(written.length, 1);
  assert(written[0].includes("LGA 1151"), written[0]);
});

Deno.test("the LLM judge decides only what the patterns did not, and fails OPEN", async () => {
  const written: string[] = [];
  const asked: string[] = [];
  const synthesis = "[SOURCED] Something the patterns do not recognise at all. [Source 1]";
  const res = await writeClaims(stubClient(written), synthesis, opts({
    metaJudge: (text: string) => { asked.push(text); return Promise.reject(new Error("model down")); },
  }));
  assertEquals(asked.length, 1);
  assertEquals(res.metaSkipped, 0, "a judge failure must never drop a claim");
  assertEquals(written.length, 1);
});

Deno.test("the judge is not consulted for a claim the patterns already rejected", async () => {
  const written: string[] = [];
  const asked: string[] = [];
  const res = await writeClaims(stubClient(written),
    `[SOURCED] ${POISON[3].text} [Source 1]`,
    opts({ metaJudge: (t: string) => { asked.push(t); return Promise.resolve("WORLD" as const); } }));
  assertEquals(asked.length, 0);
  assertEquals(res.metaSkipped, 1);
  assertEquals(written.length, 0);
});

Deno.test("a judge verdict of META drops the claim", async () => {
  const written: string[] = [];
  const res = await writeClaims(stubClient(written),
    "[SOURCED] Something the patterns do not recognise at all. [Source 1]",
    opts({ metaJudge: () => Promise.resolve("META" as const) }));
  assertEquals(res.metaSkipped, 1);
  assertEquals(written.length, 0);
});
