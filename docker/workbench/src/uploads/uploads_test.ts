// deno test src/uploads/uploads_test.ts - rwr-upload-sessions, no database: where the bytes are (coverage, placement), the
// store on a temporary directory (a piece over the limit or cut off leaves nothing; the join verifies length and sha256 and
// finds a damaged piece; the sweep's measure), the one owner lookup (another person's id and a missing one ask the same
// question and get the same answer), the limits, the contract document, the user-only rule, the owner scope's one exemption,
// slot 610's files and the compose wiring. The real-database cases are uploads_integration_test.ts (run-uploads-tests.ps1).
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { coverage, cleanFilename, NO_SUCH_UPLOAD, parseOffset, placement, UploadRefused, uploadSessions } from "./sessions.ts";
import { MB, uploadLimits } from "./limits.ts";
import { PieceInterrupted, PieceTooLarge, uploadStore } from "./store.ts";
import { Sha256 } from "./sha256.ts";
import type { Db } from "../contracts/db.ts";
import type { Identity } from "../middleware/identity.ts";
import { USER_ONLY } from "../middleware/identity.ts";
import { UPLOAD_PIECE } from "../middleware/owner-scope.ts";
import { createContractApp, openApiDocument } from "../contracts/app.ts";
import { RegistryReader } from "../contracts/registry.ts";
import { unavailableScorer } from "../contracts/logic/reopen.ts";

const docker = new URL("../../../", import.meta.url);
const haveRepo = (() => { try { Deno.statSync(new URL("init-upload-sessions.sql", docker)); return true; } catch { return false; } })();
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, docker)).replace(/\r\n/g, "\n");
const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
const streamOf = (...chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } });
const A: Identity = { sub: "user-a", actor: "user-a", name: "A", key: "user-a" };
const B: Identity = { sub: "user-b", actor: "user-b", name: "B", key: "user-b" };

Deno.test("coverage: received bytes, where to resume, the missing ranges", () => {
  assertEquals(coverage([], 10), { received: 0, next_offset: 0, missing: [{ offset: 0, length: 10 }] });
  assertEquals(coverage([{ offset: 0, length: 4 }, { offset: 6, length: 4 }], 10), { received: 8, next_offset: 4, missing: [{ offset: 4, length: 2 }] });
  assertEquals(coverage([{ offset: 4, length: 6 }, { offset: 0, length: 4 }], 10), { received: 10, next_offset: 10, missing: [] });
  assertEquals(coverage([{ offset: 0, length: 4 }], 10).missing, [{ offset: 4, length: 6 }]);
});

Deno.test("placement: inside the file, never overlapping; the same piece again is a resend", () => {
  const have = [{ offset: 0, length: 4 }, { offset: 8, length: 2 }];
  assertEquals(placement(have, 4, 4, 10), "new");
  assertEquals(placement(have, 0, 4, 10), "same");
  assertEquals(placement(have, 2, 4, 10), { overlaps: { offset: 0, length: 4 } });
  assertEquals(placement(have, 0, 3, 10), { overlaps: { offset: 0, length: 4 } }, "the same offset with another length overlaps");
  assertEquals(placement(have, 7, 2, 10), { overlaps: { offset: 8, length: 2 } });
  assertEquals(placement(have, 9, 2, 10), "out_of_range");
  assertEquals(placement([], 10, 1, 10), "out_of_range");
  assertEquals(placement([], -1, 1, 10), "out_of_range");
  assertEquals(placement([], 0, 0, 10), "out_of_range");
  assertEquals(parseOffset("0"), 0);
  assertEquals(parseOffset("8388608"), 8388608);
  for (const bad of ["", "-1", "1.5", "0x10", " ", "1e3", "9999999999999999", undefined, null]) assertEquals(parseOffset(bad), null, String(bad));
  assertEquals(cleanFilename(" survey.pdf "), "survey.pdf");
  for (const bad of ["", "a/b.pdf", "a\\b.pdf", "..", "x\u0000.pdf", "x\n.pdf", "a".repeat(256), 5]) assertEquals(cleanFilename(bad), null, String(bad));
});

