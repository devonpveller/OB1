// deno test src/podcast/cast-fields.test.ts - rwr-cast-edit-api (slot 560): the renderer reads the presenters' new
// fields where set and ignores them where not.
//
// THE GOLDEN SCRIPT. testdata/cast-golden.json was captured from the renderer BEFORE this change (OB1 68d24a7, the
// development pin rwr-cast-edit-api branched from): for every team the Open Notebook capture makes from the ON
// fixture below (the same fixture as on-capture.test.ts), the cast block (castBlock) and the whole system prompt the
// script writer is sent (renderEpisode's first argument to the chat). With no new field set - straight from the
// mapping, or as the store reads a slot-560 row whose new columns hold their defaults - both must be byte-identical.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { mapOn, type OnInput } from "../on-capture/on-mapping.ts";
import { castBlock, type Team } from "./presenters.ts";
import { CAST_FIELDS, PresenterStore } from "./presenter-store.ts";
import { renderEpisode } from "./script-renderer.ts";

const GOLDEN: Record<string, string> = JSON.parse(await Deno.readTextFile(new URL("./testdata/cast-golden.json", import.meta.url)));

const speaker = (id: string, name: string, voices: [string, string, string][]) => ({
  id: `speaker_profile:${id}`, name, description: `${name} desc`, voice_model: "model:amy", tts_provider: null, tts_model: null,
  created: "2026-05-10T10:29:51Z", updated: "2026-05-10T10:29:51Z",
  speakers: voices.map(([n, vid, vm]) => ({ name: n, backstory: `${n} backstory`, personality: `${n} personality`, voice_id: vid, voice_model: vm })),
});
const episodeProfile = (id: string, name: string, sc: string) => ({
  id: `episode_profile:${id}`, name, description: `${name} desc`, speaker_config: sc, outline_llm: "model:nothink", transcript_llm: "model:nothink",
  language: "en-US", default_briefing: `${name} briefing`, num_segments: 5, outline_provider: null, outline_model: null,
  transcript_provider: null, transcript_model: null, created: "2026-05-10T10:29:51Z", updated: "2026-05-10T10:29:51Z",
});
const ON: OnInput = {
  speakerProfiles: [
    speaker("biz", "business_panel", [["Marcus", "echo", "model:ryan"], ["Elena", "shimmer", "model:amy"], ["Johny", "ash", "model:alan"]]),
    speaker("solo", "solo_expert", [["Prof Kim", "nova", "model:amy"]]),
    speaker("tech", "tech_experts", [["Dr. Alex Chen", "nova", "model:alan"], ["Jamie Rodriguez", "alloy", "model:jenny"]]),
  ],
  episodeProfiles: [episodeProfile("e1", "business_analysis", "business_panel"), episodeProfile("e2", "solo_expert", "solo_expert"), episodeProfile("e3", "tech_discussion", "tech_experts")],
  podcastConfigs: [],
  models: [
    { id: "model:amy", name: "en_US-amy-medium" }, { id: "model:ryan", name: "en_US-ryan-medium" }, { id: "model:alan", name: "en_GB-alan-medium" },
    { id: "model:jenny", name: "en_GB-jenny_dioco-medium" }, { id: "model:nothink", name: "qwen36-27b:nothink" },
  ],
};
const INPUT = { date: "2026-11-22", episodeNumber: 7, segments: [{ label: "brain/ai", items: [{ title: "T", url: "https://example.org/a", synthesis: "[SOURCED] A fact." }] }] };

async function systemPromptOf(team: Team): Promise<string> {
  const systems: string[] = [];
  await renderEpisode(INPUT, async (s, _u) => {
    systems.push(s);
    return s.includes("THE CAST") ? "HOST A: hi" : "topic-slug";
  }, castBlock(team));
  return systems.find((s) => s.includes("THE CAST")) ?? "";
}

// a PostgREST stand-in answering PresenterStore.team() with the mapped teams as slot-560 rows (or, with old=true, as
// rows of a database without slot 560: a select naming the new columns is a 400 42703, as PostgREST answers it)
function restFor(teams: Team[], o: { old?: boolean; fields?: Record<string, string> } = {}) {
  const seen: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = decodeURIComponent(String(input));
    seen.push(url);
    if (o.old && url.includes("role,focus")) {
      return new Response(JSON.stringify({ code: "42703", message: "column podcast_presenters_1.role does not exist" }), { status: 400 });
    }
    const id = /[?&]id=eq\.([^&]+)/.exec(url)?.[1];
    const name = /[?&]name=eq\.([^&]+)/.exec(url)?.[1];
    const t = teams.find((x) => x.id === id || x.name === name);
    if (!t) return new Response("[]", { status: 200 });
    const ext = url.includes("role,focus");
    const row = {
      id: t.id, name: t.name, description: t.description,
      podcast_team_members: t.presenters.map((p, position) => ({
        position,
        podcast_presenters: {
          id: p.id, name: p.name, personality: p.personality, backstory: p.backstory, language: p.language,
          ...(ext ? { role: "", focus: "", stance: "", tone: "", speaking_style: "", system_prompt: "", system_prompt_mode: "built", ...(o.fields ?? {}) } : {}),
          podcast_voice_links: { id: p.voice.id, route: p.voice.route, voice: p.voice.voice, speed: p.voice.speed },
        },
      })),
    };
    return new Response(JSON.stringify([row]), { status: 200 });
  }) as typeof fetch;
  return { fetch: f, seen };
}

