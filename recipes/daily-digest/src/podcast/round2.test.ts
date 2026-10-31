// rw-p7a-tts round 2: the tester's defects as tests (D2, D3, the minors). No network beyond loopback.
//
// Run: deno test --allow-read --allow-write --allow-env --allow-run --allow-net=127.0.0.1 src/podcast/round2.test.ts
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { guardNetwork } from "../routine/testing.ts";
import { ArchiveWriter, DestinationRefused, storeDestination } from "./archive.ts";
import { voiceAndArchive } from "./episode-audio.ts";
import { segmentKey, SegmentCache } from "./segment-cache.ts";
import type { Team } from "./presenters.ts";
import { keyEquals, PodcastService, servePodcast } from "./podcast-service.ts";
import { RenderService } from "./render-service.ts";

guardNetwork();

const team: Team = {
  id: "t", name: "t", description: "",
  presenters: [{ id: "a", name: "A", personality: "", backstory: "", language: "en-US", voice: { id: "va", route: "local-tts", voice: "bm_george", speed: 1 } }],
};

function store(resolved: { path: string; reachable: boolean }, value: Record<string, unknown> = { path: resolved.path }) {
  return ((_u: string) =>
    Promise.resolve(Response.json({ key: "podcast.archive_destination", value, version: 2, resolved: { ...resolved, via: "path" } }))) as unknown as typeof fetch;
}

Deno.test("D3: a destination the workbench reports unreachable, outside the mounts root, or not a directory here is REFUSED", async () => {
  const root = await Deno.makeTempDir({ prefix: "r2-mounts-" });
  await Deno.mkdir(`${root}/podcast-archive/alt`, { recursive: true });
  const ok = storeDestination({ workbenchUrl: "http://127.0.0.1:9", key: "k", mountsRoot: root, fetchFn: store({ path: `${root}/podcast-archive/alt`, reachable: true }) });
  assertEquals((await ok()).path, `${root}/podcast-archive/alt`);
  for (const [why, r] of [
    ["reported unreachable", { path: `${root}/podcast-archive/alt`, reachable: false }],
    ["the container's ephemeral fs", { path: "/tmp/tester-ephemeral", reachable: true }],
    ["the recipe mount", { path: "/app", reachable: true }],
    ["missing here", { path: `${root}/podcast-archive/not-made`, reachable: true }],
    ["a dot-dot escape", { path: `${root}/podcast-archive/../../etc`, reachable: true }],
  ] as const) {
    const d = storeDestination({ workbenchUrl: "http://127.0.0.1:9", key: "k", mountsRoot: root, fetchFn: store(r) });
    await assertRejects(() => d(), DestinationRefused, undefined, why);
  }
  await Deno.remove(root, { recursive: true });
});

Deno.test("D3: a refused destination writes NOTHING - no synthesis, no file, no episode row", async () => {
  const root = await Deno.makeTempDir({ prefix: "r2-mounts-" });
  let synth = 0, rows = 0;
  const cache = new SegmentCache(`${root}/cache`, () => {
    synth++;
    return Promise.resolve(new Uint8Array(4800));
  });
  const archive = new ArchiveWriter(storeDestination({ workbenchUrl: "http://127.0.0.1:9", key: "k", mountsRoot: root, fetchFn: store({ path: "/tmp/tester-ephemeral", reachable: true }) }));
  const fakeStore = { recordEpisode: () => (rows++, Promise.resolve("x")) } as unknown as import("./presenter-store.ts").PresenterStore;
  await assertRejects(() =>
    voiceAndArchive({ title: "x", turns: [{ presenterId: "a", text: "hello" }] }, team, { ownerSub: "o", shared: false, slug: "x" },
      { cache, concurrency: 1, ffmpeg: { bin: "ffmpeg" }, archive, store: fakeStore, log: () => {} }), DestinationRefused);
  assertEquals([synth, rows], [0, 0]);
  assertEquals([...Deno.readDirSync(root)].map((e) => e.name), [], "nothing written under the mounts root");
  await Deno.remove(root, { recursive: true });
});

Deno.test("minor: the segment key uses EXACTLY the speed sent to Kokoro (1.0 and 1.0004 differ)", async () => {
  const r = { route: "local-tts", voice: "bm_george", text: "x" };
  assert(await segmentKey({ ...r, speed: 1 }) !== await segmentKey({ ...r, speed: 1.0004 }));
  assertEquals(await segmentKey({ ...r, speed: 1 }), await segmentKey({ ...r, speed: 1.0 }));
});

Deno.test("minor: /render and /transcode refuse a caller without the key (and everything when no key is configured)", async () => {
  const svc = new PodcastService({
    clock: { now: () => Date.now() } as never, tz: "UTC", followUpCutoff: "20:00", store: { dir: "/tmp" } as never, script: "x", runArgs: [],
    cwd: ".", nextTriggerUrl: "", maxRunMs: 1, maxResumes: 0,
  });
  const render = { render: () => Promise.resolve({ status: 202, body: { ok: 1 } }), transcode: () => Promise.resolve({ status: 201, body: { ok: 1 } }) } as unknown as RenderService;
  for (const [renderKey, sent, want] of [["k-0123456789abcdef", "", 401], ["k-0123456789abcdef", "wrong", 401], ["k-0123456789abcdef", "k-0123456789abcdef", 202], ["", "", 401], ["", "anything", 401]] as const) {
    const ac = new AbortController();
    let port = 0;
    const srv = servePodcast(svc, { port: 0, hostname: "127.0.0.1", signal: ac.signal, render, renderKey, onListen: (a) => (port = a.port) });
    const r = await fetch(`http://127.0.0.1:${port}/render`, { method: "POST", headers: sent ? { "x-brain-key": sent } : {}, body: "{}" });
    await r.body?.cancel();
    assertEquals(r.status, want, `key ${renderKey ? "set" : "unset"}, sent "${sent}"`);
    const t = await fetch(`http://127.0.0.1:${port}/transcode`, { method: "POST", headers: sent ? { "x-brain-key": sent } : {}, body: "{}" });
    await t.body?.cancel();
    assertEquals(t.status, want === 202 ? 201 : 401);
    ac.abort();
    await srv.finished;
  }
  assert(keyEquals("abc", "abc") && !keyEquals("abc", "abd") && !keyEquals("abc", "abcd") && !keyEquals("", "a"));
});

Deno.test("D2: the image's default target depends on the test gate (COPY --from=test of the gate's marker)", async () => {
  const df = await Deno.readTextFile(new URL("../../Dockerfile", import.meta.url));
  const stages = df.split(/^FROM /m).slice(1);
  const last = stages.at(-1)!;
  assert(!/ AS test\b/i.test(last.split("\n")[0]), "the last stage is the default target, not the test stage");
  assert(/COPY --from=test \/podcast-test-gate-passed /.test(last), "the default target copies the gate marker from the test stage");
  assert(/touch \/podcast-test-gate-passed/.test(stages.find((s) => / AS test\b/i.test(s.split("\n")[0]))!), "the test stage writes the marker only after its tests");
});
