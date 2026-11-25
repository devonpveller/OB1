// rwr-episode-from: the render service voices requests made from a run, a report, a document, an idea and a topic - in
// the lab, with fixtures. SKIPPED unless EPF_WORLD is set (docker/workbench/contract-test/run-episode-from-tests.ps1 sets it
// after episode_from_integration_test.ts wrote the planted world: A's and B's requests, queued).
//
// What is REAL: the render service (RenderService over the real registry), the presenter store through the lab's PostgREST,
// ffmpeg (this is the podcast image's test stage), the archive writer, the workbench's share routes. What is STUB: the
// gateway (chat + speech), on loopback, so it can record who called it with which key and what it was sent.
//
// Environment: EPF_WORLD (a JSON file), EPF_WB_BASE, EPF_WB_KEY, EPF_SUB_HEADER (default X-Test-Sub), EPF_REST (PostgREST),
// EPF_OUT (a directory for the archive and the log of this run).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { stubServer } from "../routine/testing.ts";
import { ArchiveWriter } from "./archive.ts";
import { PresenterStore } from "./presenter-store.ts";
import { RenderService } from "./render-service.ts";
import { SegmentCache } from "./segment-cache.ts";
import { gatewaySpeech } from "./tts-client.ts";
import { makeScriptChat } from "./script-renderer.ts";
import { INPUT_KINDS } from "./input-kinds.ts";

const WORLD = Deno.env.get("EPF_WORLD") ?? "";
const ignore = !WORLD;
const hasFfmpeg = await new Deno.Command("ffmpeg", { args: ["-version"], stdout: "null", stderr: "null" }).output().then((o) => o.success).catch(() => false);

interface World {
  A: string; B: string; teamA: string; teamB: string;
  requests: Record<string, string>; // kind -> request id (A's), plus "topicB" (B's)
  markers: Record<string, string>;
  topicText: string;
}

