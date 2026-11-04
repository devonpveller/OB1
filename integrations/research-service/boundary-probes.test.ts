/**
 * rw-boundary-core round 2: the tester's attempt-1 probes (t-boundary-core, journal/evidence/rw-boundary-core/tester/
 * attempt1/probes/gate-probes.test.ts) as PERMANENT tests, with the verdict each must now give - TF1 (invisible
 * characters), TF3 (ids and identity in a link's path), TF5 (a malformed escape), TF6 (wildcard-DNS names, numeric
 * hosts, what a name resolves to), TF7 (plural / possessive / joined variants of a denied token). Pure: no DB, no
 * network.   deno test --allow-read boundary-probes.test.ts
 */
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canonicalLink, cleanText, deniedIndices, denySet, type Evidence, gate, idShaped, lexicon, linkPathRefusal, privateHost, stem,
  tokens, WILDCARD_DNS,
} from "./boundary-gate.ts";
import { formDerivedRequest, type PersonalItem, publicAddress } from "./boundary.ts";
import { WILDCARD_DNS as INTAKE_WILDCARD } from "./intake-fetch.ts";
import { MK, OWNER } from "./fixtures/boundary-markers.ts";

const lex = lexicon();
const page = (url: string, title: string, text: string) => ({ url, title, text, sha256: "x" });
const EV: Evidence = { pages: [
  page("https://news.example.org/solar-roofs", "Community solar roofs cut winter bills",
    "Community solar roofs cut winter bills by 18 percent in 2024, a survey found. Call 555 or 0142 for the cold town designs near the coast."),
  page("https://blog.example.org/hello", "Hello the Quillfeathers", "Hello the Quillfeathers and Dana's family, here is your letter about heat pumps."),
]};
const deny = denySet({ ownerSub: OWNER.sub, identity: [OWNER.name, OWNER.email], id: "18c2f0e9a7b4d3c1",
  fields: { title: MK.TIT + " winter plan" }, links: [], publicLinks: EV.pages.map((p) => p.url) });
const personal = [MK.TIT + " winter plan", "the cheap solar roof plan for my winter cabin near the lake", "phone 555-0199 order 7731"];
const ok = (cand: string) => gate(cand, EV, deny, lex, personal).ok;

const INVISIBLE = ["­", "​", "‌", "‍", "⁠", "﻿", "᠎", "͏", "؜", "‎", "⁦", "\u{E0041}"];

Deno.test("TF1 (X1): an invisible character inside an identity token is stripped before tokenising - refused", () => {
  for (const ch of INVISIBLE) {
    const cand = `What research is known about Quill${ch}feather solar roofs?`;
    assertFalse(ok(cand), `U+${ch.codePointAt(0)!.toString(16)}`);
    assertEquals(tokens(cand).includes("quillfeather"), true, "the halves are one token again");
    assertFalse(cleanText(cand).includes(ch));
  }
  // and the marker split by zero-width characters (X2 marker-zw)
  assertFalse(ok("What is known about " + MK.TIT.split("").join("​") + " roofs?"));
});

Deno.test("TF7 (X1 hyphen, X2 plural / possessive): denied by stem and by joined runs", () => {
  assertEquals([stem("quillfeathers"), stem("boxes"), stem("dress"), stem("bus")], ["quillfeather", "box", "dress", "bus"]);
  for (const cand of [
    "What research is known about Quill-feather solar roofs?",      // hyphen-joined
    "What research is known about Quill feather solar roofs?",      // space-joined
    "What research is known about Quill.feather solar roofs?",      // punctuation-joined
    "What is known about the Quillfeathers and heat pumps?",        // plural on a page
    "What is known about Dana's heat pumps?",                       // possessive
    "WHAT IS KNOWN ABOUT QUILLFEATHER SOLAR ROOFS?",                // case
    "What is known about Ｑｕｉｌｌｆｅａｔｈｅｒ solar roofs?",      // fullwidth (NFKC)
    "What is known about " + MK.TIT.toUpperCase() + " roofs?",
  ]) assertFalse(ok(cand), cand);
  const t = tokens("the quill feather roofs");
  assertEquals([...deniedIndices(t, deny)].sort(), [1, 2]);
});

Deno.test("X3: copies, numbers and ids stay refused", () => {
  assertFalse(ok("What designs suit a winter cabin near the lake?"));       // a 4-token personal copy
  assertFalse(ok("What is 555-0199 about solar roofs?"));                   // a number not on a page
  assertFalse(ok("What is 18c2f0e9a7b4d3c1 about solar roofs?"));           // the item's id
  assertFalse(ok("What does news.example.org/" + MK.TIT + " say about solar roofs?"));
});

Deno.test("TF3 (X5): an id-shaped or identity token in a link's PATH refuses the link, whatever the segment's length", () => {
  assertEquals(linkPathRefusal("https://news.example.org/story/" + MK.GID, deny), "id_in_path");
  assertEquals(linkPathRefusal("https://news.example.org/story/a1b2c3d4", deny), "id_in_path");     // 8 chars, the threshold
  assertEquals(linkPathRefusal("https://news.example.org/a/12345678/x", deny), "id_in_path");      // a hex-run of 8
  assertEquals(linkPathRefusal("https://news.example.org/story/a1b2c3d", deny), null);              // 7: under the threshold
  assertEquals(linkPathRefusal("https://news.example.org/people/quill-feather", deny), "identity_in_path");
  assertEquals(linkPathRefusal("https://news.example.org/people/Quill%C2%ADfeather", deny), "identity_in_path");
  assertEquals(linkPathRefusal("https://news.example.org/solar-roofs", deny), null);
  assertEquals(linkPathRefusal(`https://nowhere-${MK.TIT.toLowerCase()}.example.org/x`, deny), "id_in_path");   // never even resolved
  assert(idShaped("a1b2c3d4") && !idShaped("a1b2c3d"));
});

