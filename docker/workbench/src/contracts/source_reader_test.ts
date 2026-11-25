// deno test src/contracts/source_reader_test.ts - rwr-source-reader-api, no database: the pure rules that
// place a claim in a source's chunks and name each chunk's section, and the route as a DOCUMENT.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { placeClaim, sectionsFor } from "./logic/source_reader.ts";
import { chunkText } from "../util/chunk.ts";
import { buildDocument } from "./gen.ts";
import { SOURCE_READER_EXAMPLE, SourceReader } from "./schemas/source_reader.ts";

const chunks = (...c: string[]) => c.map((content, idx) => ({ idx, content }));

Deno.test("placeClaim: a verbatim claim gets a span that lies inside its chunk's text", () => {
  const cs = chunks("Alpha beta gamma.", "The  quick brown fox\njumps over the lazy dog. More text.", "Tail.");
  const p = placeClaim("the quick brown fox jumps over the lazy dog", cs)!;
  assertEquals(p.idx, 1);
  assert(p.span !== null);
  const { start, end } = p.span!;
  assert(start >= 0 && end > start && end <= cs[1].content.length);
  assertEquals(cs[1].content.slice(start, end).toLowerCase().replace(/\s+/g, " "), "the quick brown fox jumps over the lazy dog");
});

Deno.test("placeClaim: no verbatim match but most of the words in one chunk = that chunk, no span", () => {
  const cs = chunks("Unrelated opening.", "Contracts own the record states of every source in the library.");
  const p = placeClaim("Record states of every source are owned by contracts", cs)!;
  assertEquals(p.idx, 1);
  assertEquals(p.span, null);
  assert(p.overlap >= 0.6 && p.overlap < 1);
});

Deno.test("placeClaim: nothing close enough = not placed, and a short claim is placed only verbatim", () => {
  const cs = chunks("Alpha fixture text about contract retrieval.", "Beta sentence two.");
  assertEquals(placeClaim("Fixture claim: contracts own record states.", cs), null);
  assertEquals(placeClaim("beta two", cs), null);
  assertEquals(placeClaim("", cs), null);
  assertEquals(placeClaim("anything", []), null);
});

Deno.test("placeClaim: regex characters in a claim are literal text", () => {
  const cs = chunks("Cost is (roughly) $5.00 [approx] per unit.");
  const p = placeClaim("(roughly) $5.00 [approx]", cs)!;
  assertEquals(p.idx, 0);
  assertEquals(cs[0].content.slice(p.span!.start, p.span!.end), "(roughly) $5.00 [approx]");
});

Deno.test("sectionsFor: chunks come back with the heading in force at their start, headings in source order", () => {
  const content = "# Intro\n\nOpening words here.\n\n## Methods\n\nWe measured things carefully. " +
    "x".repeat(1300) + "\n\n## Results\n\nThe numbers were good.\n\n```\n# not a heading\n```\n";
  const cs = chunkText(content).map((c, idx) => ({ idx, content: c }));
  assert(cs.length >= 3);
  const r = sectionsFor(content, cs);
  assertEquals(r.sections.map((s) => s.name), ["Intro", "Methods", "Results"]);
  assertEquals(r.sections.map((s) => s.level), [1, 2, 2]);
  assertEquals(r.chunkSection.length, cs.length);
  assertEquals(r.chunkSection[0], "Intro");
  assertEquals(r.chunkSection[cs.length - 1], "Results");
  // first_chunk_idx never decreases and names a real chunk
  const firsts = r.sections.map((s) => s.first_chunk_idx);
  assert(firsts.every((f) => f !== null && f >= 0 && f < cs.length));
  assert(firsts.every((f, i) => i === 0 || f! >= firsts[i - 1]!));
});

Deno.test("sectionsFor: text with no headings has no sections and every chunk's section is null", () => {
  const cs = chunks("Plain text only.", "More plain text.");
  const r = sectionsFor("Plain text only. More plain text.", cs);
  assertEquals(r.sections, []);
  assertEquals(r.chunkSection, [null, null]);
});

Deno.test("sectionsFor: chunks that cannot be found in the content (edited since) keep the last section, no error", () => {
  const r = sectionsFor("# A\n\nsome words", chunks("some words", "totally different stored text"));
  assertEquals(r.chunkSection, ["A", "A"]);
});

Deno.test("the route is in the contract, a plain read, not an MCP tool, and its example validates", () => {
  const doc = buildDocument() as { paths: Record<string, Record<string, Record<string, unknown>>> };
  const op = doc.paths["/workbench/contract/sources/{id}/reader"]?.get;
  assert(op, "GET /workbench/contract/sources/{id}/reader is not in the generated document");
  assertEquals(op.operationId, "sourceReader");
  assertEquals(op["x-mcp-tool"], undefined, "private text must not be an MCP/cloud-door tool");
  const r = SourceReader.safeParse(SOURCE_READER_EXAMPLE);
  assert(r.success, JSON.stringify(r.error?.issues));
});

