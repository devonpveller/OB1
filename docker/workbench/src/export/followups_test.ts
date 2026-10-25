// deno test --allow-all src/export/followups_test.ts - rw-p6a-followups (the review r-rw-p6a2's
// follow-ups R3-2 and R2-4). Synthetic secrets of this file's own; no text here is an attack shape - the
// texts are seeded prose, and the over-cap text is a fixture of decodable layers with no secret in it.
//   F-a1  the bound: N concurrent verifications never run more than VERIFY_WORKERS workers in the process,
//         and every worker has ended when they are done (before: each built its own pool, up to 8N)
//   F-a2  no note refused because it queued: N concurrent verifications of a note that passes alone in
//         T, each with a budget of 2.5 T, are all served (the wait for the slot is not the budget's)
//   F-a3  beyond the wait: an export that cannot get the slot within VERIFY_WAIT_MS is refused 503
//         `verification-busy`, stated - never served unchecked; the slot passes to the next in line
//   F-a4  the route answers `verification-busy` 503 (not 422)
//   F-b1  a 422 field withheld because it could not be judged says "could not be judged"; a field that
//         carries the credential keeps "carries the configured service credential" (R2-4, error-as-fact)
//   F-b2  MD and TXT are judged off the export's thread: while a large MD and TXT are verified, a health
//         request to the same process answers within HEALTH_BOUND_MS
import { assert, assertEquals } from "jsr:@std/assert@1";
import * as POOL from "./judge_pool.ts";
import { Budget, OutputRejected, verifyDrawnText, verifyMarkdown, verifyText } from "./verify.ts";
import { createExporter, type ExporterDeps } from "./exporter.ts";
import { createResolver, type ResolverConfig } from "./resolver.ts";
import { fxEntries } from "./registry_fixtures.ts";
import type { ExportRef } from "./repo.ts";
import { RenderFailed } from "./render.ts";
import { secretForms } from "./credentials.ts";
import { fixtureId } from "./test_fixtures.ts";

const KEY = "Pz3Kq8Wn5Rt1Vx7Lm2Jd9Hb4Fc6Gs0Ya"; // synthetic, 32
const MAIL = "q7f.followup-lab@probe.invalid"; // synthetic
const SECRETS = secretForms([KEY, MAIL]);
// the stated bound: the longest a health request may wait while a large MD / TXT export is verified
export const HEALTH_BOUND_MS = 1000;
// a text over the views cap (resolve2_test.ts OVER_CAP): decodable layers, no secret
const OVER_CAP = "Notes: a b ＡＢ <i>x</i> &amp;amp;amp;amp;amp; %2525252541 \\\\* &lt;b&gt;y&lt;/b&gt; QUJDREVGR0hJSktMTU5PUA== <u>z</u> &amp;lt;s&amp;gt;w&amp;lt;/s&amp;gt;";

const WORDS = ("the method reads every source before a claim is made and each result is checked against the " +
  "evidence that a reviewer can open in the notes with a model of the study design sample and measure").split(" ");
function prose(chars: number, seed: number): string {
  let a = seed >>> 0;
  const r = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let out = "";
  while (out.length < chars) {
    const n = 6 + Math.floor(r() * 19);
    const ws: string[] = [];
    for (let i = 0; i < n; i++) ws.push(WORDS[Math.floor(r() * WORDS.length)]);
    out += ws.join(" ") + (r() < 0.15 ? ".\n\n" : ". ");
  }
  return out;
}

// Every Worker the process starts, counted (judge_pool.ts starts them with `new Worker`)
const RealWorker = globalThis.Worker;
const count = { live: 0, peak: 0 };
class CountingWorker extends RealWorker {
  private ended = false;
  constructor(u: string | URL, o?: WorkerOptions) {
    super(u, o);
    count.live++;
    count.peak = Math.max(count.peak, count.live);
  }
  override terminate() {
    if (!this.ended) {
      this.ended = true;
      count.live--;
    }
    super.terminate();
  }
}
async function counted<T>(f: () => Promise<T>): Promise<T> {
  globalThis.Worker = CountingWorker as typeof Worker;
  count.live = 0;
  count.peak = 0;
  try {
    return await f();
  } finally {
    globalThis.Worker = RealWorker;
  }
}
const outcome = async (f: () => Promise<unknown>) => {
  try {
    await f();
    return "served";
  } catch (e) {
    return e instanceof OutputRejected ? e.code : `error: ${(e as Error).message}`;
  }
};
// one "export": the drawn text of a long note - 24 texts of 30 000 characters, judged in workers
const NOTE_TEXTS = Array.from({ length: 24 }, (_, i) => prose(30_000, 9100 + i));
const N = 4;

