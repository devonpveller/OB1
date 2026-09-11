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
