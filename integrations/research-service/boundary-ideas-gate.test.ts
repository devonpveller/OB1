/**
 * rw-boundary-ideas (plan 09 PD0b): the two gate changes, pure (no DB, no network, no model).
 *   deno test --allow-read boundary-ideas-gate.test.ts
 *   R-F1 (420 reviewer): an unreachable link in an item must not refuse the plain question nor the template's frame - a
 *        non-public link's FRAME words are not denied (its other tokens still are).
 *   D7: ownerGate - the owner's approved question: the identity deny list, ids and the length rule still refuse it.
 */
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as G from "./boundary-gate.ts";
import { MK, OWNER } from "./fixtures/boundary-markers.ts";

const lex = G.lexicon();
const EV: G.Evidence = { pages: [{ url: "https://news.example.org/solar-roofs", title: "Community solar roofs cut winter bills",
  text: "Community solar roofs cut winter bills by 18 percent in 2024, a survey found.", sha256: "x" }] };
const base = { ownerSub: OWNER.sub, identity: [OWNER.name, OWNER.email], fields: { summary: `${MK.SUM} how a sourdough starter works` }, publicLinks: ["https://news.example.org/solar-roofs"] };

Deno.test("R-F1: an unreachable link's frame words do not refuse a plain question (the reviewer's probe)", () => {
  const q = "What is known about how a sourdough starter works?";
  const without = G.denySet({ ...base, links: ["https://news.example.org/solar-roofs"] });
  const withDead = G.denySet({ ...base, links: ["https://news.example.org/solar-roofs", "https://news.example.org/about"] });
  assert(G.gate(q, EV, without, lex, []).ok, "accepted without the extra link");
  assert(G.gate(q, EV, withDead, lex, []).ok, "an unfetchable https://news.example.org/about no longer refuses it (R-F1)");
  // the link's OTHER tokens stay denied: its host words are not frame words
  for (const w of ["news", "example", "org", "https"]) assert(withDead.has(w), `still denied: ${w}`);
  assertFalse(withDead.has("about"));
});

Deno.test("R-F1: the template's frame passes beside a dead link whose path is frame words", () => {
  const d = G.denySet({ ...base, links: ["https://news.example.org/solar-roofs", "https://dead.example.org/what/is/known/about"] });
  const t = G.templateQuestion("Community solar roofs cut winter bills", d);
  assert(t && G.gate(t.question, EV, d, lex, []).ok, `the template passes by construction again: ${t?.question}`);
});

Deno.test("R-F1: a private link's non-frame tokens (a marker, a host word) stay denied", () => {
  const d = G.denySet({ ...base, links: [`https://intranet.example.com/projects/${MK.TIT}/about`] });
  assertFalse(G.gate(`What is known about ${MK.TIT} roofs?`, EV, d, lex, []).ok);
  assertFalse(G.gate("What is known about intranet roofs?", EV, d, lex, []).ok, "a private host word is still denied");
});

Deno.test("ownerGate (D7): the owner's own words pass; identity, ids, markers and the length rule refuse", () => {
  const d = G.denySet({ ...base, links: [], id: "8b0c4f5e-1d2a-4b3c-9e8f-7a6b5c4d3e2f" });
  // the owner's invented word passes (consent) - the automatic gate refuses it
  const own = "How do sourdough starters behave in a Bramblecote kitchen?";
  assert(G.ownerGate(own, d).ok, "the owner's own words pass");
  assertFalse(G.gate(own, EV, d, lex, []).ok, "control: the automatic gate refuses the invented word");
  const bad: Array<[string, string]> = [
    [`How does ${OWNER.name.split(" ")[1]} bake bread?`, "the owner's surname"],
    [`Is ${OWNER.email} a good baker?`, "the owner's email"],
    [`What is ${MK.SUM} about?`, "a marker (id-shaped)"],
    ["What about 8b0c4f5e bread?", "the idea's id"],
    ["What is order a1b2c3d4e5 about?", "any id-shaped token"],
    ["Quill­feather bread recipes today?", "an invisible-split surname"],
    ["bread", "too short"],
  ];
  for (const [q, why] of bad) assertFalse(G.ownerGate(q, d).ok, why);
  const named = G.ownerGate(`Is ${OWNER.email} a good baker?`, d);
  assert(!named.ok && named.tokens.includes("quillfeather"), "the failing tokens are named");
  assertEquals(G.BOUNDARY_VERSION, "pd0b-2");
});