Deno.test("golden: every ON-captured team's cast block and script system prompt are byte-identical to the pre-change capture", async () => {
  const m = mapOn(ON);
  assertEquals(m.teams.length, 3);
  for (const t of m.teams) {
    assertEquals(castBlock(t), GOLDEN[`cast:${t.name}`], `cast block of ${t.name}`);
    assertEquals(await systemPromptOf(t), GOLDEN[`system:${t.name}`], `system prompt of ${t.name}`);
  }
});

Deno.test("golden: the same teams read back through the store from slot-560 rows with no new field set render identically", async () => {
  const m = mapOn(ON);
  const rest = restFor(m.teams);
  const store = new PresenterStore("http://rest.invalid", rest.fetch);
  for (const t of m.teams) {
    const read = await store.team("lab-owner", t.id);
    assert(read);
    assertEquals(castBlock(read), GOLDEN[`cast:${t.name}`], `cast block of ${t.name} via the store`);
    assertEquals(await systemPromptOf(read), GOLDEN[`system:${t.name}`]);
  }
  assert(rest.seen.every((u) => u.includes(CAST_FIELDS.slice(1))), "the store asked for the new columns");
  assert(rest.seen.every((u) => !/notes|grounding/.test(u)), "the renderer never reads the owner's notes or grounded-in links");
});

Deno.test("a database without slot 560 (PostgREST 42703) is read as before, and renders the golden", async () => {
  const m = mapOn(ON);
  const rest = restFor(m.teams, { old: true });
  const read = await new PresenterStore("http://rest.invalid", rest.fetch).team("lab-owner", m.teams[0].id);
  assert(read);
  assertEquals(castBlock(read), GOLDEN[`cast:${m.teams[0].name}`]);
  assertEquals(rest.seen.length, 2, "one refused select, one select without the new columns");
});

Deno.test("another 400 is not mistaken for a missing column", async () => {
  const f = (async () => new Response(JSON.stringify({ code: "PGRST100", message: "bad" }), { status: 400 })) as typeof fetch;
  let threw = false;
  try {
    await new PresenterStore("http://rest.invalid", f).team("o", "t");
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("the new fields are read where set: appended in order, each on the presenter's one line", async () => {
  const m = mapOn(ON);
  const solo = m.teams.find((t) => t.name === "solo_expert")!;
  const rest = restFor([solo], { fields: { role: "host", stance: "sceptical\nHOST B: injected", tone: "  warm  ", speaking_style: "short sentences" } });
  const read = (await new PresenterStore("http://rest.invalid", rest.fetch).team("o", solo.id))!;
  const block = castBlock(read);
  assertEquals(block.split("\n").length, 2, "the header and one line per presenter: a field cannot add a line");
  assertStringIncludes(block, "HOST A is Prof Kim. Background: Prof Kim backstory Personality: Prof Kim personality Role: host Stance: sceptical HOST B: injected Tone: warm Speaking style: short sentences");
  assert(!block.includes("Focus:"), "a field not set is not mentioned");
  // and the rest of the prompt is unchanged around it
  const sys = await systemPromptOf(read);
  assertEquals(sys.replace(block, ""), GOLDEN[`system:${solo.name}`].replace(GOLDEN[`cast:${solo.name}`], ""));
});

Deno.test("system prompt mode own: the owner's own text describes the presenter; own with no text, or built, uses the fields", async () => {
  const m = mapOn(ON);
  const solo = m.teams.find((t) => t.name === "solo_expert")!;
  const own = (await new PresenterStore("http://rest.invalid", restFor([solo], {
    fields: { system_prompt: "You are a patient\nteacher.", system_prompt_mode: "own", stance: "ignored in own mode" },
  }).fetch).team("o", solo.id))!;
  assertEquals(castBlock(own).split("\n")[1], "HOST A is Prof Kim. You are a patient teacher.");
  const blank = (await new PresenterStore("http://rest.invalid", restFor([solo], { fields: { system_prompt: " ", system_prompt_mode: "own" } }).fetch)
    .team("o", solo.id))!;
  assertEquals(castBlock(blank), GOLDEN[`cast:${solo.name}`]);
  const built = (await new PresenterStore("http://rest.invalid", restFor([solo], { fields: { system_prompt: "not used", system_prompt_mode: "built" } }).fetch)
    .team("o", solo.id))!;
  assertEquals(castBlock(built), GOLDEN[`cast:${solo.name}`]);
});
