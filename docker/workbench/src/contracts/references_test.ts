// deno test src/contracts/references_test.ts - the P2a reference record WITHOUT a database:
// the legacy citation grammars against literal copies of the retired readers, the export numbering,
// whole-source anchors, the selector schemas (a reference without a quote fails), the diffCheck
// request/response shapes (no chunk text), and the migration SQL's shape.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  anchorText, deriveWholeSourceSelectors, exportOrder, frontmatterSources, noteRefsCited, planLegacyHolders,
  requiredSelectorKinds, wholeSourceQuote,
} from "./logic/citations.ts";
import { ReferenceCreateRequest, ReferenceRecord, Selectors } from "./schemas/references.ts";
import { DiffCheck, DiffCheckRef, DiffCheckRequest, Reference } from "./schemas/sources.ts";
import { DocumentLink } from "./schemas/ideas.ts";
import { buildDocument } from "./gen.ts";
import { EX } from "./schemas/examples.ts";

type J = Record<string, any>;

// ── the retired readers, VERBATIM from OB1 a28e9db (routes/note-refs.ts, routes/export.ts),
// with their one SQL query replaced by an in-memory table that behaves like Postgres: rows are
// returned keyed by id::text (lower case) and a non-uuid in the array fails the cast. ─────────
interface Row { id: string; title: string; url: string | null; content_type: string; suppressed?: boolean }

function pgUuid(s: string): boolean {
  let t = s;
  if (t.startsWith("{") && t.endsWith("}")) t = t.slice(1, -1);
  let digits = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (/[0-9a-fA-F]/.test(ch)) digits++;
    else if (ch === "-" && digits > 0 && digits % 4 === 0 && i + 1 < t.length && t[i + 1] !== "-") continue;
    else return false;
  }
  return digits === 32;
}

function table(rows: Row[]) {
  return (uuids: string[], activeOnly: boolean): Row[] => {
    if (!uuids.every(pgUuid)) throw new Error("invalid input syntax for type uuid");
    const want = new Set(uuids.map((u) => u.toLowerCase()));
    return rows.filter((r) => want.has(r.id) && (!activeOnly || !r.suppressed));
  };
}