Deno.test("the incremental sha256 equals WebCrypto's for every length around the block edges, fed in any split; no node: import", async () => {
  for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 65537]) {
    const data = new Uint8Array(n).map((_, i) => (i * 31 + n) & 0xff);
    const want = hex(await crypto.subtle.digest("SHA-256", data));
    assertEquals(new Sha256().update(data).hex(), want, `length ${n}`);
    const h = new Sha256();
    for (let i = 0; i < n; i += 7) h.update(data.subarray(i, Math.min(n, i + 7)));
    assertEquals(h.hex(), want, `length ${n} in 7-byte pieces`);
  }
  assertEquals(new Sha256().update(new TextEncoder().encode("abc")).hex(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (const f of ["store.ts", "sessions.ts", "limits.ts", "sha256.ts", "uploads_integration_test.ts"]) {
    assert(!/from "node:/.test(Deno.readTextFileSync(new URL(f, import.meta.url))), `${f} imports no node: builtin (deno.lock would gain @types/node)`);
  }
});

Deno.test("limits: the anchor's defaults, and each one from its environment variable", () => {
  const d = uploadLimits(() => undefined);
  assertEquals([d.maxFileBytes, d.maxUnfinishedBytes, d.maxPieceBytes, d.pieceBytes, d.abandonHours, d.dir], [500 * MB, 1024 * MB, 16 * MB, 8 * MB, 24, "/uploads"]);
  const env: Record<string, string> = { UPLOAD_MAX_FILE_BYTES: "1000", UPLOAD_MAX_UNFINISHED_BYTES: "3000", UPLOAD_MAX_PIECE_BYTES: "100", UPLOAD_PIECE_BYTES: "500", UPLOAD_ABANDON_HOURS: "0", UPLOAD_DIR: "/x" };
  const e = uploadLimits((k) => env[k]);
  assertEquals([e.maxFileBytes, e.maxUnfinishedBytes, e.maxPieceBytes, e.pieceBytes, e.abandonHours, e.dir], [1000, 3000, 100, 100, 0, "/x"]);
  assertEquals(uploadLimits((k) => (k === "UPLOAD_MAX_FILE_BYTES" ? "lots" : undefined)).maxFileBytes, 500 * MB, "a value that is not a number keeps the default");
});

Deno.test("store: a piece over the limit or cut off leaves nothing; the join checks length and sha256 and finds a damaged piece", async () => {
  const root = await Deno.makeTempDir();
  try {
    const s = uploadStore(root);
    const id = "5e1d0c00-0000-4000-8000-000000000001";
    const files = async () => { const o: string[] = []; for await (const e of Deno.readDir(`${root}/${id}`)) o.push(e.name); return o.sort(); };
    await assertRejects(() => s.receive(id, streamOf(new Uint8Array(6), new Uint8Array(6)), 10), PieceTooLarge);
    assertEquals(await files(), [], "nothing left by a piece over the limit");
    const broken = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(4)); c.error(new Error("connection reset")); } });
    await assertRejects(() => s.receive(id, broken, 10), PieceInterrupted);
    assertEquals(await files(), [], "nothing left by a dropped connection");
    const data = new TextEncoder().encode("%PDF-1.4 hello pieces");
    const a = await s.receive(id, streamOf(data.subarray(0, 8)), 100);
    await s.commit(id, a.tmp, 0);
    const b = await s.receive(id, streamOf(data.subarray(8)), 100);
    await s.commit(id, b.tmp, 8);
    assertEquals(await files(), ["p-0", "p-8"]);
    assertEquals(new TextDecoder().decode(await s.head(id) ?? new Uint8Array()), "%PDF-1.4");
    const pieces = [{ offset: 0, length: 8 }, { offset: 8, length: data.length - 8 }];
    // a damaged piece (shorter in storage than received) stops the join and leaves no joined file
    await Deno.writeFile(`${root}/${id}/p-8`, data.subarray(8, 10));
    const bad = await s.assemble(id, pieces);
    assertEquals(bad.damaged, { offset: 8, expected: data.length - 8, found: 2 });
    assert(!(await files()).includes("assembled"));
    await Deno.writeFile(`${root}/${id}/p-8`, data.subarray(8));
    const ok = await s.assemble(id, pieces);
    assertEquals(ok, { bytes: data.length, sha256: hex(await crypto.subtle.digest("SHA-256", data)), damaged: null });
    assertEquals(await files(), ["assembled"], "the pieces are removed once joined");
    assertEquals(await s.readAssembled(id), data);
    assertEquals(await s.sessions(), [id]);
    assertEquals(await s.usage(), data.length);
    assertEquals(await s.remove(id), data.length, "remove answers the bytes it freed");
    assertEquals(await s.sessions(), []);
    let threw = false;
    try { await s.receive("../etc", null, 1); } catch { threw = true; }
    assert(threw, "an id that is not a uuid never becomes a path");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the owner lookup: another person's upload and a missing one are the same question and the same 404", async () => {
  const seen: { sql: string; args: unknown[] }[] = [];
  const db: Db = {
    query: <T>(sql: string, args: unknown[] = []) => {
      seen.push({ sql: sql.replace(/\s+/g, " ").trim(), args });
      // the row is A's: asked as B (or for a missing id) it is not found; the sum of nothing is 0
      return Promise.resolve((/sum\(size\)/.test(sql) ? [{ n: "0" }] : []) as T[]);
    },
    tx: (fn) => fn(db),
  };
  const intake = { target: () => Promise.resolve({ refineryId: null, docPath: null }), fileType: () => ({ type: "pdf" }), insertJob: () => Promise.reject(new Error("no")), run: () => {} };
  const store = uploadStore(await Deno.makeTempDir());
  const u = uploadSessions({ db, store, limits: uploadLimits(() => undefined), intake });
  const id = "5e1d0c00-0000-4000-8000-000000000001";
  const answers: string[] = [];
  for (const call of [() => u.status(B, id), () => u.piece(B, id, "0", "10", streamOf(new Uint8Array(10))), () => u.finish(B, id, {}), () => u.cancel(B, id),
    () => u.status(B, "not-a-uuid"), () => u.status({ ...B, sub: "" }, id)]) {
    const e = await call().then(() => null, (x) => x);
    assert(e instanceof UploadRefused, String(e));
    answers.push(`${e.status} ${e.message} ${JSON.stringify(e.detail)}`);
  }
  assertEquals(new Set(answers).size, 1, answers.join(" | "));
  assertEquals(answers[0], `404 ${NO_SUCH_UPLOAD} {}`);
  // every lookup that reached the database asked for the id AND the caller's subject, nothing else
  const lookups = seen.filter((q) => /FROM public\.upload_sessions s WHERE/.test(q.sql));
  assertEquals(lookups.length, 4);
  for (const q of lookups) {
    assert(/WHERE s\.id = \$1::uuid AND s\.owner_sub = \$2/.test(q.sql), q.sql);
    assertEquals(q.args, [id, "user-b"]);
  }
  assertEquals(seen.length, 4, "a refused lookup runs no other statement (no piece is read, nothing is written)");
  assertEquals([await store.sessions(), await store.usage()], [[], 0], "B's piece body was never read into storage");
  // the list and the count are the caller's only
  await u.list(A);
  assert(seen.slice(4).every((q) => q.args[0] === "user-a" || q.args.length === 1 && String(q.args[0]).length === 36), JSON.stringify(seen.slice(4)));
  assert(seen.slice(4).some((q) => /owner_sub = \$1 AND state IN \('open', 'finishing'\)/.test(q.sql)), "unfinished bytes are summed over the caller's own");
});

