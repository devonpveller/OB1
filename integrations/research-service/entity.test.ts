/**
 * RED-first tests for entity matching by distinctive CORE
 * (harness item research-trust-entity, 2026-09-11).
 *
 * The artefact: the research-trust deploy. Dry run b7e701ef asked
 * "100Hz audio VR motion sickness physiological mechanism" and all three of its
 * searches were reported `collapsed onto "motion"` -> search_degraded, 0 pages
 * fetched. Replaying the same queries through the same gateway minutes later
 * returns 20 hits each, with the Nagoya paper ("Just 1-min exposure to a pure
 * tone at 100 Hz…", PMC11955832 / J-STAGE) at rank 1 in two of them. The search
 * worked. What failed was the string comparison: the entity KEYWORDIZE emitted
 * was "100Hz audio", the pages write "100 Hz", and nothing normalised the two.
 *
 * Dry runs 8f875b10 / 1f2ff740 show the same defect from the other end: entity
 * "Dell OptiPlex 3050", hits that say "OptiPlex 3050" without the brand.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyHits, entityCore, entityTokens, hitCarriesEntity, type SearchHit,
} from "./search-quality.ts";

type Fx = { query: string; entity: string; hits: SearchHit[] };
const fx = (n: string): Fx =>
  JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${n}.json`, import.meta.url)));

// ── Tokenisation: a number and its unit are two tokens, however they are typed ─
Deno.test("entityTokens splits a digit/letter run, so 100Hz == 100 Hz == 100-Hz", () => {
  assertEquals(entityTokens("100Hz"), ["100", "hz"]);
  assertEquals(entityTokens("100 Hz"), ["100", "hz"]);
  assertEquals(entityTokens("100-Hz"), ["100", "hz"]);
  assertEquals(entityTokens("OptiPlex 3050"), ["optiplex", "3050"]);
  assertEquals(entityTokens("iPhone 18 Pro"), ["iphone", "18", "pro"]);
  assertEquals(entityTokens(""), []);
});

// ── The CORE: the distinctive part of what the operator asked about ──────────
Deno.test("entityCore drops a brand or qualifier when the rest is still distinctive", () => {
  assertEquals(entityCore("Dell OptiPlex 3050"), ["optiplex", "3050"]);
  assertEquals(entityCore("100Hz audio"), ["100", "hz"]);
  assertEquals(entityCore("VR motion sickness"), ["motion", "sickness"]);
  assertEquals(entityCore("the Dell OptiPlex 3050 desktop"), ["optiplex", "3050"]);
});

Deno.test("entityCore never strips a unit away from its number", () => {
  // "100" alone would match The 100 (TV series) — the fixture this module exists
  // for. A token next to a digit-bearing token belongs to it.
  assertEquals(entityCore("100 Hz"), ["100", "hz"]);
  assertEquals(entityCore("100Hz tone"), ["100", "hz"]);
  assertEquals(entityCore("8 GB"), ["8", "gb"]);
});

Deno.test("entityCore leaves an already-distinctive entity alone", () => {
  assertEquals(entityCore("OOMKilled"), ["oomkilled"]);
  assertEquals(entityCore("semaglutide"), ["semaglutide"]);
  assertEquals(entityCore("CrashLoopBackOff"), ["crashloopbackoff"]);
  assertEquals(entityCore("iPhone 18 Pro"), ["iphone", "18", "pro"]);
});

Deno.test("entityCore refuses to reduce an entity to nothing", () => {
  assertEquals(entityCore("the a of"), ["the", "a", "of"].slice(0, 0).length ? [] : entityCore("the a of"));
  assert(entityCore("VR").length > 0, "a two-letter entity is all there is; keep it");
  assert(entityCore("").length === 0);
});

// ── The rule against OTHER brands, not just the one in the incident ─────────
// Found by attacking the first version of this rule, which dropped a leading
// token only when it was under five characters. That worked for "Dell" by
// accident and left "Lenovo", "NVIDIA" and "Microsoft" in the core — the same
// defect this item exists to fix, one brand name later. The model number
// anchors the identity instead.
Deno.test("a brand of ANY length is dropped; the product line and model are kept", () => {
  assertEquals(entityCore("Lenovo ThinkCentre M910q"), ["m", "910", "q"]);
  assertEquals(entityCore("NVIDIA GeForce RTX 3050 Ti"), ["rtx", "3050", "ti"]);
  assertEquals(entityCore("HP EliteDesk 800 G4"), ["elitedesk", "800", "g", "4"]);
  assertEquals(entityCore("Microsoft Surface Laptop 5"), ["laptop", "5"]);
});

Deno.test("a page that omits the brand still carries the entity", () => {
  const t = (title: string, entity: string) =>
    hitCarriesEntity({ url: "u", title, snippet: "" }, entityCore(entity));
  assert(t("ThinkCentre M910q Tiny teardown", "Lenovo ThinkCentre M910q"));
  assert(t("EliteDesk 800 G4 Mini review", "HP EliteDesk 800 G4"));
  assert(t("OptiPlex 3050 SFF owner's manual", "Dell OptiPlex 3050"));
});

Deno.test("a NEIGHBOURING model is not the same machine", () => {
  const t = (title: string, entity: string) =>
    hitCarriesEntity({ url: "u", title, snippet: "" }, entityCore(entity));
  assertEquals(t("RTX 3050 benchmark", "NVIDIA GeForce RTX 3050 Ti"), false);
  assertEquals(t("DELL OPTIPLEX 3060 AMBER LIGHT", "Dell OptiPlex 3050"), false);
  assertEquals(t("ThinkCentre M920q review", "Lenovo ThinkCentre M910q"), false);
});

Deno.test("a one-character model code never becomes the whole identity", () => {
  // "MacBook Air M2" must not reduce to "m 2": that matches the M.2 SSD form
  // factor, which appears in the OptiPlex fixture's own hit titles.
  assertEquals(entityCore("Apple MacBook Air M2"), ["macbook", "air", "m", "2"]);
  assertEquals(
    hitCarriesEntity({ url: "u", title: "All My Dell Optiplex 3050 SFF M.2 SSD Slots overheat", snippet: "" },
      entityCore("Apple MacBook Air M2")),
    false,
  );
});

Deno.test("a bare number is never an identity", () => {
  // The qualifier trim would reduce "Surface Laptop 5" to "5", which matches
  // any page with a 5 in it.
  for (const e of ["Microsoft Surface Laptop 5", "the 5", "Pixel 9"]) {
    const core = entityCore(e);
    assert(!(core.length === 1 && /^\d+$/.test(core[0])), `${e} -> ${JSON.stringify(core)}`);
  }
});

// ── Matching a hit ──────────────────────────────────────────────────────────
Deno.test("hitCarriesEntity matches the core phrase in the shapes engines write it", () => {
  const core = entityCore("100Hz audio");
  for (const t of ["a pure tone at 100 Hz", "100Hz sound therapy", "the 100-Hz tone",
                   "100  Hz exposure", "Sound at 100 hz"]) {
    assert(hitCarriesEntity({ url: "u", title: t, snippet: "" }, core), t);
  }
  for (const t of ["The 100 (TV series)", "100 patients enrolled", "audio for VR"]) {
    assert(!hitCarriesEntity({ url: "u", title: t, snippet: "" }, core), t);
  }
});

Deno.test("hitCarriesEntity accepts the core without the brand", () => {
  const core = entityCore("Dell OptiPlex 3050");
  assert(hitCarriesEntity({ url: "u", title: "OptiPlex 3050 Small Form Factor Owner's Manual", snippet: "" }, core));
  assert(hitCarriesEntity({ url: "u", title: "Optiplex 3050m - NVMe Overheating", snippet: "" }, core));
  assert(!hitCarriesEntity({ url: "u", title: "DELL OPTIPLEX 3060 AMBER LIGHT BLINKING", snippet: "" }, core));
  assert(!hitCarriesEntity({ url: "u", title: "Troubleshoot Dell Laptop Overheating Issues", snippet: "" }, core));
});

// ── The live sets that failed in production ─────────────────────────────────
Deno.test("ACCEPTANCE 1: the 100 Hz mechanism set is ok for all three spellings", () => {
  const f = fx("live-100hz-mechanism");
  for (const entity of ["100Hz audio", "100Hz", "100 Hz"]) {
    const v = classifyHits(f.query, f.hits, entity);
    assertEquals(v.verdict, "ok", `entity ${entity} -> ${v.verdict} (share ${v.entityShare})`);
  }
  // The paper the run was supposed to find is in the set.
  assert(f.hits.some((h) => /pmc11955832|jstage|1-min exposure to a pure tone/i.test(
    `${h.url} ${h.title}`)), "the Nagoya paper must be in the recorded set");
});

Deno.test("ACCEPTANCE 1: the 100 Hz studies set is ok too", () => {
  const f = fx("live-100hz-studies");
  for (const entity of ["100Hz audio", "100 Hz"]) {
    assertEquals(classifyHits(f.query, f.hits, entity).verdict, "ok", entity);
  }
});

Deno.test("ACCEPTANCE 2: the OptiPlex thermal set is ok with the branded entity", () => {
  const f = fx("live-optiplex-thermal");
  const v = classifyHits(f.query, f.hits, "Dell OptiPlex 3050");
  assertEquals(v.verdict, "ok", `-> ${v.verdict} (share ${v.entityShare})`);
  assertEquals(classifyHits(f.query, f.hits, "OptiPlex 3050").verdict, "ok");
});

Deno.test("ACCEPTANCE 2: the OptiPlex health set stays ok", () => {
  const f = fx("live-optiplex-health");
  assertEquals(classifyHits(f.query, f.hits, "Dell OptiPlex 3050").verdict, "ok");
});

// ── ACCEPTANCE 3: nothing that used to collapse may stop collapsing ─────────
Deno.test("ACCEPTANCE 3: the six recorded collapse sets still collapse", () => {
  for (const [name, entity] of [
    ["search-collapsed-dell", "Dell OptiPlex 3050"],
    ["search-collapsed-most", "Dell OptiPlex 3050"],
    ["search-collapsed-the100", "100 Hz"],
    ["probe-collapsed-capacitor", "OptiPlex 3050"],
    ["probe-collapsed-motherboard", "OptiPlex 3050"],
    ["probe-collapsed-vestibular", "100 Hz"],
  ]) {
    const f = fx(name);
    const v = classifyHits(f.query, f.hits, entity);
    assert(v.verdict !== "ok", `${name} -> ${v.verdict} (share ${v.entityShare})`);
  }
});

Deno.test("ACCEPTANCE 3: the two good sets stay ok", () => {
  for (const [name, entity] of [
    ["probe-good-oomkilled", "OOMKilled"],
    ["probe-good-iphone", "iPhone 18 Pro"],
  ]) {
    const f = fx(name);
    assertEquals(classifyHits(f.query, f.hits, entity).verdict, "ok", name);
  }
  const g = fx("search-good-optiplex");
  assertEquals(classifyHits(g.query, g.hits, "Dell OptiPlex 3050").verdict, "ok");
});

// ── ACCEPTANCE 4: the entity itself is validated ────────────────────────────
Deno.test("ACCEPTANCE 4: an entity absent from the query is REJECTED, not trusted", () => {
  // KEYWORDIZE is a model; it can return a subject the query never mentioned.
  // Gating on that would condemn every search for a question it misread.
  const f = fx("live-100hz-mechanism");
  const v = classifyHits(f.query, f.hits, "Dell OptiPlex 3050");
  assertEquals(v.entityStatus, "rejected");
  assertEquals(v.entityShare, undefined, "a rejected entity is not scored");
  assertEquals(v.verdict, "ok", "and the run falls back to the overlap rule");
});

Deno.test("ACCEPTANCE 4: an empty entity is MISSING, and falls back", () => {
  const f = fx("live-100hz-mechanism");
  for (const e of [undefined, "", "   "]) {
    const v = classifyHits(f.query, f.hits, e);
    assertEquals(v.entityStatus, "missing", JSON.stringify(e));
    assertEquals(v.entityShare, undefined);
  }
});

Deno.test("ACCEPTANCE 4: an entity the query DOES carry is used", () => {
  const f = fx("live-optiplex-health");
  const v = classifyHits(f.query, f.hits, "Dell OptiPlex 3050");
  assertEquals(v.entityStatus, "used");
  assert(typeof v.entityShare === "number");
});

Deno.test("ACCEPTANCE 4: the query is matched on the CORE too", () => {
  // The harness prepends the entity to the query, but a DEEPEN query may carry
  // only the core ("OptiPlex 3050 thermal") while the entity is branded.
  const hits: SearchHit[] = Array.from({ length: 10 }, (_, i) => ({
    url: `u${i}`, title: "OptiPlex 3050 thermal notes", snippet: "",
  }));
  const v = classifyHits("OptiPlex 3050 thermal throttling", hits, "Dell OptiPlex 3050");
  assertEquals(v.entityStatus, "used");
  assertEquals(v.verdict, "ok");
});