Deno.test(`F-a1 (bound): ${N} concurrent verifications run at most VERIFY_WORKERS (${POOL.VERIFY_WORKERS}) workers in the process, all served, and none is left when they end`, async () => {
  const got = await counted(() => Promise.all(Array.from({ length: N }, () => outcome(() => verifyDrawnText(NOTE_TEXTS, SECRETS, "pdf")))));
  console.log(`F-a1: ${N} concurrent: ${JSON.stringify(got)} | workers at most ${count.peak} at once (bound ${POOL.VERIFY_WORKERS}) | live after ${count.live}`);
  assertEquals(got, Array(N).fill("served"));
  assert(count.peak >= 1, "the texts were judged in workers");
  assert(count.peak <= POOL.VERIFY_WORKERS, `${count.peak} workers at once, over the bound of ${POOL.VERIFY_WORKERS}`);
  assertEquals(count.live, 0, "a worker outlived the verifications");
});

Deno.test(`F-a2 (no refusal for queueing): ${N + 2} concurrent verifications of a note that passes alone in T, each with a budget of 2.5 T, are all served`, async () => {
  await verifyDrawnText(NOTE_TEXTS.slice(0, 2), SECRETS, "pdf"); // warm
  const t0 = performance.now();
  assertEquals(await outcome(() => verifyDrawnText(NOTE_TEXTS, SECRETS, "pdf", new Budget())), "served");
  const alone = performance.now() - t0;
  const ms = Math.max(400, Math.round(alone * 2.5));
  const got = await Promise.all(Array.from({ length: N + 2 }, () => outcome(() => verifyDrawnText(NOTE_TEXTS, SECRETS, "pdf", new Budget(ms)))));
  console.log(`F-a2: alone ${alone.toFixed(0)} ms; ${N + 2} concurrent with ${ms} ms each: ${JSON.stringify(got)}`);
  assertEquals(got, Array(N + 2).fill("served"), "a note that passes alone was refused because other exports ran");
});

Deno.test("F-a3 (beyond the wait): an export that cannot get the slot in time is refused 503 verification-busy, stated; the slot then passes on", async () => {
  const slot = (POOL as Record<string, unknown>).verificationSlot as { acquire(): Promise<() => void>; waitMs: number } | undefined;
  assert(slot, "judge_pool.ts has a process-wide verification slot");
  const keep = slot.waitMs;
  slot.waitMs = 150;
  const release = await slot.acquire();
  try {
    let e: unknown = null;
    try {
      await verifyText("A plain paragraph, nothing in it.", SECRETS);
    } catch (x) {
      e = x;
    }
    assert(e instanceof OutputRejected, `not refused: ${e}`);
    assertEquals(e.code, "verification-busy");
    assert(/one export at a time/.test(e.message) && /try again/.test(e.message), e.message);
    // a waiter that gets the slot in time is served (released while it waits)
    slot.waitMs = 5_000;
    const waiting = outcome(() => verifyText("Another plain paragraph.", SECRETS));
    await new Promise((r) => setTimeout(r, 100));
    release();
    assertEquals(await waiting, "served");
  } finally {
    release();
    slot.waitMs = keep;
  }
  // inert (no secrets): nothing to judge, no slot taken
  const r2 = await slot.acquire();
  try {
    slot.waitMs = 50;
    assertEquals(await outcome(() => verifyText("A plain paragraph.", [])), "served");
  } finally {
    r2();
    slot.waitMs = keep;
  }
});