Deno.test("start refuses with a reason: a file over the limit, a bad size or sha256, a name with a folder", async () => {
  const db: Db = { query: <T>() => Promise.resolve([{ n: "0" }] as T[]), tx: (fn) => fn(db) };
  const intake = { target: () => Promise.resolve({ refineryId: null, docPath: null }), fileType: () => ({ type: "pdf" }), insertJob: () => Promise.reject(new Error("no")), run: () => {} };
  const u = uploadSessions({ db, store: uploadStore("/nonexistent"), limits: uploadLimits(() => undefined), intake });
  const sha = "ab".repeat(32);
  const cases: [Record<string, unknown>, number, RegExp][] = [
    [{ filename: "a.pdf", size: 500 * MB + 1, sha256: sha }, 413, /at most 524288000 bytes/],
    [{ filename: "a.pdf", size: 0, sha256: sha }, 400, /size/],
    [{ filename: "a.pdf", size: 1.5, sha256: sha }, 400, /size/],
    [{ filename: "a.pdf", size: "10", sha256: sha }, 400, /size/],
    [{ filename: "a.pdf", size: 10, sha256: "xyz" }, 400, /sha256/],
    [{ filename: "dir/a.pdf", size: 10, sha256: sha }, 400, /name/],
  ];
  for (const [b, status, msg] of cases) {
    const e = await u.start(A, b).then(() => null, (x) => x);
    assert(e instanceof UploadRefused && e.status === status && msg.test(e.message), `${JSON.stringify(b)} -> ${e?.status} ${e?.message}`);
  }
});

