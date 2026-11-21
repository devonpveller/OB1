// deno test --allow-read --allow-write --allow-env src/contracts/podcast_audio_test.ts
// rwr-podcast-audio-api, no database: the byte-range rule, the archive containment rule over real
// temporary directories (symbolic links included where the platform allows them), and the two
// routes served behind the REAL identity seam over an in-memory stand-in for the two tables (the
// same predicates as repo/podcasts.ts; the SQL itself runs in integration_test.ts against Postgres).
// Last, the production compose file: the archive is mounted read-only, on the workbench only.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { Hono } from "hono";
import { createContractApp } from "./app.ts";
import { RegistryReader } from "./registry.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import type { Db } from "./db.ts";
import { AudioUnavailable, mediaTypeOf, parseRange, resolveEpisodeAudio, within } from "./logic/audio.ts";
import { identitySeam, seamDeps } from "../middleware/identity.ts";

// ── the range rule ──────────────────────────────────────────────────────────────────────────
Deno.test("parseRange: one bytes range -> partial (inclusive end, clamped); none or not understood -> full; past the end -> unsatisfiable", () => {
  assertEquals(parseRange(undefined, 100), { kind: "full" });
  assertEquals(parseRange("", 100), { kind: "full" });
  assertEquals(parseRange("bytes=0-3", 100), { kind: "partial", start: 0, end: 3 });
  assertEquals(parseRange("bytes=10-", 100), { kind: "partial", start: 10, end: 99 });
  assertEquals(parseRange("bytes=90-500", 100), { kind: "partial", start: 90, end: 99 });
  assertEquals(parseRange("bytes=-10", 100), { kind: "partial", start: 90, end: 99 });
  assertEquals(parseRange("bytes=-500", 100), { kind: "partial", start: 0, end: 99 });
  assertEquals(parseRange("bytes=100-", 100), { kind: "unsatisfiable" });
  assertEquals(parseRange("bytes=-0", 100), { kind: "unsatisfiable" });
  for (const ignored of ["items=0-3", "bytes=0-3,5-7", "bytes=5-2", "bytes=-", "bytes=a-b", "garbage"]) {
    assertEquals(parseRange(ignored, 100), { kind: "full" }, ignored);
  }
});

Deno.test("mediaTypeOf follows the transcode menu; anything else is opaque bytes", () => {
  assertEquals([mediaTypeOf("mp3"), mediaTypeOf("m4a"), mediaTypeOf("opus"), mediaTypeOf("flac"), mediaTypeOf("wav")],
    ["audio/mpeg", "audio/mp4", "audio/ogg", "audio/flac", "audio/wav"]);
  assertEquals(mediaTypeOf("exe"), "application/octet-stream");
  assertEquals(mediaTypeOf("__proto__"), "application/octet-stream");
});

Deno.test("within: a sibling with the root as its prefix is not inside", () => {
  assert(within("/mounts", "/mounts/podcast-archive/x"));
  assert(!within("/mounts", "/mounts"));
  assert(!within("/mounts", "/mounts-alt/x"));
  assert(!within("", "/x"));
});

// ── the archive on disk ─────────────────────────────────────────────────────────────────────
const AUDIO_A = new TextEncoder().encode("ID3owner-a-private-audio-0123456789"); // 35 bytes
const AUDIO_S = new TextEncoder().encode("ID3shared-audio-bytes");
const SECRET = new TextEncoder().encode("OUTSIDE-THE-ARCHIVE-SECRET");

interface Lab {
  base: string; // a temporary directory (real path, forward slashes)
  root: string; // <base>/mounts - the contract's mounts root
  dirA: string;
  dirShared: string;
  outside: string; // <base>/outside: a directory beside the root
  symlinks: boolean;
}

const slash = (p: string) => p.replace(/\\/g, "/");

async function episodeDir(dir: string, file: string, data: Uint8Array | null, sidecarFile: unknown = file) {
  await Deno.mkdir(dir, { recursive: true });
  if (data) await Deno.writeFile(`${dir}/${file}`, data);
  await Deno.writeTextFile(`${dir}/sidecar.json`, JSON.stringify({ schema: "podcast-archive-sidecar/1", audio: { file: sidecarFile, format: "mp3" } }));
}

