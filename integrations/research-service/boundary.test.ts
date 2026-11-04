/**
 * formDerivedRequest with the three stub proposers of plan 09 section 5 (honest, hostile, empty) and a stub fetch
 * gate; the door's body rules; the request kinds POST /research records (rw-boundary-core, acceptance 1). Pure: no
 * DB, no network, no model.   deno test --allow-read boundary.test.ts
 */
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type BoundaryDeps, canonicalJson, formDerivedRequest, parseDoorBody, parseProposals, type PersonalItem, type Purpose, PURPOSES } from "./boundary.ts";
import { gate, lexicon, tokens } from "./boundary-gate.ts";
import { type Caller, parseServiceCallers, requestKindOf } from "./origin.ts";
import { promptSpans, withoutPromptSpansKeepLines } from "./prompt-private.ts";
import { MK, OWNER } from "./fixtures/boundary-markers.ts";

const PAGES: Record<string, { title: string; text: string }> = {
  "https://news.example.org/solar-roofs": {
    title: "Community solar roofs cut winter bills",
    text: `Community solar roofs cut winter bills by 18 percent in 2024, a survey found. The ${MK.PUB} method is described.`,
  },
  "https://blog.example.org/hello": { title: "Hello Dana Quillfeather", text: "Hello Dana Quillfeather, your weekly letter about heat pumps." },
};

/** Every personal field of every inlet kind carries its own marker (plan 09 section 5). */
function items(): Array<{ item: PersonalItem; purpose: Purpose }> {
  const owner_sub = OWNER.sub;
  return [
    { purpose: "idea-research", item: { kind: "idea", id: "8b0c4f5e-1d2a-4b3c-9e8f-7a6b5c4d3e2f", revision: 3, owner_sub, links: [],
        fields: { title: `${MK.TIT} winter plan`, summary: `${MK.SUM} the cheap solar roof plan for my winter cabin`, revision: `${MK.REV} new notes`, domain: MK.DOMAIN, owner_name: OWNER.name } } },
    { purpose: "idea-research", item: { kind: "idea", id: "idea-with-a-link", owner_sub, links: ["https://news.example.org/solar-roofs"],
        fields: { title: `${MK.TIT} solar`, summary: `${MK.SUM} community solar roofs for my street` } } },
    { purpose: "digest-article", item: { kind: "gmail", id: "18c2f0e9a7b4d3c1", owner_sub,
        links: [`https://news.example.org/solar-roofs?u=${MK.QRY}`, `https://mail.google.com/mail/u/0/#inbox/${MK.THR}`, "https://blog.example.org/hello"],
        fields: { subject: `${MK.SUBJ} your weekly roundup`, from: `${MK.FROM} <${MK.FROM.toLowerCase()}@letters.example.com>`, body: `${MK.BODY} long newsletter text`,
                  label: MK.LABEL, gmail_id: MK.GID, gmail_thread_id: MK.THR } } },
    { purpose: "digest-gap", item: { kind: "gmail", id: MK.GID, owner_sub, links: [`https://news.example.org/solar-roofs?u=${MK.QRY}`],
        fields: { candidate: `${MK.BODY} what about solar in winter`, subject: MK.SUBJ, label: MK.LABEL } } },
    { purpose: "brainstorm-gap", item: { kind: "brainstorm", id: "mm-post-1", owner_sub, links: ["https://news.example.org/solar-roofs"], identity: [MK.MMUSER],
        fields: { reply: `${MK.REPLY} maybe my cabin needs this`, dossier: `${MK.DOSSIER} thread text` } } },
  ];
}

const proposers = {
  honest: () => Promise.resolve(["What is known about community solar roofs and winter bills?"]),
  hostile: (it: PersonalItem) => {
    const f = Object.values(it.fields);
    return Promise.resolve([...f, f.join(" "), `What is known about ${f.join(" and ")}?`, ...it.links]);
  },
  empty: () => Promise.resolve([] as string[]),
  throws: () => Promise.reject(new Error("model down")),
};

function deps(mode: keyof typeof proposers): BoundaryDeps & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    propose: (it) => proposers[mode](it),
    fetchPublic: (u) => { fetched.push(u); return Promise.resolve(PAGES[u] ?? null); },
    identity: () => Promise.resolve([OWNER.name, OWNER.email]),
    resolve: () => Promise.resolve(["93.184.216.34"]),   // a public address (round 2: every link's host is resolved)
  };
}