const L_UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const L_BODY_SOURCE_RE = /\[\[[^\]]*source\/([0-9a-fA-F-]{36})/g;
function lSplitFrontmatter(content: string): { fm: string; body: string } {
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---", 4);
    if (end !== -1) {
      const nl = content.indexOf("\n", end + 4);
      const fmEnd = nl === -1 ? content.length : nl + 1;
      return { fm: content.slice(0, fmEnd), body: content.slice(fmEnd) };
    }
  }
  return { fm: "", body: content };
}
function lReadAddedSources(fm: string): string[] {
  const m = fm.match(/^sources:\s*\[([^\]]*)\]\s*$/m);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter((s) => L_UUID_RE.test(s));
}
function legacyGather(content: string, q: ReturnType<typeof table>) {
  const resolve = (uuids: string[]) => {
    if (!uuids.length) return [];
    let rows: Row[] = [];
    try {
      rows = q(uuids, false);
    } catch {
      rows = [];
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    return uuids.map((u) => byId.get(u)).filter(Boolean) as Row[];
  };
  const { fm, body } = lSplitFrontmatter(content);
  const added = lReadAddedSources(fm);
  const addedSet = new Set(added);
  const cited: string[] = [];
  let m: RegExpExecArray | null;
  L_BODY_SOURCE_RE.lastIndex = 0;
  while ((m = L_BODY_SOURCE_RE.exec(body))) {
    const u = m[1];
    if (!addedSet.has(u) && !cited.includes(u)) cited.push(u);
  }
  return { added: resolve(added).map((r) => r.id), cited: resolve(cited).map((r) => r.id) };
}
const L_SOURCE_LINK_RE = /\[\[([^\]|]*?source\/([0-9a-fA-F-]{36}))(?:\|([^\]]+))?\]\]/g;
// The legacy export's numbering (its applyCitations enrol step, verbatim). Its rendering - inline
// [N] markers and a plain References list - is retired by P6a (citeproc renders the holder numbers);
// what P2a still owes is the NUMBERS, so they are what is compared.
function legacyNumbering(md: string): Map<string, number> {
  const order: string[] = [];
  const numFor = new Map<string, number>();
  const enrol = (u: string) => {
    if (L_UUID_RE.test(u) && !numFor.has(u)) {
      order.push(u);
      numFor.set(u, order.length);
    }
  };
  let m: RegExpExecArray | null;
  L_SOURCE_LINK_RE.lastIndex = 0;
  while ((m = L_SOURCE_LINK_RE.exec(md))) enrol(m[2]);
  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const sm = fmMatch[1].match(/^sources:\s*\[([^\]]*)\]\s*$/m);
    if (sm) sm[1].split(",").forEach((s) => enrol(s.trim().replace(/^["']|["']$/g, "")));
  }
  return numFor;
}

// ── the P2a path, as the repository runs it (the SQL parts as in-memory equivalents) ─────────
function p2a(content: string, rows: Row[]) {
  const plan = planLegacyHolders(content, frontmatterSources(content));
  // resolution: id::text = the id as written (case-sensitive), as repo/references.ts sourceTargets
  const byText = new Map(rows.map((r) => [r.id, r]));
  const held = plan.holders.map((h) => ({ ...h, target: byText.get(h.cited_ref) ?? null }));
  const view = {
    added: held.filter((h) => h.target && h.origin === "added").map((h) => h.target!.id),
    cited: held.filter((h) => h.target && h.origin !== "added").map((h) => h.target!.id),
  };
  const numbered = held.filter((h) => h.number !== null).sort((a, b) => a.number! - b.number!);
  const numberOf = new Map(numbered.map((h) => [h.cited_ref, h.number!]));
  return { plan, view, numberOf };
}

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444"; // suppressed
const U = "99999999-9999-4999-8999-999999999999"; // resolves to nothing
const ROWS: Row[] = [
  { id: A, title: "Alpha source", url: "https://example.org/a", content_type: "web_article" },
  { id: B, title: "Beta\nsource", url: null, content_type: "web_article" },
  { id: C, title: "", url: "https://example.org/c", content_type: "pdf" },
  { id: D, title: "Suppressed source", url: "https://example.org/d", content_type: "web_article", suppressed: true },
];
const CORPUS: Record<string, string> = {
  "cited with aliases, repeated": `# T\n\nSee [[content/source/${A}|S1]] and [[content/source/${B}|S2]], again [[content/source/${A}|S1]].\n`,
  "frontmatter added, one also cited": `---\ntitle: "n"\nsources: [${C}, "${A}"]\n---\n\nBody [[source/${A}]] and [[source/${B}|b]].\n`,
  "bare link without alias": `Text [[source/${B}]].`,
  "anchor link (note-refs counts it, export does not number it)": `x [[content/source/${A}#part|S1]] y [[source/${B}|S2]]`,
  "alias before the target": `x [[see|source/${A}]] y`,
  "upper-case uuid (the legacy resolver never matched it)": `x [[source/${A.toUpperCase()}|S]] y [[source/${B}|T]]`,
  "unresolved id keeps its number": `a [[source/${U}|u]] b [[source/${A}|a]] c\n`,
  "suppressed source: listed, numbered, not in References": `a [[source/${D}|d]] b [[source/${B}|b]]`,
  "triple bracket": `x [[[content/source/${A}|S1]]] y`,
  "no frontmatter, no links": `Just text with [[tool-postgresql]] and [[a/b|c]].`,
  "crlf frontmatter is not frontmatter": `---\r\nsources: [${A}]\r\n---\r\nbody [[source/${B}]]`,
  "empty sources list": `---\nsources: []\n---\nbody`,
  "frontmatter only": `---\ntitle: x\nsources: [${A}, ${B}]\n---\n`,
  "id in frontmatter and in an anchor link": `---\nsources: [${B}]\n---\n[[source/${A}#x]] [[source/${B}|b]] [[source/${C}]]`,
};

Deno.test("P2a holders reproduce what the legacy note-refs listed, for every corpus note", () => {
  const q = table(ROWS);
  for (const [name, content] of Object.entries(CORPUS)) {
    const legacy = legacyGather(content, q);
    const { view, plan } = p2a(content, ROWS);
    assertEquals(plan.unstorable, [], name);
    assertEquals(view, legacy, `${name}: note-refs lists differ`);
  }
});

Deno.test("P2a holder numbers are the legacy export's citation numbers, for every corpus note", () => {
  for (const [name, content] of Object.entries(CORPUS)) {
    assertEquals([...p2a(content, ROWS).numberOf], [...legacyNumbering(content)], name);
  }
});

Deno.test("a note the legacy reader could not resolve is flagged unstorable (the migration refuses it)", () => {
  const junk = "1111111111111111111111111111111111-1"; // 36 chars of the body grammar, not a uuid
  const content = `x [[source/${junk}]] y [[source/${A}|a]]`;
  const legacy = legacyGather(content, table(ROWS));
  assertEquals(legacy.cited, [], "the legacy cast failure emptied the whole cited list");
  assertEquals(planLegacyHolders(content, []).unstorable, [junk]);
});

Deno.test("numbering: cited by first appearance, then added; seq is added first, then cited", () => {
  const content = `---\nsources: [${C}]\n---\n[[source/${B}|b]] [[source/${A}|a]] [[source/${B}|b]]`;
  const plan = planLegacyHolders(content, frontmatterSources(content));
  assertEquals(plan.holders.map((h) => [h.cited_ref, h.origin, h.seq, h.number]), [
    [C, "added", 0, 3], [B, "cited", 1, 1], [A, "cited", 2, 2],
  ]);
  assertEquals(exportOrder(content, [C]), [B, A, C]);
  assertEquals(noteRefsCited(content, [C]), [B, A]);
});

// ── whole-source anchors ───────────────────────────────────────────────────────────────────
Deno.test("a whole-source quote is the opening of the pinned text, and its position selects it", () => {
  for (const text of [
    "Short text.",
    "   Leading blanks then text.",
    "A ".repeat(200) + "end",
    "x".repeat(400),
    "Line one.\nLine two continues for a while so that the opening span has to be cut at a word boundary somewhere in the middle of it all.",
  ]) {
    const { quote, position } = wholeSourceQuote({ text, field: "content" });
    assert(quote.exact.length > 0 && quote.exact.length <= 160, `exact length ${quote.exact.length}`);
    assertEquals(text.slice(position.start, position.end), quote.exact);
    assertEquals(text.slice(Math.max(0, position.start - 32), position.start), quote.prefix);
    assertEquals(text.slice(position.end, position.end + 32), quote.suffix);
    assert(!/\s$/.test(quote.exact) && !/^\s/.test(quote.exact));
  }
  assertEquals(anchorText("", "Only a title"), { text: "Only a title", field: "title" });
  assertEquals(anchorText("  ", ""), null);
});

const KINDS = [
  { key: "quote", definition: { required: "always" } },
  { key: "position", definition: { required: "always" } },
  { key: "pdf", definition: { required_for_content_types: ["pdf"] } },
  { key: "fragment", definition: { required_for_content_types: ["web_article"] }, retired_at: "2026-10-17" },
];

Deno.test("required selector kinds come from the registry: pdf only for pdf; a retired kind never", () => {
  assertEquals(requiredSelectorKinds(KINDS, "web_article"), ["position", "quote"]);
  assertEquals(requiredSelectorKinds(KINDS, "pdf"), ["pdf", "position", "quote"]);
  const pdf = deriveWholeSourceSelectors({ text: "Page text.", field: "content" }, ["pdf", "position", "quote"]);
  assertEquals((pdf.pdf as J).page, 1);
  assertEquals((pdf.pdf as J).quads, [[0, 0, 1, 0, 1, 1, 0, 1]]);
  assert(Selectors.safeParse(pdf).success);
  assertThrows(() => deriveWholeSourceSelectors({ text: "t", field: "content" }, ["video"]), Error, "no whole-source deriver");
});

// ── schemas: a reference without a quote FAILS ─────────────────────────────────────────────
const sel = { quote: { exact: "Alpha", prefix: "", suffix: " beta" }, position: { start: 0, end: 5 } };

Deno.test("a reference without a quote selector (or with an empty one, or without prefix/suffix) fails validation", () => {
  const req = { source_id: A, provenance: "user", selectors: sel };
  assert(ReferenceCreateRequest.safeParse(req).success);
  const { quote: _q, ...noQuote } = sel;
  assertEquals(ReferenceCreateRequest.safeParse({ ...req, selectors: noQuote }).success, false, "no quote");
  assertEquals(ReferenceCreateRequest.safeParse({ ...req, selectors: { ...sel, quote: { ...sel.quote, exact: "" } } }).success, false, "empty exact");
  assertEquals(ReferenceCreateRequest.safeParse({ ...req, selectors: { ...sel, quote: { exact: "Alpha" } } }).success, false, "no prefix/suffix");
  const { position: _p, ...noPos } = sel;
  assertEquals(ReferenceCreateRequest.safeParse({ ...req, selectors: noPos }).success, false, "no position");
  assertEquals(ReferenceCreateRequest.safeParse({ ...req, selectors: { ...sel, position: { start: 5, end: 2 } } }).success, false, "end < start");
  assertEquals(Selectors.safeParse({ ...sel, pdf: { page: 1, quads: [[0, 0, 1]] } }).success, false, "a quad is 8 numbers");
  assertEquals(Selectors.safeParse({ ...sel, pdf: { page: 0, quads: [[0, 0, 1, 0, 1, 1, 0, 1]] } }).success, false, "pages start at 1");
  assert(Selectors.safeParse({ ...sel, pdf: { page: 2, quads: [[0, 0, 1, 0, 1, 1, 0, 1]] } }).success);
  assertEquals(ReferenceRecord.safeParse({ ...EX.referenceCreated.record, selectors: noQuote }).success, false, "a record without a quote");
});

Deno.test("the OpenAPI document requires quote (exact, prefix, suffix) and position on every reference", () => {
  const doc = buildDocument() as J;
  const rec = doc.components.schemas.ReferenceRecord;
  assert(rec.required.includes("selectors") && rec.required.includes("pinned_revision") && rec.required.includes("provenance"));
  const s = rec.properties.selectors;
  assertEquals(s.required.sort(), ["position", "quote"]);
  assertEquals(s.properties.quote.required.sort(), ["exact", "prefix", "suffix"]);
  assertEquals(s.properties.quote.properties.exact.minLength, 1);
  assertEquals(rec.properties.provenance["x-registry"], "reference_provenances");
  assertEquals(rec.properties.scope["x-registry"], "reference_scopes");
  assertEquals(rec.properties.state["x-registry"], "reference_states");
});

// ── diffCheck: two forms, one shape; no text in the response ─────────────────────────────
Deno.test("diffCheck takes a reference id or a bare pin, never both; references or a holder, never both", () => {
  assert(DiffCheckRef.safeParse({ reference_id: A }).success);
  assert(DiffCheckRef.safeParse({ source_id: A, revision: 1 }).success);
  assert(DiffCheckRef.safeParse({ source_id: A, revision: 1, chunk_idx: 0 }).success);
  assertEquals(DiffCheckRef.safeParse({ reference_id: A, source_id: A, revision: 1 }).success, false);
  assertEquals(DiffCheckRef.safeParse({ reference_id: A, chunk_idx: 1 }).success, false);
  assertEquals(DiffCheckRef.safeParse({ source_id: A }).success, false);
  assertEquals(DiffCheckRef.safeParse({}).success, false);
  assert(DiffCheckRequest.safeParse({ holder: { kind: "legacy_note", ref: "notes/x.md" } }).success);
  assertEquals(DiffCheckRequest.safeParse({ holder: { kind: "legacy_note", ref: "notes/x.md" }, references: [{ reference_id: A }] }).success, false);
  assertEquals(DiffCheckRequest.safeParse({}).success, false);
  assertEquals(DiffCheckRequest.safeParse({ references: Array.from({ length: 201 }, () => ({ reference_id: A })) }).success, false);
  assert(DiffCheckRequest.safeParse({ references: Array.from({ length: 200 }, () => ({ reference_id: A })) }).success);
});

Deno.test("the diffCheck response schema carries no text: ids, revisions, states and an anchor outcome only", () => {
  const doc = buildDocument() as J;
  const r = doc.components.schemas.DiffCheckResult;
  const fields = Object.keys(r.properties).sort();
  assertEquals(fields, ["anchor", "chunk_idx", "current_revision", "equivalent_current_chunk_id", "lifecycle",
    "out_of_date", "pinned_revision", "reference_id", "source_id", "state"]);
  for (const f of ["content", "text", "excerpt", "exact", "quote", "selectors", "title"]) assert(!fields.includes(f), f);
  assertEquals(r.properties.anchor["x-registry"], "reference_anchor_outcomes");
  assert(DiffCheck.safeParse(EX.diffCheck).success);
  assertEquals(EX.diffCheck.results[0].anchor, "requoted");
});

Deno.test("reference(id) is one shape for a record and for a source; a document link points at a record", () => {
  assert(Reference.safeParse(EX.referenceRecord).success);
  assertEquals(EX.referenceRecord.kind, "reference");
  assertEquals(EX.referenceRecord.requested_version, EX.referenceRecord.record.pinned_revision);
  assert(Reference.safeParse(EX.reference).success);
  assertEquals(EX.reference.record, null);
  assert(DocumentLink.safeParse({ kind: "source", id: A, pin: 2, reference_id: B }).success);
  assertEquals(DocumentLink.safeParse({ kind: "source", id: A, pin: 2, reference_id: B, quote: "copied text" }).success, false,
    "a document link holds ids, never a copy");
});

// ── the migration SQL (skipped where the file is not reachable, e.g. in the image) ──────────
async function readSql(name: string): Promise<string | null> {
  try {
    return (await Deno.readTextFile(new URL(`../../../${name}`, import.meta.url))).replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}
const fnBody = (sql: string) => {
  const m = /CREATE OR REPLACE FUNCTION public\.source_dependence\(p_source_id UUID\)[\s\S]*?\$\$([\s\S]*?)\$\$;/.exec(sql);
  return m ? m[1] : null;
};

Deno.test("source_dependence: P2a keeps every P0 branch verbatim and adds reference_record; the revert restores P0's", async () => {
  const p0 = await readSql("init-research-contract.sql");
  const p2a = await readSql("init-references.sql");
  const rev = await readSql("revert-references.sql");
  if (!p0 || !p2a || !rev) return;
  const [a, b, c] = [fnBody(p0)!, fnBody(p2a)!, fnBody(rev)!];
  const branches = a.split(/\n\s*UNION ALL\n/).map((x) => x.trim());
  for (const br of branches) assert(b.includes(br), `P2a dropped a P0 branch: ${br.slice(0, 80)}`);
  assert(b.includes("'reference_record'"));
  assertEquals(c.trim(), a.trim(), "the revert must restore P0's function exactly");
});

Deno.test("the reference rule lives in the database: a trigger refuses a missing selector, no table copies a body", async () => {
  const sql = await readSql("init-references.sql");
  if (!sql) return;
  assert(/CREATE TRIGGER trg_reference_records_validate\s+BEFORE INSERT OR UPDATE ON public\.reference_records/.test(sql));
  assert(sql.includes("reference_selectors_problem(NEW.selectors, ct)"));
  assert(/'quote', 'text quote[^']*',\s*'\{"required":"always"/.test(sql), "quote is declared required");
  // the holder rows carry ids and order; nothing in P2a stores note text
  const tables = sql.match(/CREATE TABLE IF NOT EXISTS public\.reference_\w+ \([\s\S]*?\n\);/g) ?? [];
  assertEquals(tables.length, 3);
  for (const t of tables) assert(!/\b(body|content|text)\s+TEXT/i.test(t), `a reference table stores text: ${t.slice(0, 60)}`);
  assert(!/\b(claims|claim_sources)\b/.test(sql.replace(/--.*$/gm, "").replace(/source_dependence\(p_source_id UUID\)[\s\S]*?\$\$;/, "")),
    "P2a must not touch the grounding chain outside the dependence read");
});