async function makeLab(): Promise<Lab> {
  const base = slash(await Deno.realPath(await Deno.makeTempDir({ prefix: "wb-audio-" })));
  const root = `${base}/mounts`;
  const arc = `${root}/podcast-archive/renders`;
  const outside = `${base}/outside`;
  await Deno.mkdir(outside, { recursive: true });
  await Deno.writeFile(`${outside}/audio.mp3`, SECRET);
  await Deno.writeTextFile(`${outside}/sidecar.json`, JSON.stringify({ audio: { file: "audio.mp3" } }));
  await episodeDir(`${arc}/a`, "audio.mp3", AUDIO_A);
  await episodeDir(`${arc}/shared`, "audio.mp3", AUDIO_S);
  await episodeDir(`${arc}/escape-name`, "audio.mp3", null, "../a/audio.mp3");
  await episodeDir(`${arc}/escape-abs`, "audio.mp3", null, `${outside}/audio.mp3`);
  await episodeDir(`${arc}/escape-sidecar-name`, "audio.mp3", AUDIO_A, "sidecar.json");
  await episodeDir(`${arc}/no-file`, "audio.mp3", null);
  await episodeDir(`${arc}/bad-type`, "audio.mp3", null, 42);
  let symlinks = true;
  try {
    await Deno.symlink(outside, `${arc}/link-dir`); // the episode directory itself points outside
    await Deno.mkdir(`${arc}/link-file`, { recursive: true });
    await Deno.symlink(`${outside}/audio.mp3`, `${arc}/link-file/audio.mp3`); // the file points outside
    await Deno.writeTextFile(`${arc}/link-file/sidecar.json`, JSON.stringify({ audio: { file: "audio.mp3" } }));
  } catch {
    symlinks = false; // Windows without the symlink privilege: the Linux image build gate runs these
  }
  return { base, root, dirA: `${arc}/a`, dirShared: `${arc}/shared`, outside, symlinks };
}

Deno.test("resolveEpisodeAudio: a clean row under the root resolves to its sidecar's file", async () => {
  const lab = await makeLab();
  try {
    const r = await resolveEpisodeAudio(lab.dirA, lab.root);
    assertEquals(slash(r.path), `${lab.dirA}/audio.mp3`);
    assertEquals(r.size, AUDIO_A.length);
  } finally {
    await Deno.remove(lab.base, { recursive: true });
  }
});

Deno.test("resolveEpisodeAudio: a stored path or a sidecar name that escapes the root (planted) is refused, before any audio byte is read", async () => {
  const lab = await makeLab();
  try {
    const arc = `${lab.root}/podcast-archive/renders`;
    const planted = [
      lab.outside, // a directory outside the root
      `${lab.root}/podcast-archive/../../outside`, // ".." back out
      `${arc}/./a`, // a "." segment
      `${arc}//a`, // an empty segment
      `${lab.root}`, // the root itself is not an episode directory
      `${lab.root}-alt/x`, // a sibling sharing the prefix
      "relative/a", // not absolute
      `${arc}/a\\..\\..`, // a backslash
      `${arc}/escape-name`, // the sidecar names ../a/audio.mp3
      `${arc}/escape-abs`, // the sidecar names an absolute file outside
      `${arc}/escape-sidecar-name`, // the sidecar names itself
      `${arc}/no-file`, // the named file is not there
      `${arc}/bad-type`, // the sidecar's file is not a string
      `${arc}/missing`, // no directory at all
      ...(lab.symlinks ? [`${arc}/link-dir`, `${arc}/link-file`] : []),
    ];
    for (const dir of planted) {
      await assertRejects(() => resolveEpisodeAudio(dir, lab.root), AudioUnavailable, undefined, dir);
    }
    if (!lab.symlinks) console.warn("  (symbolic links unavailable here: the link cases run in the image build gate)");
  } finally {
    await Deno.remove(lab.base, { recursive: true });
  }
});

// ── the routes, behind the real identity seam (X-Test-Sub as the labs run it) ─────────────────
const A = "audio-user-a", B_ = "audio-user-b";
const EP_A = "e7000000-0000-4000-8000-0000000000a1"; // A's, unshared
const EP_S = "e7000000-0000-4000-8000-0000000000a2"; // A's, shared
const EP_ESC = "e7000000-0000-4000-8000-0000000000a3"; // A's, its stored path escapes (planted)
const EP_NONE = "e7000000-0000-4000-8000-0000000000ff"; // no row
const RQ_FAILED = "e8000000-0000-4000-8000-0000000000a1";
const RQ_QUEUED = "e8000000-0000-4000-8000-0000000000a2";
const RQ_DONE = "e8000000-0000-4000-8000-0000000000a3";
const RQ_B = "e8000000-0000-4000-8000-0000000000b1"; // B's, failed
const RQ_NONE = "e8000000-0000-4000-8000-0000000000ff";

