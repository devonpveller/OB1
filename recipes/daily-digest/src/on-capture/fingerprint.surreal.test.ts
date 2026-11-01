// The quiesce fingerprint against a REAL SurrealDB 2.6 (the pinned image) holding the live failure's
// shape (rw-p7a-tts capture-fix, 2026-10-31): a `source` row whose full_text contains a NUL byte. The live
// capture died on it - SurrealDB's JSON responder refuses to serialise that string ("Serialization
// error: to be serialized string contained a null byte", HTTP 400), so ANY statement that returns the
// row's text over /sql fails, `SELECT *` included. The row can only be written with a binary protocol
// (the Python SDK uses CBOR), so this test writes it the same way: CBOR over /rpc.
//
// SKIPPED unless FINGERPRINT_SURREAL_URL is set (a DISPOSABLE lab SurrealDB, root user, password in
// FINGERPRINT_SURREAL_PASS). Never point it at a live datastore: it writes.
//   deno test --allow-net --allow-env src/on-capture/fingerprint.surreal.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { changed, fingerprint } from "./fingerprint.ts";
import { SurrealReader } from "./surreal-read.ts";

const URL_ = Deno.env.get("FINGERPRINT_SURREAL_URL") ?? "";
const PASS = Deno.env.get("FINGERPRINT_SURREAL_PASS") ?? "";
const NS = "fp_test", DB = `fp_${crypto.randomUUID().slice(0, 8)}`;
const H = { "surreal-ns": NS, "surreal-db": DB, authorization: `Basic ${btoa(`root:${PASS}`)}` };

// minimal CBOR encoder (text, uint, array, map) - enough for one RPC "query" call with parameters
function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}
function cbor(v: unknown): number[] {
  if (typeof v === "number") return head(0, v);
  if (typeof v === "string") {
    const b = [...new TextEncoder().encode(v)];
    return [...head(3, b.length), ...b];
  }
  if (Array.isArray(v)) return [...head(4, v.length), ...v.flatMap(cbor)];
  const e = Object.entries(v as Record<string, unknown>);
  return [...head(5, e.length), ...e.flatMap(([k, x]) => [...cbor(k), ...cbor(x)])];
}
async function rpcWrite(q: string, vars: Record<string, string>) {
  const r = await fetch(`${URL_}/rpc`, {
    method: "POST", headers: { ...H, "content-type": "application/cbor", accept: "application/cbor" },
    body: new Uint8Array(cbor({ id: 1, method: "query", params: [q, vars] })),
  });
  await r.arrayBuffer();
  assertEquals(r.status, 200, `rpc ${q}`);
}
async function sqlWrite(q: string) {
  const r = await fetch(`${URL_}/sql`, { method: "POST", headers: { ...H, accept: "application/json" }, body: q });
  const t = await r.text();
  assert(r.ok && JSON.parse(t).every((x: { status: string }) => x.status === "OK"), `${q}: ${t.slice(0, 300)}`);
}

Deno.test({
  name: "capture-fix: the fingerprint reads a table holding a NUL-byte string (the live shape), and sees that row change",
  ignore: !URL_,
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    await sqlWrite(`DEFINE NAMESPACE IF NOT EXISTS ${NS}; USE NS ${NS}; DEFINE DATABASE ${DB};`);
    await sqlWrite(`DEFINE TABLE source SCHEMALESS; CREATE source:plain SET full_text = 'plain text', topics = ['a'];
      DEFINE TABLE source_embedding SCHEMALESS; CREATE source_embedding:e1 SET embedding = [0.25, 0.5];`);
    await rpcWrite("CREATE source:nul SET full_text = $t, title = 'with a NUL'", { t: "URL Source: x\u0000y" });
    // the live failure, reproduced: the row cannot be returned over /sql
    const raw = await fetch(`${URL_}/sql`, { method: "POST", headers: { ...H, accept: "application/json" }, body: "SELECT * FROM source:nul" });
    const rawText = await raw.text();
    assertEquals(raw.status, 400, rawText.slice(0, 200));
    assert(rawText.includes("null byte"), rawText.slice(0, 300));

    const reader = new SurrealReader({ url: URL_, ns: NS, db: DB, user: "root", pass: PASS });
    const before = await fingerprint(reader);
    assertEquals(before.source.rows, 2);
    assertEquals(changed(before, await fingerprint(reader)), [], "a re-read of the untouched store is quiesced");
    // a change INSIDE the NUL row's text is seen
    await rpcWrite("UPDATE source:nul SET full_text = $t", { t: "URL Source: x\u0000z" });
    const afterText = await fingerprint(reader);
    assertEquals(changed(before, afterText), ["source"]);
    // and an in-place embedding update still is (round 2, D4)
    await sqlWrite("UPDATE source_embedding:e1 SET embedding = [0.25, 0.75];");
    assertEquals(changed(afterText, await fingerprint(reader)), ["source_embedding"]);
  },
});

