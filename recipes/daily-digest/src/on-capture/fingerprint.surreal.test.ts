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
