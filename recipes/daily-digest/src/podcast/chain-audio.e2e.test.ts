// The daily chain voices its episode without Open Notebook (research-workbench P7a, rw-p7a-tts C2).
//
// The REAL runner (link-enrich.ts --commit --audio) as a subprocess, exactly as openbrain-podcast
// spawns it, against loopback stubs: the LiteLLM gateway (chat for the script, /v1/audio/speech for
// the voices), the brain (one newsletter + the presenter model's team through PostgREST), the research
// engine, the workbench's configuration store (podcast.archive_destination), and an Open Notebook
// SINKHOLE that records every request. ON_BASE is set to the sinkhole on purpose - as if the old
// setting were still in the environment - and egress is fail-closed (HTTP(S)_PROXY to a dead port).
//
// PASS: the episode is archived where the store says (audio + sidecar + transcript), every turn was
// voiced through the gateway's /audio/speech with this service's key and each presenter's voice, and
// the sinkhole saw ZERO requests. Needs ffmpeg (the image's build gate runs it).
//
// Run: deno test --allow-all src/podcast/chain-audio.e2e.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { guardNetwork, NEWSLETTER_BODY, stubServer } from "../routine/testing.ts";
import { dirOf } from "./podcast-service.ts";

guardNetwork();
const RECIPE = dirOf(new URL("../../link-enrich.ts", import.meta.url).href);
const DATE = "2026-10-30";

async function hasFfmpeg(): Promise<boolean> {
  try {
    return (await new Deno.Command("ffmpeg", { args: ["-version"], stdout: "null", stderr: "null" }).output()).success;
  } catch {
    return false;
  }
}
const ffmpeg = await hasFfmpeg();

const SCRIPT = "HOST A: Good morning, it is October 30th.\nHOST B: Morning! Routing notes today.\nHOST A: The stack recovers after an outage.\nHOST B: And the brief waits for the model. Bye!";

const TEAM = [{
  id: "team-e2e", name: "tech_experts", description: "",
  podcast_team_members: [
    { position: 1, podcast_presenters: { id: "p-b", name: "Jamie", personality: "Enthusiastic", backstory: "", language: "en-US", podcast_voice_links: { id: "v-b", route: "local-tts", voice: "bf_emma", speed: 1 } } },
    { position: 0, podcast_presenters: { id: "p-a", name: "Alex", personality: "Analytical", backstory: "", language: "en-US", podcast_voice_links: { id: "v-a", route: "local-tts", voice: "bm_george", speed: 1 } } },
  ],
}];