// ── the route ────────────────────────────────────────────────────────────────────────────────────
const CSL_DIR = new URL("../../csl", import.meta.url).pathname;
const CLIENT = { close() {} } as unknown as Deno.HttpClient;
function route(titles: string[], render?: ExporterDeps["render"]) {
  const cfg: ResolverConfig = {
    openalexKey: KEY, mailto: MAIL, proxyUrl: "http://proxy.invalid:8888",
    openalexBase: "http://api.openalex.stub", crossrefBase: "http://api.crossref.stub", timeoutMs: 2000,
  };
  const refs = (): ExportRef[] => titles.map((title, i) => ({
    number: i + 1, cited_ref: fixtureId(i + 1), reference_id: `ref-${i + 1}`, pinned_revision: 1, source_id: fixtureId(i + 1), suppressed: false,
    title, url: `https://doi.org/10.5555/p6a.dead${i}`, metadata: {}, accessed: "2026-10-20", cached: [],
  } as unknown as ExportRef));
  const note = `# F\n\n${titles.map((_, i) => `Claim [[source/${fixtureId(i + 1)}|c${i + 1}]].`).join("\n\n")}\n`;
  const deps = {
    reg: { entries: (r: string) => Promise.resolve(fxEntries(r)) },
    resolver: createResolver(cfg, { fetch: () => Promise.resolve(Response.json({ error: "no" }, { status: 404 })), buildClient: () => CLIENT, log: () => {} }),
    cslDir: CSL_DIR, vaultDir: "/nonexistent-vault",
    readNote: (rel: string) => Promise.resolve(rel === "notes/t/n.md" ? note : null),
    loadRefs: () => Promise.resolve(refs()),
    cache: () => Promise.resolve(),
    log: () => {},
    ...(render ? { render } : {}),
  } as unknown as ExporterDeps;
  const app = createExporter(deps);
  return { get: (q: string) => app.request(`/?${q}`), close: () => deps.resolver.close() };
}

Deno.test("F-a4 (route): verification-busy is a 503 with its code", async () => {
  const w = route([], () => Promise.reject(new RenderFailed("the pdf export was not served: it was not checked (busy); try again", "", "verification-busy" as never)));
  try {
    const r = await w.get("path=notes/t/n.md&format=pdf");
    const b = await r.json();
    assertEquals([r.status, b.code], [503, "verification-busy"]);
  } finally {
    w.close();
  }
});

Deno.test("F-b1 (422 field): a title withheld because it could not be judged says 'could not be judged'; a title carrying the key says it carries the credential", async () => {
  const w = route([OVER_CAP, `Key ${KEY} here`, "An ordinary record title"]);
  try {
    const r = await w.get("path=notes/t/n.md&format=txt");
    const body = await r.text();
    assertEquals(r.status, 422, body.slice(0, 300));
    const refs = JSON.parse(body).references as { number: number; title: string | null; withheld?: string }[];
    const by = (n: number) => refs.find((x) => x.number === n)!;
    console.log(`F-b1: ${JSON.stringify(refs.map((x) => [x.number, x.title === null ? null : "kept", x.withheld ?? null]))}`);
    assertEquals(by(1).title, null);
    assert(/title withheld: it could not be judged/.test(by(1).withheld ?? ""), `over-cap: ${by(1).withheld}`);
    assert(!/carries/.test(by(1).withheld ?? ""), `an unjudged field described as carrying the credential: ${by(1).withheld}`);
    assertEquals(by(2).title, null);
    assert(/title withheld: it carries the configured service credential/.test(by(2).withheld ?? ""), `key: ${by(2).withheld}`);
    assert(!/could not be judged/.test(by(2).withheld ?? ""), `key: ${by(2).withheld}`);
    assertEquals(by(3).title, "An ordinary record title");
    assertEquals(by(3).withheld, undefined);
    assert(!body.includes(KEY), "the body carries the key");
  } finally {
    w.close();
  }
});

Deno.test(`F-b2 (off the thread): while a large MD and a large TXT are verified, a health request to the same process answers within ${HEALTH_BOUND_MS} ms`, async () => {
  const big = prose(800_000, 4401);
  const ac = new AbortController();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} }, () => new Response("ok"));
  const url = `http://127.0.0.1:${server.addr.port}/health`;
  const lat: number[] = [];
  let done = false;
  const probe = (async () => {
    while (!done) {
      const t0 = performance.now();
      await (await fetch(url)).text();
      lat.push(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 25));
    }
  })();
  try {
    await new Promise((r) => setTimeout(r, 100));
    const t0 = performance.now();
    const got = [await outcome(() => verifyText(big, SECRETS)), await outcome(() => verifyMarkdown(big, SECRETS))];
    const took = performance.now() - t0;
    done = true;
    await probe;
    const worst = Math.max(...lat);
    console.log(`F-b2: txt + md of ${big.length} characters verified in ${took.toFixed(0)} ms: ${JSON.stringify(got)} | ${lat.length} health requests, the slowest ${worst.toFixed(0)} ms (bound ${HEALTH_BOUND_MS} ms)`);
    assertEquals(got, ["served", "served"]);
    assert(worst < HEALTH_BOUND_MS, `a health request waited ${worst.toFixed(0)} ms`);
    assert(lat.length >= 5, "health was probed during the verification");
  } finally {
    done = true;
    ac.abort();
    await server.finished;
  }
});