interface Ep { id: string; owner_sub: string; shared: boolean; archive_dir: string; audio_format: string; origin: string }
interface Rq { id: string; requester_sub: string; state: string; error: string | null }

// The two tables, and the three statements the routes run (repo/podcasts.ts), with the same predicates.
function fakeDb(eps: Ep[], rqs: Rq[]): Db & { updates: number } {
  const row = (r: Rq) => ({
    id: r.id, team_id: "t", title: "x", state: r.state, episode_id: null, error: r.error, turns: 1,
    created_at: "2026-10-17T12:00:00.000Z", updated_at: "2026-10-17T12:00:00.000Z",
  });
  const d = {
    updates: 0,
    query: <T>(sql: string, args: unknown[] = []): Promise<T[]> => {
      const [id, sub] = args as string[];
      if (/FROM public\.podcast_episodes e/.test(sql)) {
        const shared = args[2] as boolean;
        return Promise.resolve(eps.filter((e) => e.id === id && e.origin === "render" && (e.owner_sub === sub || (shared && e.shared))) as T[]);
      }
      if (/^\s*UPDATE public\.podcast_render_requests/.test(sql)) {
        const r = rqs.find((x) => x.id === id && x.requester_sub === sub && x.state === "failed");
        if (!r) return Promise.resolve([]);
        r.state = "queued";
        r.error = null;
        d.updates++;
        return Promise.resolve([row(r)] as T[]);
      }
      if (/SELECT r\.state FROM public\.podcast_render_requests/.test(sql)) {
        return Promise.resolve(rqs.filter((x) => x.id === id && x.requester_sub === sub).map((x) => ({ state: x.state })) as T[]);
      }
      return Promise.reject(new Error(`unexpected statement: ${sql.slice(0, 80)}`));
    },
    tx: <T>(fn: (t: Db) => Promise<T>): Promise<T> => fn(d as Db),
  };
  return d;
}

function served(lab: Lab, rqs?: Rq[]) {
  const eps: Ep[] = [
    { id: EP_A, owner_sub: A, shared: false, archive_dir: lab.dirA, audio_format: "mp3", origin: "render" },
    { id: EP_S, owner_sub: A, shared: true, archive_dir: lab.dirShared, audio_format: "mp3", origin: "render" },
    { id: EP_ESC, owner_sub: A, shared: true, archive_dir: `${lab.root}/podcast-archive/../../outside`, audio_format: "mp3", origin: "render" },
  ];
  const db = fakeDb(eps, rqs ?? [
    { id: RQ_FAILED, requester_sub: A, state: "failed", error: "boom" },
    { id: RQ_QUEUED, requester_sub: A, state: "queued", error: null },
    { id: RQ_DONE, requester_sub: A, state: "done", error: null },
    { id: RQ_B, requester_sub: B_, state: "failed", error: "B-private-error" },
  ]);
  const app = createContractApp({
    db, registry: new RegistryReader(db), scorer: unavailableScorer, embed: () => Promise.reject(new Error("x")),
    chunk: () => [], mountsRoot: lab.root, streamPollMs: 10, log: () => {},
  });
  const env = (k: string) => ({ WORKSPACE_IDENTITY_HEADER: "X-Test-Sub", WORKSPACE_SERVICE_KEYS: "svc=audio-test-service-key-0123" } as Record<string, string>)[k];
  const front = new Hono();
  front.use("*", identitySeam(seamDeps(null, env)));
  front.route("/", app);
  const call = async (method: string, path: string, opts: { as?: string; range?: string; service?: boolean } = {}) => {
    const r = await front.request(`/workbench/contract${path}`, {
      method,
      headers: {
        ...(opts.as ? { "X-Test-Sub": opts.as } : {}), ...(opts.range ? { range: opts.range } : {}),
        ...(opts.service ? { "x-brain-key": "audio-test-service-key-0123" } : {}),
      },
    });
    const bytes = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, headers: r.headers, bytes, text: new TextDecoder().decode(bytes) };
  };
  return { call, db };
}

const has = (hay: Uint8Array, needle: Uint8Array) => new TextDecoder().decode(hay).includes(new TextDecoder().decode(needle));