// ── round 2 (tester T1): the owner's name MERGED into one token ─────────────────────────────────────────────────────
// deniedIndices joined 2-3 QUESTION tokens to meet one deny entry, but never met one question token made of 2-3 deny
// entries: `DanaQuillfeather` (camel / zero-width / soft-hyphen joined) passed ownerGate and was stored on a shared
// derived job. Each variant must be refused by ownerGate AND by the automatic gate with the SAME code (denied_token),
// and the template must drop it.
const T1_VARIANTS: Array<[string, string]> = [
  ["DanaQuillfeather", "camel-joined (the tester's)"],
  ["Dana\u200BQuillfeather", "zero-width-joined (the tester's)"],
  ["Dana\u00ADQuillfeather", "soft-hyphen-joined"],
  ["Dana\u2060Quillfeather", "word-joiner-joined"],
  ["danaQuillfeather", "lower camel"],
  ["DANAQUILLFEATHER", "upper, merged"],
  ["ＤａｎａＱｕｉｌｌｆｅａｔｈｅｒ", "fullwidth, merged (NFKC)"],
  ["DanaQuillfeathers", "merged plural"],
  ["QuillfeatherDana", "merged, reversed order"],
  ["Danaquill feather", "re-split at the wrong place"],
  ["Dana.Quillfeather", "dotted"],
  ["Dana-Quillfeather", "hyphenated"],
  ["D.Quillfeather", "initial, dotted"],
  ["DQuillfeather", "initial, merged"],
  ["DanaQ", "first name + surname initial, merged"],
  ["DanaQ.", "first name + surname initial, dotted"],
];

Deno.test("T1: a merged / joined / initialled owner name is refused by ownerGate and by the automatic gate alike", () => {
  const d = G.denySet({ ...base, links: [] });
  const failed: string[] = [];
  for (const [name, why] of T1_VARIANTS) {
    const q = `What heating suits ${name} barns?`;
    const og = G.ownerGate(q, d);
    const ag = G.gate(q, EV, d, lex, []);
    if (og.ok) failed.push(`ownerGate accepted ${why}`);
    if (ag.ok || ag.code !== "denied_token") failed.push(`gate did not deny ${why} (${ag.ok ? "ok" : ag.code})`);
    if (!og.ok && !ag.ok && og.code !== ag.code) failed.push(`codes differ for ${why}: ${og.code} vs ${ag.code}`);
    const tq = G.templateQuestion(`Heating for ${name} barns`, d);
    if (tq && G.tokens(tq.question).some((w) => w.includes("quillfeather") || w.startsWith("dana"))) failed.push(`template kept ${why}`);
  }
  assertEquals(failed, []);
});

Deno.test("T1: a deny set built by hand (entries with separators or invisibles) is normalised the same way", () => {
  const raw = new Set(["Dana Quillfeather", "Quill\u200Bfeather"]);
  for (const q of ["What suits DanaQuillfeather barns?", "What suits Dana Quillfeather barns?", "What suits quillfeather barns?"]) {
    assertFalse(G.ownerGate(q, raw).ok, q);
  }
});

Deno.test("T1 controls: ordinary words that merely contain or neighbour a name part still pass", () => {
  const d = G.denySet({ ...base, links: [] });
  for (const q of ["How do sourdough starters behave in a Bramblecote kitchen?", "What heating suits mundane barns?",
    "What is known about community solar roofs?"]) assert(G.ownerGate(q, d).ok, q);
  assert(G.gate("What is known about community solar roofs?", EV, d, lex, []).ok);
});