Deno.test("the contract has the six upload operations, user-only, no MCP tool, no parameter naming a person", () => {
  const db: Db = { query: () => Promise.resolve([]), tx: (fn) => fn(db) };
  const doc = openApiDocument(createContractApp({
    db, registry: new RegistryReader(db), scorer: unavailableScorer, embed: () => Promise.resolve([]), chunk: (s) => [s],
    mountsRoot: "/tmp", streamPollMs: 1000, log: () => {},
  })) as any;
  const ops = [["/workbench/contract/uploads", "post", "startUpload"], ["/workbench/contract/uploads", "get", "listUploads"],
    ["/workbench/contract/uploads/{id}", "get", "uploadStatus"], ["/workbench/contract/uploads/{id}", "delete", "cancelUpload"],
    ["/workbench/contract/uploads/{id}/pieces", "put", "putUploadPiece"], ["/workbench/contract/uploads/{id}/finish", "post", "finishUpload"]];
  for (const [p, m, id] of ops) {
    const op = doc.paths[p]?.[m];
    assert(op, `${m} ${p}`);
    assertEquals(op.operationId, id);
    assertEquals(op["x-mcp-tool"], undefined, `${id}: no MCP tool`);
    for (const prm of op.parameters ?? []) assert(["id", "offset"].includes(prm.name), `${id}: parameter ${prm.name}`);
    assert(USER_ONLY.test(p.replace("{id}", "5e1d0c00-0000-4000-8000-000000000001")), `${p} is user-only`);
  }
  assert(doc.paths["/workbench/contract/uploads/{id}/pieces"].put.requestBody.content["application/octet-stream"], "a piece is raw bytes");
  assertEquals(Object.keys(doc.components.schemas.UploadStart.properties).sort(), ["filename", "sha256", "size"], "a start names no person");
});

Deno.test("the owner scope skips the body of exactly one route: PUT .../uploads/<uuid>/pieces", () => {
  assert(UPLOAD_PIECE.test("/workbench/contract/uploads/5e1d0c00-0000-4000-8000-000000000001/pieces"));
  for (const p of ["/workbench/contract/uploads/5e1d0c00-0000-4000-8000-000000000001/finish", "/workbench/contract/uploads/x/pieces",
    "/workbench/contract/uploads/5e1d0c00-0000-4000-8000-000000000001/pieces/x", "/workbench/documents/5e1d0c00-0000-4000-8000-000000000001/pieces",
    "/workbench/contract/uploads/5e1d0c00-0000-4000-8000-000000000001/pieces?path=documents/x"]) {
    assert(!UPLOAD_PIECE.test(p), p);
  }
});

Deno.test({ ignore: !haveRepo, name: "slot 610: two new tables, RLS forced, ob_workbench alone; no foreign key to import_jobs; the revert drops those two only", fn: () => {
  const up = read("init-upload-sessions.sql");
  assert(/CREATE TABLE IF NOT EXISTS public\.upload_sessions/.test(up) && /CREATE TABLE IF NOT EXISTS public\.upload_session_pieces/.test(up));
  assertEquals((up.match(/FORCE ROW LEVEL SECURITY/g) ?? []).length, 2);
  assert(/TO ob_workbench USING \(true\) WITH CHECK \(true\)/.test(up));
  assert(/REVOKE ALL ON public\.upload_sessions, public\.upload_session_pieces FROM PUBLIC/.test(up) && /rolname <> 'ob_workbench'/.test(up));
  assert(!/REFERENCES public\.import_jobs/.test(up), "no foreign key locks import_jobs");
  assert(!/ALTER TABLE public\.(?!upload_)/.test(up), "no existing table is altered");
  assert(/ERRCODE = '55000'/.test(up), "refused without slot 480");
  const rev = read("revert-upload-sessions.sql");
  const drops = rev.split("\n").filter((l) => /^DROP /.test(l));
  assertEquals(drops, ["DROP TABLE IF EXISTS public.upload_session_pieces;", "DROP TABLE IF EXISTS public.upload_sessions;"]);
  const compose = read("docker-compose.yml");
  assert(compose.includes("./init-upload-sessions.sql:/docker-entrypoint-initdb.d/610-init-upload-sessions.sql:ro"));
  assert(compose.indexOf("610-init-upload-sessions") > compose.indexOf("600-init-inlet-connections-read"));
  assertEquals((compose.match(/- openbrain-uploads:/g) ?? []).length, 1, "the uploads volume is mounted by one service");
  const wb = compose.slice(compose.indexOf("\n  openbrain-workbench:\n"));
  assert(wb.slice(0, wb.indexOf("\n  openbrain-", 5)).includes("- openbrain-uploads:/uploads"), "and that service is openbrain-workbench");
}});