Deno.test({
  name: "each of run, report, document, idea and topic renders from its fixture; the episode is private; nothing private is logged or sent off the lab",
  ignore: ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    assert(hasFfmpeg, "the podcast image's test stage has ffmpeg");
    const w = JSON.parse(await Deno.readTextFile(WORLD)) as World;
    const WB = (Deno.env.get("EPF_WB_BASE") ?? "").replace(/\/+$/, "");
    const KEY = Deno.env.get("EPF_WB_KEY") ?? "";
    const SUB = Deno.env.get("EPF_SUB_HEADER") ?? "X-Test-Sub";
    const REST = Deno.env.get("EPF_REST") ?? "";
    const out = Deno.env.get("EPF_OUT") ?? await Deno.makeTempDir({ prefix: "epf-e2e-" });
    const archiveDir = `${out}/archive`;
    await Deno.mkdir(archiveDir, { recursive: true });

    // everything this process logs or warns, kept: the markers must not be in it
    const logged: string[] = [];
    const real = { log: console.log, warn: console.warn, error: console.error };
    for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };

    // every host this process fetched: the gateway stub, the workbench and PostgREST only
    const hosts = new Set<string>();
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((i: string | URL | Request, init?: RequestInit) => {
      hosts.add(new URL(i instanceof Request ? i.url : String(i)).host);
      return realFetch(i, init);
    }) as typeof fetch;

    const calls: { path: string; auth: string; system: string; user: string }[] = [];
    const gw = stubServer(async (req, path) => {
      const body = await req.json().catch(() => ({})) as Record<string, any>;
      const auth = req.headers.get("authorization") ?? "";
      if (path === "/v1/audio/speech") {
        calls.push({ path, auth, system: "", user: "" });
        return new Response(new Uint8Array(24_000)); // 0.5 s of PCM silence
      }
      const msgs = (body.messages ?? []) as { content: string }[];
      calls.push({ path, auth, system: msgs[0]?.content ?? "", user: msgs[1]?.content ?? "" });
      const script = "HOST A: Today we look at what you brought us.\nHOST B: And it is worth a few minutes.\nHOST A: That is the whole of it.";
      return Response.json({ choices: [{ message: { role: "assistant", content: script }, finish_reason: "stop" }] });
    });

    const call = async (method: string, path: string, body: unknown, sub: string) => {
      const r = await realFetch(`${WB}/workbench/contract${path}`, {
        method, headers: { "x-brain-key": KEY, [SUB]: sub, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
    };
    const rest = async (path: string) => (await (await realFetch(`${REST}/rest/v1/${path}`, { headers: { accept: "application/json" } })).json()) as Record<string, any>[];

    try {
      const svc = new RenderService({
        store: new PresenterStore(REST),
        cache: new SegmentCache(`${out}/cache`, gatewaySpeech({ apiBase: `${gw.url}/v1`, apiKey: "sk-podcast-tts" })),
        archive: new ArchiveWriter(() => Promise.resolve({ path: archiveDir, value: {}, version: 1, via: "lab" })),
        destination: () => Promise.resolve({ path: archiveDir, value: {}, version: 1, via: "lab" }),
        ffmpeg: { bin: "ffmpeg" }, concurrency: 2, restBase: REST, kinds: INPUT_KINDS,
        chat: makeScriptChat({ chatApiBase: `${gw.url}/v1`, chatModel: "local-large", apiKey: "sk-chat", label: "episode-from", attempts: 1, retryDelayMs: 0, withholdBody: true }),
      });

      const episodes: Record<string, string> = {};
      for (const kind of ["idea", "run", "report", "document", "topic"]) {
        const id = w.requests[kind];
        const r = await svc.render({ request_id: id });
        assertEquals(r.status, 202, `${kind}: ${JSON.stringify(r.body)}`);
        let row: Record<string, any> = {};
        for (let i = 0; i < 120; i++) {
          row = (await rest(`podcast_render_requests?id=eq.${id}&select=state,error,episode_id`))[0];
          if (row.state === "done" || row.state === "failed") break;
          await new Promise((ok) => setTimeout(ok, 500));
        }
        assertEquals(row.state, "done", `${kind} rendered: ${row.error}`);
        episodes[kind] = row.episode_id;
        const ep = (await rest(`podcast_episodes?id=eq.${row.episode_id}&select=owner_sub,shared,title,origin,archive_dir,request_id`))[0];
        assertEquals(ep.owner_sub, w.A, `${kind}: A's episode`);
        assertEquals(ep.shared, false, `${kind}: starts private (shared = false)`);
        assertEquals(ep.request_id, id);
        assert(!Object.values(w.markers).some((m) => String(ep.title).includes(m)), `${kind}: the episode title is the chosen one`);
        assert((await Deno.stat(`${ep.archive_dir}/episode.mp3`).catch(() => null))?.isFile ?? false, `${kind}: audio archived`);
        const side = JSON.parse(await Deno.readTextFile(`${ep.archive_dir}/archive.json`).catch(() => "{}"));
        if (side.shared !== undefined) assertEquals(side.shared, false, `${kind}: sidecar says private`);
        // the material reached the script writer (the gateway), and only there
        const prompts = calls.filter((c) => c.path === "/v1/chat/completions" && c.user.includes(kind === "topic" ? w.topicText : w.markers[kind === "document" ? "doc" : kind]));
        assert(prompts.length >= 1, `${kind}: the writer was given the material`);
      }

      // the gateway: every call carried a virtual key, nothing else was contacted
      assert(calls.length > 0 && calls.every((c) => /^Bearer sk-/.test(c.auth)), "every gateway call carries a LiteLLM virtual key");
      assert([...hosts].every((h) => h === new URL(gw.url).host || h === new URL(WB).host || h === new URL(REST).host), `only the lab's hosts were contacted: ${[...hosts].join(", ")}`);

      // nothing private in this process's log, in any request's error, or in any episode row
      const all = logged.join("\n");
      for (const [k, m] of Object.entries(w.markers)) assert(!all.includes(m), `the render service's log carries A's ${k} marker`);
      const reqs = await rest(`podcast_render_requests?requester_sub=eq.${w.A}&select=error,state`);
      for (const r of reqs) for (const m of Object.values(w.markers)) assert(!String(r.error ?? "").includes(m), "a request error carries a marker");
      const eps = await rest(`podcast_episodes?select=title,transcript,owner_sub`);
      for (const e of eps) for (const m of Object.values(w.markers)) assert(!String(e.title).includes(m), "an episode title carries a marker");

      // the share step, end to end on a rendered episode: preview, B sees nothing, confirm, B sees it
      const ep = episodes.idea;
      const pv = await call("GET", `/podcasts/${ep}/share-preview`, undefined, w.A);
      assertEquals(pv.status, 200, pv.text);
      assert(pv.json.would_share.some((i: any) => i.type === "idea"), "the list names the idea it was made from");
      assert((await call("GET", "/podcasts?limit=200", undefined, w.B)).json.podcasts.every((p: any) => p.id !== ep), "B does not see it before it is shared");
      assertEquals((await call("PATCH", `/podcasts/${ep}`, { shared: true }, w.A)).status, 409, "no digest, no share");
      assertEquals((await call("PATCH", `/podcasts/${ep}`, { shared: true, share_digest: pv.json.share_digest }, w.B)).status, 404, "B cannot share A's");
      assertEquals((await call("PATCH", `/podcasts/${ep}`, { shared: true, share_digest: pv.json.share_digest }, w.A)).status, 200);
      assert((await call("GET", "/podcasts?limit=200", undefined, w.B)).json.podcasts.some((p: any) => p.id === ep), "B sees it once the owner confirmed");
    } finally {
      for (const k of ["log", "warn", "error"] as const) console[k] = real[k];
      globalThis.fetch = realFetch;
      await gw.close();
    }
  },
});
