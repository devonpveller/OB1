// deno test src/contracts/contract_test.ts - the contract as a DOCUMENT, no database:
// coverage of the panel-library appendix, the registry rule (no closed lists), every example
// validating against its schema, generated artifacts current, typed stubs, the D12 listing
// shape, the notification event described.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createContractApp } from "./app.ts";
import { buildAll, buildDocument } from "./gen.ts";
import { RegistryReader, REGISTRY } from "./registry.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import type { Db } from "./db.ts";
import { DocumentListing } from "./schemas/ideas.ts";
import { NotImplemented } from "./schemas/common.ts";
import { DiffCheck, DiffCheckResult } from "./schemas/sources.ts";
import { EX } from "./schemas/examples.ts";

type J = Record<string, unknown>;
const noDb: Db = { query: () => Promise.reject(new Error("no db")), tx: () => Promise.reject(new Error("no db")) };
const app = () =>
  createContractApp({
    db: noDb, registry: new RegistryReader(noDb), scorer: unavailableScorer, embed: () => Promise.reject(new Error("x")),
    chunk: () => [], mountsRoot: "/mounts", streamPollMs: 10, log: () => {},
  });
const doc = buildDocument() as J;
const ops = (): { path: string; method: string; op: J }[] =>
  Object.entries(doc.paths as Record<string, Record<string, J>>).flatMap(([path, item]) =>
    Object.entries(item).map(([method, op]) => ({ path, method, op }))
  );

// The appendix of journal/notes/research-panel-library-2026-09-18.md, verbatim.
const APPENDIX = [
  "reference", "chunkContext", "diffCheck", "neighbours", "quality", "claims", "session", "stream", "steer",
  "timeline", "trail", "search", "jobs", "watches", "proposals", "stanceMap", "podcasts", "presenters", "teams",
];

Deno.test("every appendix call is in the OpenAPI document with request and response schemas", () => {
  const byCall = new Map(ops().filter((o) => o.op["x-appendix-call"]).map((o) => [o.op["x-appendix-call"], o]));
  const missing = APPENDIX.filter((c) => !byCall.has(c));
  assertEquals(missing, [], `appendix calls missing from /openapi.json: ${missing.join(", ")}`);
  for (const call of APPENDIX) {
    const { op } = byCall.get(call)!;
    const responses = op.responses as Record<string, J>;
    const ok = Object.entries(responses).find(([code]) => /^(2\d\d|501)$/.test(code));
    assert(ok, `${call}: no 2xx/501 response`);
    const content = ok[1].content as Record<string, J>;
    assert(Object.values(content).every((m) => m.schema), `${call}: response without a schema`);
    const needsBody = op.requestBody !== undefined;
    if (needsBody) assert(((op.requestBody as J).content as Record<string, J>)["application/json"].schema, `${call}: body without schema`);
  }
});

Deno.test("no closed list anywhere: no enum, const, anyOf, allOf or oneOf in the document", () => {
  const s = JSON.stringify(doc);
  for (const k of ["enum", "const", "anyOf", "allOf", "oneOf"]) {
    assertEquals(s.includes(`"${k}":`), false, `the document contains "${k}" - an enumerated kind must be a registry`);
  }
});

Deno.test("every x-registry annotation names a declared registry", () => {
  const declared = new Set(Object.values(REGISTRY));
  const seen = new Set<string>();
  JSON.stringify(doc, (k, v) => {
    if (k === "x-registry") seen.add(v);
    return v;
  });
  assert(seen.size >= 15, `expected the contract to reference many registries, saw ${seen.size}`);
  for (const r of seen) assert(declared.has(r as never), `x-registry '${r}' is not declared in registry.ts`);
});

Deno.test("every registry in registry.ts is seeded by the migrations (when the migrations are reachable)", async () => {
  let sql: string;
  try {
    // P0's contract registries, and P2a's reference registries (init-references.sql)
    sql = await Deno.readTextFile(new URL("../../../init-research-contract.sql", import.meta.url)) +
      await Deno.readTextFile(new URL("../../../init-references.sql", import.meta.url));
  } catch {
    return; // inside the image the migrations are not in the build context
  }
  for (const r of Object.values(REGISTRY)) assert(sql.includes(`('${r}',`), `registry ${r} is not declared in a contract migration`);
});