// ---- the private-view rule (PD1 / identity/private_view.ts D2): attempt-1 Case 2 (T2b, T2c) ----
// A private source is read ONLY by a signed-in user acting as themselves. An admin impersonating the owner (T2b) and
// openbrain-mcp acting on the owner's behalf (T2c) get the very answer a missing source gets (null -> the one 404),
// and no private query is even sent for them. Over a fake Db that WOULD hand the private source to anyone who asks.
import { sourceReader } from "./repo/source_reader.ts";
import type { Db } from "./db.ts";
import type { Identity } from "../middleware/identity.ts";
import type { PrivateViewConfig } from "../identity/private_view.ts";

const OWNER = "sub-owner-1";
function fakeDb(sent: string[]): Db {
  const db: Db = {
    query: (sql: string) => {
      sent.push(sql);
      if (sql.includes("inlet_private_source(")) return Promise.resolve([{ id: "s1", title: "T", url: null, content: "PRIVMARK" }] as never);
      if (sql.includes("inlet_private_reader_chunks")) return Promise.resolve([{ idx: 0, content: "PRIVMARK" }] as never);
      return Promise.resolve([] as never);
    },
    tx: (fn: (d: Db) => Promise<unknown>) => fn(db),
  } as unknown as Db;
  return db;
}
const ID_USER: Identity = { sub: OWNER, actor: OWNER, name: OWNER, key: OWNER, kind: "user", admin: false, impersonating: null };
const ID_ADMIN_AS: Identity = { sub: OWNER, actor: "admin-9", name: OWNER, key: OWNER, kind: "user", admin: true, impersonating: { reason: "t", since: "2026-11-25T00:00:00Z" } };
const ID_MCP_FOR: Identity = { sub: OWNER, actor: "service:mcp", name: OWNER, key: OWNER, kind: "on-behalf", admin: false, impersonating: null };
const ID_OWUI_FOR: Identity = { ...ID_MCP_FOR, actor: "service:owui" };
const ID_SERVICE: Identity = { sub: "service:mcp", actor: "service:mcp", name: "mcp", key: "k", kind: "service", admin: false, impersonating: null };
const ID_HEADER: Identity = { ...ID_USER, kind: "header" };
const SIGNIN: PrivateViewConfig = { signIn: true, defaultSub: "" };
const asReader = (who: Identity | undefined, cfg: PrivateViewConfig, sent: string[]) =>
  sourceReader(fakeDb(sent), "00000000-0000-0000-0000-0000000000aa", { evidenceOnly: false, visible: new Set(), filter: null, who: who as Identity, privateView: cfg } as never);

Deno.test("private reader: the signed-in owner acting as themselves reads their private source (control)", async () => {
  const sent: string[] = [];
  const r = await asReader(ID_USER, SIGNIN, sent);
  assert(r && r.private === true && r.chunks.length === 1);
});

Deno.test("private reader T2b: an admin impersonating the owner gets null (the missing-source 404) and no private query is sent", async () => {
  const sent: string[] = [];
  assertEquals(await asReader(ID_ADMIN_AS, SIGNIN, sent), null);
  assert(!sent.some((q) => q.includes("inlet_private")), "a private read was sent for an impersonating admin");
});

Deno.test("private reader T2c: openbrain-mcp / owui acting on behalf of the owner gets null and no private query is sent", async () => {
  for (const who of [ID_MCP_FOR, ID_OWUI_FOR]) {
    const sent: string[] = [];
    assertEquals(await asReader(who, SIGNIN, sent), null);
    assert(!sent.some((q) => q.includes("inlet_private")), "a private read was sent for an on-behalf caller");
  }
});

Deno.test("private reader: a service, a header identity, no identity, and the default identity while sign-in is on get null", async () => {
  for (const who of [ID_SERVICE, ID_HEADER, undefined]) assertEquals(await asReader(who, SIGNIN, []), null);
  const dflt: Identity = { sub: "dflt", actor: "dflt", name: "d", key: "d", kind: "default", admin: false, impersonating: null };
  assertEquals(await asReader(dflt, SIGNIN, []), null);
});

Deno.test("private reader: with sign-in off, only the default identity named by WORKSPACE_DEFAULT_SUB reads", async () => {
  const cfg: PrivateViewConfig = { signIn: false, defaultSub: "dflt" };
  const dflt: Identity = { sub: "dflt", actor: "dflt", name: "d", key: "d", kind: "default", admin: false, impersonating: null };
  assert(await asReader(dflt, cfg, []) !== null);
  assertEquals(await asReader(ID_HEADER, cfg, []), null);
  assertEquals(await asReader({ ...dflt, sub: "other", actor: "other" }, cfg, []), null);
  assertEquals(await asReader(dflt, { signIn: false, defaultSub: "" }, []), null);
});