// rw-p7a-capture-fix clause 2: every kind of write is still seen with the server-side row hash, on a
// store holding the NUL row, and an untouched store is quiesced on two consecutive reads.
Deno.test({
  name: "capture-fix: every write kind is seen (schema, rows, deep fields, edges); an untouched store reads quiesced twice",
  ignore: !URL_,
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    const db = `fpk_${crypto.randomUUID().slice(0, 8)}`;
    const h = { ...H, "surreal-db": db };
    const sql = async (q: string) => {
      const r = await fetch(`${URL_}/sql`, { method: "POST", headers: { ...h, accept: "application/json" }, body: q });
      const t = await r.text();
      assert(r.ok && JSON.parse(t).every((x: { status: string }) => x.status === "OK"), `${q}: ${t.slice(0, 300)}`);
    };
    await sql(`DEFINE NAMESPACE IF NOT EXISTS ${NS}; USE NS ${NS}; DEFINE DATABASE ${db};`);
    await sql(`DEFINE TABLE source SCHEMALESS; DEFINE TABLE note SCHEMALESS; DEFINE TABLE notebook SCHEMALESS;
      DEFINE TABLE refers_to TYPE RELATION IN note OUT notebook SCHEMALESS;
      CREATE source:a SET full_text = 'plain', meta = { deep: { level: 1, tags: ['x'] } };
      CREATE source:b SET full_text = 'to delete';
      CREATE note:n1 SET title = 't'; CREATE notebook:nb1 SET name = 'n';
      DEFINE TABLE source_embedding SCHEMALESS; CREATE source_embedding:e1 SET embedding = [0.25, 0.5];`);
    // the live shape: a NUL row (binary protocol only)
    const rpc = await fetch(`${URL_}/rpc`, {
      method: "POST", headers: { ...h, "content-type": "application/cbor", accept: "application/cbor" },
      body: new Uint8Array(cbor({ id: 1, method: "query", params: ["CREATE source:nul SET full_text = $t", { t: "x\u0000y" }] })),
    });
    await rpc.arrayBuffer();
    assertEquals(rpc.status, 200);
    const reader = new SurrealReader({ url: URL_, ns: NS, db, user: "root", pass: PASS });
    let last = await fingerprint(reader);
    assertEquals(changed(last, await fingerprint(reader)), [], "untouched: quiesced (read 1)");
    assertEquals(changed(last, await fingerprint(reader)), [], "untouched: quiesced (read 2)");
    const writes: [string, string, string][] = [
      ["DEFINE INDEX", "DEFINE INDEX ix ON note FIELDS title;", "__table__:note"],
      ["DEFINE FIELD", "DEFINE FIELD f2 ON note TYPE option<string>;", "__table__:note"],
      ["REMOVE FIELD", "REMOVE FIELD f2 ON note;", "__table__:note"],
      ["DEFINE FUNCTION", "DEFINE FUNCTION fn::w() { RETURN 1; };", "__db__"],
      ["DEFINE PARAM", "DEFINE PARAM $p VALUE 1;", "__db__"],
      ["DEFINE EVENT", "DEFINE EVENT ev ON source WHEN $event = 'CREATE' THEN (CREATE note SET title = 'ev');", "__table__:source"],
      ["DEFINE ANALYZER", "DEFINE ANALYZER an TOKENIZERS blank FILTERS lowercase;", "__db__"],
      ["DEFINE USER (database)", "DEFINE USER u2 ON DATABASE PASSWORD 'lab-only-pw' ROLES VIEWER;", "__db__"],
      ["DEFINE ACCESS (database)", "DEFINE ACCESS ac ON DATABASE TYPE JWT ALGORITHM HS512 KEY 'lab-only-key-0123456789';", "__db__"],
      ["DEFINE USER (namespace)", `DEFINE USER u3_${db} ON NAMESPACE PASSWORD 'lab-only-pw' ROLES VIEWER;`, "__ns__"],
      ["deep UPDATE", "UPDATE source:a SET meta.deep.tags[0] = 'y';", "source"],
      ["deep UPDATE (number)", "UPDATE source:a SET meta.deep.level = 2;", "source"],
      ["DELETE a row", "DELETE source:b;", "source"],
      ["RELATE (an edge)", "RELATE note:n1->refers_to->notebook:nb1;", "refers_to"],
      ["embedding update", "UPDATE source_embedding:e1 SET embedding = [0.25, 0.75];", "source_embedding"],
    ];
    for (const [what, q, key] of writes) {
      await sql(q);
      const now = await fingerprint(reader);
      const diff = changed(last, now);
      assert(diff.includes(key), `${what}: expected ${key} in ${JSON.stringify(diff)}`);
      last = now;
    }
    assertEquals(changed(last, await fingerprint(reader)), [], "after the writes, an untouched read is quiesced again");
  },
});