Deno.test("every request and response example validates against its zod schema", () => {
  const defs = (app().openAPIRegistry.definitions as J[]).filter((d) => d.type === "route");
  let checked = 0;
  for (const d of defs) {
    const route = d.route as J;
    const bodies: [string, J][] = [];
    const req = (route.request as J | undefined)?.body as J | undefined;
    if (req) bodies.push([`${route.operationId} request`, (req.content as Record<string, J>)["application/json"]]);
    for (const [code, r] of Object.entries(route.responses as Record<string, J>)) {
      for (const [mime, m] of Object.entries((r.content ?? {}) as Record<string, J>)) {
        if (mime === "application/json") bodies.push([`${route.operationId} ${code}`, m]);
      }
    }
    for (const [label, m] of bodies) {
      if (m.example === undefined) continue;
      const res = (m.schema as { safeParse: (x: unknown) => { success: boolean; error?: unknown } }).safeParse(m.example);
      assert(res.success, `${label}: example does not validate: ${String(JSON.stringify(res.error ?? res)).slice(0, 600)}`);
      checked++;
    }
  }
  assert(checked >= 40, `only ${checked} examples checked`);
});

Deno.test("diffCheck carries out_of_date and the equivalent current chunk id; its example validates", () => {
  const props = Object.keys(DiffCheckResult.shape);
  assert(props.includes("out_of_date") && props.includes("equivalent_current_chunk_id"));
  const ok = DiffCheck.safeParse(EX.diffCheck);
  assert(ok.success);
  assertEquals(EX.diffCheck.results[0].out_of_date, true);
  assert(typeof EX.diffCheck.results[0].equivalent_current_chunk_id === "string");
  const without = { results: [{ ...EX.diffCheck.results[0], out_of_date: undefined }] };
  assertEquals(DiffCheck.safeParse(without).success, false, "a result without out_of_date must not validate");
});

Deno.test("generated artifacts (openapi.json, types.ts, mcp-tools.json and its openbrain-mcp copy) are current", async () => {
  const want = buildAll();
  const files: [string, URL][] = [
    ["openapi", new URL("generated/openapi.json", import.meta.url)],
    ["types", new URL("generated/types.ts", import.meta.url)],
    ["mcp", new URL("generated/mcp-tools.json", import.meta.url)],
    ["mcpCopy", new URL("../../../../integrations/kubernetes-deployment/contract-tools.json", import.meta.url)],
  ];
  for (const [k, u] of files) {
    let have: string;
    try {
      have = (await Deno.readTextFile(u)).replace(/\r\n/g, "\n");
    } catch {
      if (k === "mcpCopy") continue; // outside the image build context
      throw new Error(`${u.pathname} is missing - run deno task contract:gen`);
    }
    assertEquals(have, want[k as keyof typeof want], `${u.pathname} is stale - run deno task contract:gen`);
  }
});

Deno.test("calls whose backing lands later answer a typed not_implemented that validates", async () => {
  const a = app();
  const stubs: [string, string][] = [
    ["GET", "/workbench/contract/watches"],
    ["GET", "/workbench/contract/watches/f0000000-0000-4000-8000-0000000000f2/proposals"],
    ["GET", "/workbench/contract/stance-maps/99999999-9999-4999-8999-999999999999"],
    ["GET", "/workbench/contract/podcasts"],
    ["GET", "/workbench/contract/presenters"],
    ["GET", "/workbench/contract/teams"],
  ];
  for (const [method, path] of stubs) {
    const r = await a.request(path, { method });
    assertEquals(r.status, 501, path);
    const b = await r.json();
    assert(NotImplemented.safeParse(b).success, `${path}: ${JSON.stringify(b)}`);
    assertEquals(b.status, "not_implemented");
  }
  const steer = await a.request("/workbench/contract/sessions/99999999-9999-4999-8999-999999999999/steer", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ step_id: "s", text: "t" }),
  });
  assertEquals(steer.status, 501);
});