Deno.test({
  name: "C2 the daily chain renders and archives an episode with NO request to Open Notebook",
  ignore: !ffmpeg && Deno.env.get("PODCAST_REQUIRE_FFMPEG") !== "1",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    assert(ffmpeg, "PODCAST_REQUIRE_FFMPEG=1 and no ffmpeg");
    const dir = await Deno.makeTempDir({ prefix: "chain-audio-e2e-" });
    const archive = `${dir}/archive`;
    await Deno.mkdir(archive, { recursive: true });
    const on: string[] = [];
    const speech: { voice: string; model: string; auth: string }[] = [];
    const prompts: string[] = [];
    const episodes: Record<string, unknown>[] = [];
    let settingReads = 0;
    const sink = stubServer((req, path) => {
      on.push(`${req.method} ${path}`);
      return Response.json({ job_id: "x", status: "queued" });
    });
    const gw = stubServer(async (req, path) => {
      if (req.method === "GET" && path === "/health/liveliness") return new Response(`"I'm alive!"`);
      if (req.method === "GET") return new Response("GET refused by the stub", { status: 599 });
      const body = await req.json().catch(() => ({})) as Record<string, any>;
      if (path === "/v1/audio/speech") {
        speech.push({ voice: body.voice, model: body.model, auth: req.headers.get("authorization") ?? "" });
        return new Response(new Uint8Array(24_000)); // 0.5 s of PCM silence
      }
      const sys = (body.messages ?? [])[0]?.content ?? "";
      prompts.push(sys);
      const content = body.max_tokens === 1 ? "p" : sys.includes("TWO-HOST") ? SCRIPT : sys.includes("PRIMARY topic") ? "routing notes" : "VERDICT: KEEP\nok";
      return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } });
    });
    const thought = {
      id: "t1", content: `[Email from Test Letter <letter@example.test> | Subject: Routing notes | Date: ${DATE}]\n${NEWSLETTER_BODY}`,
      metadata: { gmail_id: "g1", gmail_thread_id: "g1", gmail_labels: ["brain/test"], chunk_index: 0, chunk_count: 1, email_date: `${DATE}T04:00:00Z`, topics: ["inference"] },
      created_at: `${DATE}T04:00:00Z`,
    };
    const brain = stubServer(async (req, path) => {
      const u = new URL(req.url);
      if (req.method === "GET" && /^\/rest\/v1\/thoughts$/.test(path)) {
        if (u.searchParams.getAll("metadata->>type").some((f) => f.startsWith("eq."))) return Response.json([]);
        return Response.json([thought]);
      }
      if (req.method === "GET" && path === "/rest/v1/podcast_teams") {
        const ok = u.searchParams.get("owner_sub") === "eq.e2e-owner" && (u.searchParams.get("name") === "eq.tech_experts" || u.searchParams.get("id") === "eq.tech_experts");
        return Response.json(ok && u.searchParams.has("name") ? TEAM : []);
      }
      if (req.method === "POST" && path === "/rest/v1/podcast_episodes") {
        const b = await req.json();
        episodes.push(b);
        return Response.json([{ id: "e7e2e000-0000-4000-8000-000000000001", ...b }]);
      }
      return Response.json([]);
    });
    const workbench = stubServer((req, path) => {
      if (path === "/workbench/contract/settings/podcast.archive_destination" && req.headers.get("x-brain-key") === "test") {
        settingReads++;
        return Response.json({ key: "podcast.archive_destination", value: { path: archive }, is_default: false, version: 3, resolved: { path: archive, reachable: true, via: "path" } });
      }
      return new Response("nf", { status: 404 });
    });
    const engine = stubServer(async (req, path) => {
      if (req.method === "POST" && path === "/research") {
        await req.json();
        return Response.json({ job_id: "00000000-0000-0000-0000-000000000001", status: "queued" }, { status: 202 });
      }
      if (/^\/research\/jobs\//.test(path)) {
        return Response.json({ id: "j", status: "done", result: { synthesis: "[SOURCED] Routing recovers after an outage [Source 1]\n[SOURCED] The brief waits for the model [Source 1]", reuse_claims: [] } });
      }
      return new Response("nf", { status: 404 });
    });
    try {
      const out = await new Deno.Command("deno", {
        args: ["run", "--unstable-net", "-A", "link-enrich.ts", "--commit", "--audio"],
        cwd: RECIPE,
        env: {
          MCP_ACCESS_KEY: "test", BRAIN_REST_URL: brain.url, RESEARCH_URL: engine.url, CHAT_API_BASE: `${gw.url}/v1`, CHAT_API_KEY: "sk-chat",
          PODCAST_TTS_KEY: "sk-podcast-tts", PODCAST_TEAM: "tech_experts", PODCAST_OWNER_SUB: "e2e-owner", WORKBENCH_URL: workbench.url,
          PODCAST_SEGMENT_CACHE_DIR: `${dir}/cache`, REPORTS_DIR: `${dir}/reports`, FETCH_PROXY_URL: "", GAP_DIVE_ENABLED: "0",
          GMAIL_READ_CREDENTIALS: `${dir}/absent-credentials.json`, GMAIL_READ_TOKEN: `${dir}/absent-token.json`,
          ROUTINE_DATE: DATE, ROUTINE_STATE_DIR: `${dir}/reports/routine`, MODEL_WAIT_UNTIL_MS: String(Date.now() + 60_000),
          MODEL_GATE_INITIAL_MS: "200", MODEL_GATE_MAX_MS: "500", RESEARCH_POLL_MS: "100", RESEARCH_WAIT_MS: "20000",
          // the OLD setting, pointed at the sinkhole: nothing may use it
          ON_BASE: sink.url, ON_PUBLIC_BASE: sink.url, ON_JOB_WAIT_MS: "2000", ON_AUDIO_ATTEMPTS: "1",
          HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost",
        },
        stdout: "piped", stderr: "piped",
      }).output();
      const log = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
      assertEquals(out.code, 0, log.slice(-3000));
      assertEquals(on, [], "no request reached the Open Notebook sinkhole");
      assertEquals(speech.length, 4, `every turn voiced through the gateway: ${log.slice(-1500)}`);
      assertEquals(speech.map((s) => s.voice), ["bm_george", "bf_emma", "bm_george", "bf_emma"]);
      assert(speech.every((s) => s.model === "local-tts" && s.auth === "Bearer sk-podcast-tts"), "route local-tts, this service's own key");
      assert(prompts.some((p) => p.includes("HOST A is Alex.") && p.includes("HOST B is Jamie.")), "the script prompt carries the cast");
      assert(settingReads >= 1, "the archive destination was read from the configuration store");
      const renders = [...Deno.readDirSync(`${archive}/renders`)].map((e) => e.name);
      assertEquals(renders.length, 1);
      const epDir = `${archive}/renders/${renders[0]}`;
      const sc = JSON.parse(await Deno.readTextFile(`${epDir}/sidecar.json`));
      assertEquals([sc.origin, sc.owner_sub, sc.destination.path, sc.destination.version, sc.audio.format], ["render", "e2e-owner", archive, 3, "mp3"]);
      assert((await Deno.stat(`${epDir}/audio.mp3`)).size > 0 && (await Deno.stat(`${epDir}/transcript.json`)).isFile);
      assertEquals(episodes.length, 1);
      assertEquals([episodes[0].owner_sub, episodes[0].origin, episodes[0].archive_dir], ["e2e-owner", "render", epDir]);
    } finally {
      await Promise.all([sink.close(), gw.close(), brain.close(), workbench.close(), engine.close()]);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
