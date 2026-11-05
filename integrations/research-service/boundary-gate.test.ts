/**
 * The request boundary's gate, pure and deterministic (rw-boundary-core, plan 09 section 5 "the deterministic gate
 * tests"; acceptance 1). No DB, no network, no model: the image's test stage runs it.
 *   deno test --allow-read boundary-gate.test.ts
 * The markers are plan 09's shape `zq<field>m<8 hex>`: one token, in no lexicon, on no public page - a correct gate
 * refuses every one; the positive control `zqPUBm<hex>` is on a public page and must pass.
 */
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BOUNDARY_VERSION, canonicalLink, denySet, type Evidence, FRAME, gate, idShaped, lexicon, lexiconText, privateHost, templateQuestion, tokens,
} from "./boundary-gate.ts";
import { LEXICON_COUNT, LEXICON_SHA256, LEXICON_WORDS } from "./boundary-lexicon.ts";
import { sha256Hex } from "./boundary.ts";
import { MK, OWNER } from "./fixtures/boundary-markers.ts";


const lex = lexicon();
const page = (url: string, title: string, text: string) => ({ url, title, text, sha256: "x" });
const EV: Evidence = {
  pages: [
    page("https://news.example.org/solar-roofs", "Community solar roofs cut winter bills",
      `Community solar roofs cut winter bills by 18 percent in 2024, a survey found. The term ${MK.PUB} names the method. ` +
        "Researchers compared the cheap solar roof designs used in cold towns."),
    page("https://blog.example.org/hello", "Hello Dana Quillfeather", "Hello Dana Quillfeather, here is your weekly letter about heat pumps."),
  ],
};
const deny = denySet({
  ownerSub: OWNER.sub, identity: [OWNER.name, OWNER.email, MK.MMUSER], id: "18c2f0e9a7b4d3c1",
  fields: { title: `${MK.TIT} winter plan`, summary: `${MK.SUM} the cheap solar roof plan for my winter cabin` },
  links: ["https://news.example.org/solar-roofs?u=" + MK.QRY, "https://tracker.example.com/" + MK.GID + "/unsubscribe"],
  publicLinks: ["https://news.example.org/solar-roofs"],
});
const personal = [`${MK.TIT} winter plan`, `${MK.SUM} the cheap solar roof plan for my winter cabin`, "my own private trip to the coast in spring"];

Deno.test("the lexicon is the checked-in one: its sha256 is its version, no proper nouns, one token per entry", async () => {
  assertEquals(await sha256Hex(lexiconText()), LEXICON_SHA256);
  // a CRLF checkout (git autocrlf on Windows) changes neither the words nor the hash
  assertFalse(lexiconText().includes(String.fromCharCode(13)));
  assertEquals(lexiconText().split(String.fromCharCode(10)).length, LEXICON_COUNT);
  assertEquals(lex.version, LEXICON_SHA256);
  const words = LEXICON_WORDS.split("\n");
  assertEquals(words.length, LEXICON_COUNT);
  assert(LEXICON_COUNT > 40000 && LEXICON_COUNT < 70000, `about 50k words (${LEXICON_COUNT})`);
  assertEquals(new Set(words).size, words.length, "unique");
  assertEquals([...words].sort().join("\n"), LEXICON_WORDS, "sorted");
  for (const w of words) {
    assertEquals(tokens(w), [w], `one lowercase token: ${w}`);
  }
  for (const w of Object.values(MK)) assertFalse(lex.words.has(w.toLowerCase()), `marker ${w} is in no lexicon`);
  for (const w of ["dana", "quillfeather", "kubernetes", "openbrain"]) assertFalse(lex.words.has(w), `${w} is not a lexicon word`);
  for (const w of ["solar", "winter", "roof", "research", "vaccine"]) assert(lex.words.has(w), `${w} is a lexicon word`);
  for (const w of FRAME) assert(tokens(w).length === 1, `frame word ${w}`);
});

Deno.test("gate is pure: no I/O, clock, randomness or model in its module", async () => {
  const src = await Deno.readTextFile(new URL("./boundary-gate.ts", import.meta.url));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const bad of ["fetch(", "Deno.", "Date", "Math.random", "crypto.", "performance.", "await ", "import(", "setTimeout"]) {
    assertFalse(code.includes(bad), `boundary-gate.ts uses ${bad}`);
  }
  const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assertEquals(imports, ["./boundary-lexicon.ts"]);
});