Deno.test("D12: the document listing is exactly title, path, updated, outbound links - a body cannot pass", () => {
  assertEquals(Object.keys(DocumentListing.shape).sort(), ["outbound_links", "path", "title", "updated"]);
  const row = { title: "t", path: "documents/x.md", updated: "2026-10-17T12:00:00.000Z", outbound_links: [] };
  assert(DocumentListing.safeParse(row).success);
  assertEquals(DocumentListing.safeParse({ ...row, body: "the user's text" }).success, false);
  const s = JSON.stringify((doc.components as J).schemas);
  const listing = JSON.stringify(((doc.components as J).schemas as J).DocumentListing);
  assert(!/"(body|content)"/.test(listing), "the listing schema names a body field");
  assert(s.includes('"DocumentListing"'));
});

Deno.test("the notification event is described: class, subject, slug, entity, origin, error, first seen, count", () => {
  const n = ((doc.components as J).schemas as J).Notification as J;
  const props = Object.keys(n.properties as J);
  for (const f of ["class", "subject", "slug", "entity", "origin", "error", "first_seen", "last_seen", "count"]) {
    assert(props.includes(f), `Notification lacks ${f}`);
  }
  assertEquals(((n.properties as J).class as J)["x-registry"], "notification_classes");
  const hasRead = ops().some((o) => o.op.operationId === "notifications" && o.method === "get");
  const hasWrite = ops().some((o) => String(o.path).includes("notifications") && o.method !== "get");
  assert(hasRead && !hasWrite, "notifications: a read endpoint and no write endpoint");
});

Deno.test("MCP exposes reads only (D14): every x-mcp-tool is a non-mutating operation", () => {
  const MUTATING = new Set(["suppress", "sever", "erase", "liftTombstone", "admission", "setHidden", "addUserSource",
    "removeUserSource", "writeSetting", "steer", "createReference"]);
  for (const { op } of ops()) {
    if (op["x-mcp-tool"]) assert(!MUTATING.has(op.operationId as string), `${op.operationId} is a write on MCP`);
  }
});

// ── static checks over the code (skipped where the tree is not reachable, e.g. in the image) ──
async function* walk(dir: URL): AsyncGenerator<URL> {
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
      if (e.isDirectory) yield* walk(u);
      else yield u;
    }
  } catch { /* unreadable: skip */ }
}

Deno.test("no write path to ideas or idea_revisions in the contract (the MCP idea tools stay the only writers)", async () => {
  const bad: string[] = [];
  for await (const u of walk(new URL("./", import.meta.url))) {
    if (!u.pathname.endsWith(".ts") || u.pathname.endsWith("_test.ts")) continue;
    const src = await Deno.readTextFile(u);
    if (/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(public\.)?(ideas|idea_revisions)\b/i.test(src)) bad.push(u.pathname);
  }
  assertEquals(bad, [], `a contract module writes ideas: ${bad.join(", ")}`);
});

Deno.test("the podcast archive path appears only in the compose mount (D6 item 5: no hardcoded destination)", async () => {
  const ob1 = new URL("../../../../", import.meta.url); // OB1/
  try {
    await Deno.stat(new URL("docker/docker-compose.yml", ob1));
  } catch {
    return; // not in the image's build context
  }
  const hits: string[] = [];
  for await (const u of walk(ob1)) {
    if (!/\.(ts|mjs|js|py|sql|ya?ml|json|toml|ps1|sh)$|\.env/.test(u.pathname)) continue;
    const text = await Deno.readTextFile(u).catch(() => "");
    text.split("\n").forEach((l, i) => {
      if (/backups}?[\/]+podcasts/i.test(l)) hits.push(`${u.pathname.split("/OB1/")[1]}:${i + 1}: ${l.trim()}`);
    });
  }
  const mounts = hits.filter((h) => h.startsWith("docker/docker-compose.yml") && /:\/mounts\/podcast-archive:ro\s*$/.test(h));
  assertEquals(mounts.length, 1, `expected exactly one compose mount line, got: ${hits.join(" | ")}`);
  assertEquals(hits.length, 1, `the archive path appears outside the mount: ${hits.join(" | ")}`);
});
