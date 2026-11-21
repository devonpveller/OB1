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
  assertEquals(G.BOUNDARY_VERSION, "pd0b-3");
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
  ["\uFF24\uFF41\uFF4E\uFF41\uFF31\uFF55\uFF49\uFF4C\uFF4C\uFF46\uFF45\uFF41\uFF54\uFF48\uFF45\uFF52", "fullwidth, merged (NFKC)"],
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

// ── round 3 (tester T6, the coordinator's stopping rule): ONE table through BOTH gates ───────────────────────────────
// Every form below must be refused by ownerGate AND by gate, each with denied_token (the same verdict, the same code):
// the tester's attempt-2 sweep (zz-a2-names.test.ts, 25 name forms) plus the developer's. Out of scope by the stopping
// rule (stated in the findings): misspellings and phonetic variants.
const T6_NAME_FORMS: Array<[string, string]> = [
  // the tester's attempt-2 forms
  ["merged", "What heating suits DanaQuillfeather barns?"],
  ["zero-width merged", "What heating suits Dana\u200BQuillfeather barns?"],
  ["reversed merged", "What heating suits QuillfeatherDana barns?"],
  ["reversed spaced", "What heating suits Quillfeather Dana barns?"],
  ["camel spaced", "What heating suits Dana QuillFeather barns?"],
  ["dotted", "What heating suits Dana.Quillfeather barns?"],
  ["underscore", "What heating suits dana_quillfeather barns?"],
  ["digit inside", "What heating suits Dana1Quillfeather barns?"],
  ["digit suffix surname", "What heating suits Quillfeather2 barns?"],
  ["leet surname", "What heating suits Qu1llfeather barns?"],
  ["cyrillic a in Dana + surname merged", "What heating suits D\u0430naQuillfeather barns?"],
  ["cyrillic e in surname", "What heating suits Quillf\u0435ather barns?"],
  ["fullwidth merged", "What heating suits \uFF24\uFF41\uFF4E\uFF41\uFF31\uFF55\uFF49\uFF4C\uFF4C\uFF46\uFF45\uFF41\uFF54\uFF48\uFF45\uFF52 barns?"],
  ["email local joined to surname", "What heating suits danaquillfeatherquillfeather barns?"],
  ["email local merged with domain", "What heating suits danaquillfeatherexample barns?"],
  ["initial + surname", "What heating suits DQuillfeather barns?"],
  ["surname + initial", "What heating suits QuillfeatherD barns?"],
  ["first + surname initial", "What heating suits DanaQ barns?"],
  ["url slug", "What is at example.org/blog/dana-quillfeather-barns?"],
  ["url slug merged", "What is at https://example.org/danaquillfeather/barns?"],
  ["split surname spaced", "What heating suits Quill feather barns?"],
  ["split surname hyphen", "What heating suits Quill-feather barns?"],
  ["possessive", "What heating suits Quillfeather's barns?"],
  ["plural", "What heating suits the Quillfeathers barns?"],
  ["truncated surname", "What heating suits Quillfeath barns?"],
  ["first name only", "What heating suits Dana barns?"],
  // the developer's
  ["cyrillic o + e in surname", "What heating suits Qu\u0456llf\u0435ather barns?"],
  ["greek omicron + alpha merged", "What heating suits D\u03B1n\u03B1Quillfe\u03B1ther barns?"],
  ["cyrillic capitals", "What heating suits \u0414ANA QUILLFE\u0410THER barns?"],
  ["accented surname", "What heating suits Qu\u00EDllf\u00E9ather barns?"],
  ["accent by combining mark", "What heating suits Quillfe\u0301ather barns?"],
  ["surname + both initials", "What heating suits QuillfeatherDQ barns?"],
  ["initial + first name", "What heating suits QDana barns?"],
  ["initials around the surname", "What heating suits DQuillfeatherQ barns?"],
  ["surname inside a longer token", "What heating suits xxquillfeatherxx barns?"],
  ["truncated surname, 7 letters", "What heating suits Quillfe barns?"],
  ["truncated surname, 6 letters", "What heating suits Quillf barns?"],
  ["truncated + homoglyph", "What heating suits Qu\u0456llfeath barns?"],
  ["digit-zero homoglyph in the email local part", "What heating suits danaqu1llfeather barns?"],
];

Deno.test("T6: every name form is refused by ownerGate AND gate, both with denied_token (table-driven)", () => {
  const d = G.denySet({ ownerSub: OWNER.sub, identity: [OWNER.name, OWNER.email], fields: {}, links: [], publicLinks: [], id: "8b0c4f5e-1d2a-4b3c-9e8f-7a6b5c4d3e2f" });
  const bad: string[] = [];
  for (const [why, q] of T6_NAME_FORMS) {
    const o = G.ownerGate(q, d), a = G.gate(q, EV, d, lex, []);
    const oc = o.ok ? "ACCEPT" : o.code, ac = a.ok ? "ACCEPT" : a.code;
    if (oc !== "denied_token" || ac !== "denied_token") bad.push(`${why}: ownerGate=${oc} gate=${ac}`);
  }
  assertEquals(bad, []);
});

Deno.test("T6 controls: common words are not over-denied, and both gates agree on them", () => {
  const d = G.denySet({ ownerSub: OWNER.sub, identity: [OWNER.name, OWNER.email], fields: {}, links: [], publicLinks: [], id: "8b0c4f5e-1d2a-4b3c-9e8f-7a6b5c4d3e2f" });
  const bad: string[] = [];
  for (const q of ["What networks suit old barns?", "What is a danah feather pillow?", "How do quills and feathers differ?",
    "How does feathering a roof work?", "Which quilts suit a cold cabin?", "What is known about the Danube and Canada?",
    "Is a mundane roof design cheaper?", "What heating suits old cold barns?", "How does a quiller tool work?"]) {
    const o = G.ownerGate(q, d);
    if (!o.ok) bad.push(`ownerGate refused: ${q} ${JSON.stringify(o.tokens)}`);
    const a = G.gate(q, EV, d, lex, []);
    if (!a.ok && a.code === "denied_token") bad.push(`gate denied: ${q} ${JSON.stringify(a.tokens)}`);
  }
  assertEquals(bad, []);
});

Deno.test("T6: the skeleton maps Latin / Cyrillic / Greek / fullwidth look-alikes and marks to one form", () => {
  // a skeleton is only ever compared with another skeleton (i, l and 1 are one letter there)
  const same = (a: string, b: string) => assertEquals(G.skeleton(a), G.skeleton(b), `${a} ~ ${b}`);
  same("d\u0430n\u03B1", "dana");
  same("quillf\u0435ather", "quillfeather");
  same("qu1llfe\u0301ather", "quillfeather");
  same("\u0414\u0410NA", "dana");
  same(G.tokens("\uFF24\uFF41\uFF4E\uFF41")[0], "dana");
  assertEquals(G.skeleton("dana"), "dana");
});