Deno.test("audio: the owner hears an unshared episode; B gets 404 for it and 200 for a shared one; the 404 is the same as no row", async () => {
  const lab = await makeLab();
  try {
    const { call } = served(lab);
    const own = await call("GET", `/podcasts/${EP_A}/audio`, { as: A });
    assertEquals(own.status, 200, own.text);
    assertEquals(own.bytes, AUDIO_A);
    assertEquals([own.headers.get("content-type"), own.headers.get("accept-ranges"), own.headers.get("content-length")],
      ["audio/mpeg", "bytes", String(AUDIO_A.length)]);
    const other = await call("GET", `/podcasts/${EP_A}/audio`, { as: B_ });
    const none = await call("GET", `/podcasts/${EP_NONE}/audio`, { as: B_ });
    assertEquals(other.status, 404);
    assertEquals([other.status, other.text], [none.status, none.text], "another user's unshared episode looks exactly like no row");
    assert(!has(other.bytes, AUDIO_A), "no byte of A's audio");
    const shared = await call("GET", `/podcasts/${EP_S}/audio`, { as: B_ });
    assertEquals(shared.status, 200, shared.text);
    assertEquals(shared.bytes, AUDIO_S);
  } finally {
    await Deno.remove(lab.base, { recursive: true });
  }
});

Deno.test("audio: a service key hears no one's episode, shared or not (any SIGNED-IN user)", async () => {
  const lab = await makeLab();
  try {
    const { call } = served(lab);
    const none = await call("GET", `/podcasts/${EP_NONE}/audio`, { service: true });
    assertEquals(none.status, 404, none.text);
    for (const id of [EP_S, EP_A]) {
      const r = await call("GET", `/podcasts/${id}/audio`, { service: true });
      assertEquals([r.status, r.text], [none.status, none.text], id);
    }
  } finally {
    await Deno.remove(lab.base, { recursive: true });
  }
});

Deno.test("audio: a range answers 206 with the right Content-Range and exactly those bytes; a suffix and an open range too; past the end is 416", async () => {
  const lab = await makeLab();
  try {
    const { call } = served(lab);
    const n = AUDIO_A.length;
    const cases: [string, number, number][] = [["bytes=0-3", 0, 3], ["bytes=5-9", 5, 9], ["bytes=30-", 30, n - 1], ["bytes=-4", n - 4, n - 1], ["bytes=20-9999", 20, n - 1]];
    for (const [range, s, e] of cases) {
      const r = await call("GET", `/podcasts/${EP_A}/audio`, { as: A, range });
      assertEquals(r.status, 206, range);
      assertEquals(r.headers.get("content-range"), `bytes ${s}-${e}/${n}`, range);
      assertEquals(r.headers.get("content-length"), String(e - s + 1), range);
      assertEquals(r.bytes, AUDIO_A.slice(s, e + 1), range);
    }
    const past = await call("GET", `/podcasts/${EP_A}/audio`, { as: A, range: `bytes=${n}-` });
    assertEquals(past.status, 416);
    assertEquals(past.headers.get("content-range"), `bytes */${n}`);
    assert(!has(past.bytes, AUDIO_A.slice(0, 8)));
    // another user's range request is the same 404, never a 206 or a 416 that tells the size
    const other = await call("GET", `/podcasts/${EP_A}/audio`, { as: B_, range: "bytes=0-3" });
    assertEquals(other.status, 404);
    assert(!other.headers.get("content-range"));
  } finally {
    await Deno.remove(lab.base, { recursive: true });
  }
});

Deno.test("audio: ids that are not rows (and not uuids) and a row whose stored path escapes the root are 404 with no file bytes", async () => {
  const lab = await makeLab();
  try {
    const { call } = served(lab);
    const none = await call("GET", `/podcasts/${EP_NONE}/audio`, { as: A });
    for (const id of [EP_NONE, EP_ESC, "not-a-uuid", "..%2F..%2Foutside", encodeURIComponent(lab.outside)]) {
      const r = await call("GET", `/podcasts/${id}/audio`, { as: A });
      assert(r.status >= 400 && r.status < 500, `${id}: ${r.status}`);
      assert(!has(r.bytes, SECRET) && !has(r.bytes, AUDIO_A), `${id}: file bytes leaked`);
      if (r.status === 404 && id !== "..%2F..%2Foutside") assertEquals(r.text, none.text, id);
    }
    assertEquals((await call("GET", `/podcasts/${EP_ESC}/audio`, { as: A })).status, 404);
  } finally {
    await Deno.remove(lab.base, { recursive: true });
  }
});