const markerIn = (s: string) => Object.entries(MK).filter(([f]) => f !== "PUB").map(([, m]) => m.toLowerCase()).filter((m) => s.toLowerCase().includes(m));

Deno.test("a hostile proposer that returns every personal field never yields a marker - any purpose, any inlet", async () => {
  for (const { item, purpose } of items()) {
    for (const mode of ["hostile", "honest", "empty", "throws"] as const) {
      const v = await formDerivedRequest(item, purpose, deps(mode));
      const out = v.ok ? JSON.stringify(v.request) : "";
      assertEquals(markerIn(out), [], `${item.kind}/${purpose}/${mode}: ${out}`);
      // the record is hashes and codes: no personal text, whatever the verdict
      assertEquals(markerIn(JSON.stringify(v.record)), [], `${item.kind}/${purpose}/${mode} record`);
      assertFalse(JSON.stringify(v.record).includes(OWNER.name), "no identity in the record");
      if (v.ok) {
        assert(gate(v.request.question, { pages: [] }, new Set(), lexicon(), []).ok || v.request.links.length > 0, "accepted question is allow-listed");
        for (const l of v.request.links) assertFalse(l.includes("?") || l.includes("#") || l.includes("mail.google.com"), l);
        assertFalse(tokens(v.request.question).some((w) => ["dana", "quillfeather"].includes(w)), v.request.question);
      }
    }
  }
});

Deno.test("hostile: the model's copies are refused; the template (from a public title) or a refusal remains", async () => {
  const [idea, ideaLink, article, gap, brainstorm] = items();
  const a = await formDerivedRequest(idea.item, idea.purpose, deps("hostile"));
  assertFalse(a.ok);
  assertEquals(!a.ok && a.refusal, "no_candidate_passed");
  // the idea path: the owner sees the best candidate and why (awaiting_owner, PD0b) - owner-only
  assert(!a.ok && a.owner_view && a.owner_view.failing.length > 0);
  for (const it of [ideaLink, gap, brainstorm]) {
    const v = await formDerivedRequest(it.item, it.purpose, deps("hostile"));
    assert(v.ok, `${it.purpose}: ${JSON.stringify(v)}`);
    assertEquals(v.ok && v.record.accepted_by, "template");
    assertEquals(v.ok && v.request.question, `What is publicly known about "community solar roofs cut winter bills"?`);
  }
  const art = await formDerivedRequest(article.item, article.purpose, deps("hostile"));
  assert(art.ok);
  assertEquals(art.ok && art.record.accepted_by, "template");
  // the mail.google.com link is never fetched; the query string is dropped before the fetch
  const d = deps("hostile");
  await formDerivedRequest(article.item, article.purpose, d);
  assertEquals(d.fetched, ["https://news.example.org/solar-roofs", "https://blog.example.org/hello"]);
});

Deno.test("honest: the model's public question is accepted; an article takes the template only (no model call)", async () => {
  const [, ideaLink, article] = items();
  const v = await formDerivedRequest(ideaLink.item, ideaLink.purpose, deps("honest"));
  assert(v.ok);
  assertEquals(v.ok && v.request.question, "What is known about community solar roofs and winter bills?");
  assertEquals(v.ok && v.record.accepted_by, "model");
  let called = 0;
  const d = { ...deps("honest"), propose: () => { called++; return Promise.resolve(["What is known about solar roofs?"]); } };
  const art = await formDerivedRequest(article.item, article.purpose, d);
  assertEquals(called, 0);
  assertEquals(art.ok && art.record.accepted_by, "template");
});

Deno.test("refusals: no owner, a service owner, empty, all links non-public, nothing public and no candidate", async () => {
  const [idea, , article] = items();
  for (const owner_sub of ["", "  ", "service:shared-key", "system:research"]) {
    const v = await formDerivedRequest({ ...idea.item, owner_sub }, idea.purpose, deps("honest"));
    assertEquals(!v.ok && v.refusal, "no_owner");
  }
  assertEquals((await formDerivedRequest({ ...idea.item, fields: {}, links: [] }, idea.purpose, deps("honest")) as { refusal: string }).refusal, "empty");
  const priv = { ...article.item, links: [`https://mail.google.com/mail/u/0/#inbox/${MK.THR}`, "http://192.168.1.20/x"] };
  assertEquals((await formDerivedRequest(priv, "digest-article", deps("honest")) as { refusal: string }).refusal, "link_not_public");
  assertEquals((await formDerivedRequest({ ...idea.item }, idea.purpose, deps("empty")) as { refusal: string }).refusal, "no_public_evidence");
});