Deno.test("TF5 (X5): a malformed percent-encoding refuses the link - no throw", async () => {
  assert("refused" in canonicalLink("https://news.example.org/%E0%A4%A"));
  const it: PersonalItem = { kind: "gmail", id: "18c2f0e9a7b4d3c1", owner_sub: OWNER.sub, fields: { b: "x" }, links: ["https://news.example.org/%E0%A4%A"] };
  const v = await formDerivedRequest(it, "digest-article", deps(() => []));
  assertFalse(v.ok);
  assertEquals(!v.ok && v.refusal, "link_not_public");
});

Deno.test("TF6 (X5): wildcard-DNS names and numeric hosts by name; every other name by what it resolves to", async () => {
  assertEquals(WILDCARD_DNS, INTAKE_WILDCARD, "the gate's list is intake-fetch.ts's");
  for (const u of ["http://127.0.0.1.nip.io/admin", "http://192.168.1.20.sslip.io/", "http://[::1]/", "http://2130706433/",
    "http://0x7f.1/", "http://100.100.100.100/", "https://dana:pw@news.example.org/x", "http://localtest.me/"]) {
    assert("refused" in canonicalLink(u), u);
  }
  assertFalse(privateHost(new URL("https://news.example.org/")));
  const r = (addrs: string[]) => ({ resolve: () => Promise.resolve(addrs) });
  assert(await publicAddress("https://news.example.org/x", r(["93.184.216.34"])));
  for (const a of [["127.0.0.1"], ["10.1.2.3"], ["192.168.1.20"], ["169.254.169.254"], ["100.64.0.1"], ["::1"], ["fe80::1"],
    ["fd00::1"], ["::ffff:127.0.0.1"], [], ["93.184.216.34", "10.0.0.1"]]) {
    assertFalse(await publicAddress("https://rebind.example.org/x", r(a)), JSON.stringify(a));
  }
  // through formDerivedRequest: a name that resolves privately is never fetched
  let fetched = 0;
  const it: PersonalItem = { kind: "gmail", id: "x1", owner_sub: OWNER.sub, fields: { s: "solar" }, links: ["https://rebind.example.org/solar-roofs"] };
  const v = await formDerivedRequest(it, "digest-article", { ...deps(() => []), resolve: () => Promise.resolve(["127.0.0.1"]),
    fetchPublic: () => { fetched++; return Promise.resolve({ title: "Solar", text: "Solar roofs." }); } });
  assertEquals([v.ok, fetched], [false, 0]);
});

const pages: Record<string, { title: string; text: string }> = {
  "https://news.example.org/solar-roofs": { title: "Community solar roofs cut winter bills", text: "Community solar roofs cut winter bills, a survey found." },
};
function deps(echo: (it: PersonalItem) => string[]) {
  return {
    propose: (it: PersonalItem) => Promise.resolve(echo(it)),
    fetchPublic: (u: string) => Promise.resolve(pages[u] ?? (u.startsWith("https://news.example.org/") ? { title: "Solar story", text: "Solar roofs story text." } : null)),
    identity: () => Promise.resolve([OWNER.name, OWNER.email]),
    resolve: () => Promise.resolve(["93.184.216.34"]),
  };
}

Deno.test("TF1 (X4, X4b): the hostile proposer echoing a field with an invisible-split surname is refused; the stored string is the judged one", async () => {
  for (const subject of ["Quill­feather solar roofs for winter", "Quill­feather roofs?", "Quill​feather roofs?", "Quill-feather roofs?"]) {
    const it: PersonalItem = { kind: "gmail", id: "18c2f0e9a7b4d3c1", owner_sub: OWNER.sub, fields: { subject, body: "notes " + MK.BODY }, links: ["https://news.example.org/solar-roofs"] };
    const hostile = deps((i) => [...Object.values(i.fields)]);
    const a = await formDerivedRequest(it, "digest-gap", hostile);
    const b = await formDerivedRequest(it, "digest-gap", hostile);
    assertEquals(a.verdict_id, b.verdict_id, "re-run determinism");
    if (a.ok) {
      assertEquals(a.record.accepted_by, "template", `${JSON.stringify(subject)}: only the public title may pass`);
      assertEquals(a.request.question, cleanText(a.request.question));
      assertFalse(/quill|feather/i.test(a.request.question + a.request.topic), a.request.question);
    }
  }
});

Deno.test("TF3 (X5): a marker in a public link's path never reaches the request", async () => {
  const it: PersonalItem = { kind: "gmail", id: "18c2f0e9a7b4d3c1", owner_sub: OWNER.sub, fields: { subject: "your order", body: "see link" },
    links: ["https://news.example.org/story/" + MK.GID] };
  const v = await formDerivedRequest(it, "digest-article", deps(() => []));
  assertFalse(v.ok, JSON.stringify(v));
  assertEquals(!v.ok && v.refusal, "link_not_public");
});

Deno.test("X12 (info, TF10 not in this round): proper-name homographs in the lexicon - the identity deny list is the control", () => {
  const sample = ["google", "trump", "amazon", "bible", "smith", "london", "paris", "quillfeather"];
  const inLex = sample.filter((n) => lex.words.has(n));
  console.log(`X12 lexicon homographs in the sample: ${inLex.join(" ")}`);
  // whatever the lexicon holds, an identity token is refused
  const d = denySet({ ownerSub: "s", identity: ["John Smith"], fields: {}, links: [], publicLinks: [] });
  assertFalse(gate("What does Smith say about solar roofs?", EV, d, lex, []).ok);
});