// the table of cases (plan 09 section 5)
const CASES: Array<[string, string, boolean, string?]> = [
  ["a public question in common words", "What is known about community solar roofs and winter bills?", true],
  ["the positive control: a token on a fetched public page passes", `How does the ${MK.PUB} method work for solar roofs?`, true],
  ["a number on the page passes", "Did community solar roofs cut winter bills by 18 percent in 2024?", true],
  ["a number not on the page is refused", "Did community solar roofs cut winter bills by 35 percent in 2019?", false, "number_not_in_evidence"],
  ["a title marker is refused", `What is known about ${MK.TIT} and solar roofs?`, false],
  ["a summary marker is refused", `How do ${MK.SUM} solar roofs work?`, false],
  ["the owner's name is refused although a public page greets them", "What does Dana Quillfeather say about heat pumps?", false, "denied_token"],
  ["the owner's email domain is refused", "What is quillfeather known for in heat pumps?", false, "denied_token"],
  ["a Mattermost username is refused", `What does ${MK.MMUSER} think about solar roofs?`, false, "denied_token"],
  ["a 4-token copy from a personal field is refused", "What is the best plan for my winter cabin?", false, "personal_copy"],
  ["a 4-token copy the page also has passes", "What are the cheap solar roof designs for cold towns?", true],
  ["a URL token of a non-public link is refused", "How does a tracker work for solar roofs?", false, "denied_token"],
  ["a query-string token of a public link is refused", `What is ${MK.QRY} in solar roofs?`, false],
  ["an off-list proper noun is refused", "How does Kubernetes schedule solar roof workloads?", false, "token_not_allowed"],
  ["too short", "solar roofs", false, "length"],
  ["too long", "what is known about solar roofs ".repeat(20), false, "length"],
];

for (const [name, cand, ok, code] of CASES) {
  Deno.test(`gate: ${name}`, () => {
    const g = gate(cand, EV, deny, lex, personal);
    assertEquals(g.ok, ok, JSON.stringify(g));
    if (!g.ok && code) assertEquals(g.code, code);
    // determinism: a recorded verdict re-run returns the same verdict
    assertEquals(gate(cand, EV, deny, lex, personal), g);
  });
}

Deno.test("every marker in any personal field is refused, alone or inside an otherwise public question", () => {
  for (const [f, m] of Object.entries(MK)) {
    if (f === "PUB") continue;
    const fields = { [f]: `${m} about solar roofs` };
    const d = denySet({ ownerSub: OWNER.sub, identity: [OWNER.name], fields, links: [], publicLinks: [] });
    for (const cand of [`What is known about ${m}?`, `How do solar roofs relate to ${m} in winter?`, `${m} ${m} ${m}`]) {
      assertFalse(gate(cand, EV, d, lex, Object.values(fields)).ok, `${f}: ${cand}`);
      // even with the marker NOT in the deny set (a field the caller forgot): it is no lexicon word, on no page
      assertFalse(gate(cand, EV, new Set(), lex, []).ok, `${f} (undenied): ${cand}`);
    }
  }
});

Deno.test("deny: id-shaped tokens of the item, the owner's identity, every token of a non-public link", () => {
  assert(idShaped("18c2f0e9a7b4d3c1") && idShaped("zqgidm2f6b88e4") && idShaped("a1b2c3d4"));
  assertFalse(idShaped("winter") || idShaped("2024") || idShaped("covid19"));
  for (const t of ["dana", "quillfeather", "example", "net", "tracker", MK.GID.toLowerCase(), MK.QRY.toLowerCase(), MK.MMUSER.toLowerCase(), "18c2f0e9a7b4d3c1"]) {
    assert(deny.has(t), `deny has ${t}`);
  }
  // the public link's own path tokens are not denied (only its query string)
  assertFalse(deny.has("solar"));
  assertFalse(deny.has("roofs"));
});

Deno.test("links: canonical public form; the private-host list; token paths", () => {
  assertEquals(canonicalLink("https://News.Example.org:443/a/b?utm=1#x"), { url: "https://news.example.org/a/b" });
  assertEquals(canonicalLink("http://example.org"), { url: "http://example.org/" });
  const refused = (u: string) => "refused" in canonicalLink(u);
  for (const u of [
    "https://mail.google.com/mail/u/0/#inbox/18c2f0e9a7b4d3c1", "https://www.google.com/calendar/event?eid=1", "https://docs.google.com/document/d/x",
    "https://accounts.example.com/x", "http://localhost:8080/x", "http://10.1.2.3/x", "http://192.168.1.20/x", "http://172.20.0.4/x",
    "http://169.254.1.1/x", "https://box.tail1234.ts.net/x", "http://openbrain-db:5432/", "https://[::1]/x", "ftp://example.org/x",
    "https://user:pw@example.org/x", "https://news.example.org/unsubscribe", "https://example.org/p/abcdef", "https://example.org/manage",
    `https://example.org/${"a".repeat(41)}`, "not a url", "javascript:alert(1)",
  ]) assert(refused(u), `refused: ${u}`);
  assertFalse(privateHost(new URL("https://news.example.org/x")));
  // a mail.google.com thread id never reaches the request: the link is refused before any fetch
});