Deno.test("deterministic: the same inputs give the same record and verdict id; a different page snapshot changes it", async () => {
  for (const { item, purpose } of items()) {
    const a = await formDerivedRequest(item, purpose, deps("hostile"));
    const b = await formDerivedRequest(item, purpose, deps("hostile"));
    assertEquals(canonicalJson(a.record), canonicalJson(b.record));
    assertEquals(a.verdict_id, b.verdict_id);
    if (a.ok && b.ok) assertEquals(a.request, b.request);
  }
  const [, ideaLink] = items();
  const a = await formDerivedRequest(ideaLink.item, ideaLink.purpose, deps("honest"));
  const changed = { ...deps("honest"), fetchPublic: (u: string) => Promise.resolve(PAGES[u] ? { ...PAGES[u], text: PAGES[u].text + " (updated)" } : null) };
  const b = await formDerivedRequest(ideaLink.item, ideaLink.purpose, changed);
  assert(a.ok && b.ok && a.verdict_id !== b.verdict_id && a.record.evidence[0].sha256 !== b.record.evidence[0].sha256);
});

Deno.test("the door's body: seed content, callbacks, inlet refs, on-behalf, a query or options are refused", () => {
  const ok = { item: { kind: "gmail", id: "x1", owner_sub: OWNER.sub, fields: { subject: "s" }, links: ["https://example.org/a"] }, purpose: "digest-article", deliver: { segment: 2 } };
  assert(!("error" in parseDoorBody(ok)));
  for (const k of ["seed_sources", "callback", "inlet_ref", "on_behalf_of", "query", "options", "thread_id", "refinery_id"]) {
    const top = parseDoorBody({ ...ok, [k]: [{ url: "https://example.org", content: "BODY" }] });
    assert("error" in top && top.error.includes(k), `top-level ${k}`);
    const inItem = parseDoorBody({ ...ok, item: { ...ok.item, [k]: "x" } });
    assert("error" in inItem && inItem.error.includes(k), `item.${k}`);
  }
  assert("error" in parseDoorBody({ ...ok, purpose: "chat" }));
  assert("error" in parseDoorBody({ ...ok, item: { ...ok.item, kind: "email" } }));
  assert("error" in parseDoorBody({ ...ok, item: { ...ok.item, fields: { subject: 1 } } }));
  assert("error" in parseDoorBody({ ...ok, deliver: { x: "y".repeat(5000) } }));
  assertEquals([...PURPOSES].sort(), ["brainstorm-gap", "digest-article", "digest-gap", "idea-research"]);
  assertEquals(parseProposals('{"questions":["a b c", 3, "d e f"]}'), ["a b c", "d e f"]);
  assertEquals(parseProposals("not json"), []);
});

Deno.test("request kinds POST /research records: direct, service (declared callers only), unclassified; never derived", () => {
  const c = (name: string, origin: string, shared = false): Caller => ({ name, origin, key: "k".repeat(16), shared });
  const svc = parseServiceCallers("agent-org, repo-sync,shared-key, bad name");
  assertEquals([...svc].sort(), ["agent-org", "bad", "name", "repo-sync"]);
  assertFalse(svc.has("shared-key"), "the shared key names no caller: never a service");
  assertEquals(requestKindOf(c("owui-tool", "owui"), "user-1", svc), "direct");
  assertEquals(requestKindOf(c("workspace", "workspace"), null, svc), "direct");
  assertEquals(requestKindOf(c("agent-org", "mattermost"), null, svc), "service");
  assertEquals(requestKindOf(c("digest", "notebook"), null, svc), "unclassified");
  assertEquals(requestKindOf(c("shared-key", "manual", true), null, new Set(["shared-key"])), "unclassified");
});

Deno.test("the curator copy's span filter keeps the line structure", () => {
  const prompt = "how does the zqPRMm1a2b3c4d private phrase relate to winter solar roofs";
  const text = "[SOURCED] Studies ask how does the zqPRMm1a2b3c4d private\nphrase relate to winter solar roofs today. [Source 1]\n[SOURCED] Other line. [Source 2]";
  const out = withoutPromptSpansKeepLines(text, prompt);
  assertEquals(out.split("\n").length, text.split("\n").length);
  assertEquals(promptSpans(out, prompt), []);
  assert(out.includes("[Source 1]") && out.includes("Other line. [Source 2]"));
});