Deno.test("audio: no public or shared-cache header on an unshared episode (nor on a shared one)", async () => {
  const lab = await makeLab();
  try {
    const { call } = served(lab);
    for (const [id, as, range] of [[EP_A, A, ""], [EP_A, A, "bytes=0-1"], [EP_S, B_, ""], [EP_S, A, "bytes=0-1"]]) {
      const r = await call("GET", `/podcasts/${id}/audio`, { as, range: range || undefined });
      const cc = (r.headers.get("cache-control") ?? "").toLowerCase();
      assertEquals(cc, "private, no-store", `${id} ${range}`);
      assert(!/public|s-maxage|proxy-revalidate/.test(cc));
      assert(!r.headers.get("expires") && !r.headers.get("surrogate-control") && !r.headers.get("cdn-cache-control"));
    }
  } finally {
    await Deno.remove(lab.base, { recursive: true });
  }
});

Deno.test("retry: failed -> queued exactly once; the second retry and a non-failed request are refused (409)", async () => {
  const lab = await makeLab();
  try {
    const { call, db } = served(lab);
    const r1 = await call("POST", `/podcasts/requests/${RQ_FAILED}/retry`, { as: A });
    assertEquals(r1.status, 200, r1.text);
    const j = JSON.parse(r1.text);
    assertEquals([j.id, j.state, j.error], [RQ_FAILED, "queued", null]);
    const r2 = await call("POST", `/podcasts/requests/${RQ_FAILED}/retry`, { as: A });
    assertEquals(r2.status, 409, r2.text);
    for (const id of [RQ_QUEUED, RQ_DONE]) assertEquals((await call("POST", `/podcasts/requests/${id}/retry`, { as: A })).status, 409, id);
    assertEquals(db.updates, 1, "one row moved, once");
  } finally {
    await Deno.remove(lab.base, { recursive: true });
  }
});

Deno.test("retry: two retries at once move the request once (one 200, one 409)", async () => {
  const lab = await makeLab();
  try {
    const { call, db } = served(lab);
    const rs = await Promise.all([1, 2, 3].map(() => call("POST", `/podcasts/requests/${RQ_FAILED}/retry`, { as: A })));
    assertEquals(rs.map((r) => r.status).sort(), [200, 409, 409]);
    assertEquals(db.updates, 1);
  } finally {
    await Deno.remove(lab.base, { recursive: true });
  }
});

Deno.test("retry: another user's request answers exactly as a missing one (status and body), and moves nothing", async () => {
  const lab = await makeLab();
  try {
    const rqs: Rq[] = [{ id: RQ_B, requester_sub: B_, state: "failed", error: "B-private-error" }, { id: RQ_FAILED, requester_sub: A, state: "queued", error: null }];
    const { call, db } = served(lab, rqs);
    const missing = await call("POST", `/podcasts/requests/${RQ_NONE}/retry`, { as: A });
    const others = await call("POST", `/podcasts/requests/${RQ_B}/retry`, { as: A });
    const notUuid = await call("POST", `/podcasts/requests/not-a-uuid/retry`, { as: A });
    assertEquals(missing.status, 404);
    assertEquals([others.status, others.text], [missing.status, missing.text]);
    assertEquals([notUuid.status, notUuid.text], [missing.status, missing.text]);
    assert(!others.text.includes("B-private-error") && !others.text.includes("failed"), "nothing of B's row in the answer");
    // A's own queued request IS refused with its state (A can see it), which another user's never is
    assertEquals((await call("POST", `/podcasts/requests/${RQ_FAILED}/retry`, { as: B_ })).text, missing.text);
    assertEquals(rqs[0].state, "failed");
    assertEquals(db.updates, 0);
  } finally {
    await Deno.remove(lab.base, { recursive: true });
  }
});

// ── the production compose file ─────────────────────────────────────────────────────────────
Deno.test("compose: the podcast archive reaches the workbench READ-ONLY, and no other service in this file mounts it", async () => {
  let text: string;
  try {
    text = (await Deno.readTextFile(new URL("../../../docker-compose.yml", import.meta.url))).replace(/\r\n/g, "\n");
  } catch {
    return; // inside the image the compose file is not in the build context
  }
  const lines = text.split("\n");
  const mounts = lines.map((l, i) => [l, i] as const).filter(([l]) => /^\s*-\s*\S*podcasts:\/mounts\/podcast-archive/.test(l));
  assertEquals(mounts.length, 1, `one archive mount in docker-compose.yml: ${mounts.map(([l]) => l.trim()).join(" | ")}`);
  const [line, at] = mounts[0];
  assert(/:\/mounts\/podcast-archive:ro\s*(#.*)?$/.test(line), `the archive mount is read-only: ${line.trim()}`);
  // the service that owns that line: the nearest two-space key above it
  let svc = "";
  for (let i = at; i >= 0 && !svc; i--) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
    if (m) svc = m[1];
  }
  assertEquals(svc, "openbrain-workbench");
});