// capture-fix round 2 (tester D1): each bypass attempt is sent THROUGH the guarded client to a store where
// fn::w() writes; whatever the guard admits runs, and the write probe must stay at 0 rows. Then the
// capture's own queries all run.
Deno.test({
  name: "capture-fix round 2: no bypass attempt lands a write through SurrealReader; the capture's own queries run",
  ignore: !URL_,
  sanitizeOps: false, sanitizeResources: false,
  async fn() {
    const { BYPASS_CASES, CAPTURE_QUERIES } = await import("./guard-cases.ts");
    const db = `fpg_${crypto.randomUUID().slice(0, 8)}`;
    const h = { ...H, "surreal-db": db, accept: "application/json" };
    const raw = async (q: string) => {
      const r = await fetch(`${URL_}/sql`, { method: "POST", headers: h, body: q });
      return JSON.parse(await r.text());
    };
    await raw(`DEFINE NAMESPACE IF NOT EXISTS ${NS}; USE NS ${NS}; DEFINE DATABASE ${db};`);
    await raw(`DEFINE TABLE a SCHEMALESS; CREATE a:1 SET x = 1; DEFINE TABLE pwned SCHEMALESS;
      DEFINE FUNCTION fn::w() { CREATE pwned SET at = time::now(); RETURN 1; };
      DEFINE TABLE speaker_profile SCHEMALESS; DEFINE TABLE episode_profile SCHEMALESS; DEFINE TABLE podcast_config SCHEMALESS; DEFINE TABLE model SCHEMALESS; DEFINE TABLE episode SCHEMALESS; DEFINE TABLE command SCHEMALESS; DEFINE TABLE source SCHEMALESS; DEFINE TABLE source_embedding SCHEMALESS;`);
    const pwned = async () => (await raw("SELECT count() AS n FROM pwned GROUP ALL"))[0].result[0]?.n ?? 0;
    // the probe works: an unguarded call writes
    await raw("SELECT fn::w() FROM a");
    assertEquals(await pwned(), 1, "the probe function writes when called unguarded");
    const reader = new SurrealReader({ url: URL_, ns: NS, db, user: "root", pass: PASS });
    const ran: string[] = [];
    for (const [name, q] of BYPASS_CASES) {
      try {
        await reader.query(q);
        ran.push(name);
      } catch { /* refused, or the server rejected it */ }
    }
    assertEquals(await pwned(), 1, `no write landed through the guarded client (ran: ${ran.join("; ") || "none"})`);
    assertEquals(ran, [], "no bypass statement reached the server and succeeded");
    for (const q of CAPTURE_QUERIES) await reader.query(q);
  },
});