Deno.test("the template: a fetched title with DENY removed; it passes the gate by construction", () => {
  const t = templateQuestion("Hello Dana Quillfeather: Community solar roofs cut winter bills", deny)!;
  assertEquals(t.question, `What is publicly known about "hello community solar roofs cut winter bills"?`);
  assert(gate(t.question, EV, deny, lex, personal).ok);
  assertEquals(templateQuestion("Dana Quillfeather", deny), null);
  assertEquals(BOUNDARY_VERSION, "pd0c-1");
});

// ── rw-boundary-digest round 2 (tester F1): meeting, invite and share links are never public ──────────────────
Deno.test("links: meeting, calendar, file-share and personal-page links are refused (private_host); ordinary articles pass", () => {
  const refused = [
    // the tester's two (attempt 1, Case 6a): a calendar invite's Meet code and a Drive file with a letters-only id
    "http://meet.google.com/qzw-xkvj-pmr", "https://drive.google.com/file/d/AbcDefGhiJklMnoPqr/view",
    "https://docs.google.com/document/d/abcdefgh/edit", "https://sites.google.com/view/our-family-reunion",
    "https://drive.google.com/open", "https://www.google.com/calendar/event", "https://calendar.google.com/calendar/r",
    // other meeting hosts
    "https://us02web.zoom.us/j/84512345678", "https://zoom.us/my/danasroom", "https://zoom.us/rec/share/abcdef",
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting/0", "https://teams.live.com/meet/9876",
    "https://acme.webex.com/meet/dana", "https://acme.my.webex.com/join/x", "https://whereby.com/danas-room",
    "https://global.gotomeeting.com/join/123456789", "https://meet.goto.com/123456789", "https://meet.jit.si/OurStandup",
    "https://meet.example.org/room", "https://join.example.com/abc",
    // file shares and personal pages
    "https://www.dropbox.com/s/abc/plan.pdf", "https://www.dropbox.com/scl/fi/abc/plan.pdf", "https://1drv.ms/w/s!Abc",
    "https://onedrive.live.com/redir", "https://acme.sharepoint.com/sites/team/Shared%20Documents/plan.docx",
    "https://app.box.com/s/abcdef", "https://wetransfer.com/downloads/abc/def", "https://we.tl/t-abcdef",
    "https://docs.zoho.com/file/abc", "https://workdrive.zoho.com/file/abc", "https://dana.notion.site/Plans-abc",
    "https://www.notion.so/dana/Plans", "https://airtable.com/shrAbcdef", "https://airtable.com/appAbc/shrDef",
    "https://calendly.com/dana/30min", "https://cal.com/dana", "https://www.figma.com/file/abc/Plan",
    "https://www.loom.com/share/abc", "https://forms.gle/abc", "https://docsend.com/view/abc", "https://mega.nz/file/abc",
    "https://www.icloud.com/iclouddrive/abc", "https://forms.office.com/r/abc", "https://discord.gg/abcdef",
    // the generic rules: a share / invite / join segment followed by more, a Meet-shaped code, a calendar file
    "https://files.example.org/share/abcdef", "https://app.example.com/invite/team", "https://events.example.com/x/abc-defg-hij",
    "https://events.example.com/cal/meeting.ics",
  ];
  for (const u of refused) {
    const c = canonicalLink(u);
    assert("refused" in c && c.refused === "private_host", `${u}: ${JSON.stringify(c)}`);
  }
  const passed = [
    "https://www.nytimes.com/2024/05/01/climate/solar-roofs.html", "https://en.wikipedia.org/wiki/Solar_power",
    "https://blog.google/technology/ai/solar-roofs/", "https://www.zoom.com/en/blog/hybrid-work/", "https://zoom.us/pricing",
    "https://www.dropbox.com/features", "https://news.example.org/solar-roofs", "https://www.theverge.com/2024/5/1/share-prices",
    "https://www.example.com/sharing-economy-explained", "https://techcrunch.com/2024/05/01/meeting-room-startup-raises/",
  ];
  for (const u of passed) assert("url" in canonicalLink(u), `${u} should stay public`);
});
