// research-workbench P7a (rw-p7a-tts): the Open Notebook capture's pure parts - the profile mapping
// with its field ledger, the read-only SurrealDB client, the migration classifier. The fixture is the
// SHAPE of ON's live records (three speaker profiles, three episode profiles, no podcast_config, the
// model table's Piper voices), read 2026-10-30; the integration over a copy of the real datastore is
// the lab run (lab/run-podcast-lab.ps1).
//
// Run: deno test --allow-read --allow-env src/on-capture/on-capture.test.ts
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { mapOn, type OnInput, PIPER_TO_KOKORO, profileCounts } from "./on-mapping.ts";
import { assertReadOnly } from "./surreal-read.ts";
import { byClass, classify } from "./migration.ts";

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
function fixture(): OnInput {
  return {
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
}

Deno.test("C8: every ON profile maps; the presenter-model count equals the ON profile count", () => {
  const on = fixture();
  const m = mapOn(on);
  const c = profileCounts(on, m);
  assert(c.equal);
  assertEquals(c.on, { speaker_profile: 3, episode_profile: 3, podcast_config: 0 });
  assertEquals([c.model.teams, c.model.formats, c.model.presenters, c.model.voice_links], [3, 3, 6, 6]);
  const tech = m.teams.find((t) => t.name === "tech_experts")!;
  assertEquals(tech.presenters.map((p) => [p.name, p.voice.voice, p.voice.route]), [["Dr. Alex Chen", "bm_george", "local-tts"], ["Jamie Rodriguez", "bf_emma", "local-tts"]]);
  assertEquals(tech.presenters[0].personality, "Dr. Alex Chen personality");
  const f = m.formats.find((x) => x.name === "tech_discussion")!;
  assertEquals([f.teamId, f.briefing, f.segments, f.language, f.scriptRoute], [tech.id, "tech_discussion briefing", 5, "en-US", "local-large:nothink"]);
  assert(m.voices.every((v) => v.origin === "on-capture" && v.originRef?.includes("piper")));
});

Deno.test("C8: the ledger lists every ON field seen - mapped or unmapped with the reason - and an unknown field refuses", () => {
  const m = mapOn(fixture());
  const fields = (t: string) => m.ledger.filter((l) => l.table === t).map((l) => l.field).sort();
  assertEquals(fields("speaker_profile"), ["created", "description", "id", "name", "speakers", "speakers[*].backstory", "speakers[*].name",
    "speakers[*].personality", "speakers[*].voice_id", "speakers[*].voice_model", "tts_model", "tts_provider", "updated", "voice_model"]);
  assertEquals(fields("episode_profile").length, 15);
  assert(m.ledger.every((l) => l.to.length > 10), "every row says where or why");
  assert(m.ledger.some((l) => l.status === "unmapped" && l.field === "outline_llm"));
  const on = fixture();
  (on.speakerProfiles[0] as Record<string, unknown>).surprise = 1;
  assertThrows(() => mapOn(on), Error, "no mapping rule");
});

Deno.test("C8: a podcast_config row, an unknown Piper voice or an unmapped transcript model refuses (no silent loss)", () => {
  const a = fixture();
  a.podcastConfigs = [{ id: "podcast_config:x" }];
  assertThrows(() => mapOn(a), Error, "podcast_config");
  const b = fixture();
  b.models.push({ id: "model:new", name: "en_US-new-voice" });
  ((b.speakerProfiles[1] as Record<string, unknown>).speakers as Record<string, unknown>[])[0].voice_model = "model:new";
  assertThrows(() => mapOn(b), Error, "no Kokoro mapping");
  const c = fixture();
  c.models.find((x) => x.id === "model:nothink")!.name = "gpt-9";
  assertThrows(() => mapOn(c), Error, "LiteLLM route");
  assert(Object.values(PIPER_TO_KOKORO).every((v) => /^[ab][fm]_[a-z]+$/.test(v)));
});

Deno.test("the SurrealDB client is read-only: only one SELECT / INFO FOR DB, no write keyword", () => {
  for (const ok of ["SELECT * FROM episode", "SELECT id, name FROM command WHERE name = 'generate_podcast'", "INFO FOR DB", "SELECT * OMIT embedding FROM source_embedding;",
    "SELECT * FROM note WHERE content = 'please DELETE this'"]) assertReadOnly(ok);
  for (const bad of ["DELETE episode", "SELECT * FROM a; DELETE b", "UPDATE episode SET x = 1", "CREATE x", "SELECT * FROM (DELETE x)", "LET $a = 1",
    "SELECT * FROM a WHERE x = (INSERT INTO b {})", "RELATE a->b->c", "DEFINE TABLE x", "REMOVE TABLE x", "BEGIN", "select * from a;delete b"]) {
    assertThrows(() => assertReadOnly(bad), Error, "read-only client", bad);
  }
});

Deno.test("C10: migration - one outcome per episode class with a reason; a migrated transcript is a RoomTranscript of the team", () => {
  const m = mapOn(fixture());
  const sp = { id: "speaker_profile:tech", name: "tech_experts" };
  const ok = classify({ id: "episode:1", name: "001-daily", job_status: "completed", audio_file: "/app/data/x.mp3", speaker_profile: sp,
    transcript: { transcript: [{ speaker: "Dr. Alex Chen", dialogue: "Hello." }, { speaker: "Jamie Rodriguez", dialogue: "Hi." }] } }, m.teams, m.ids);
  assertEquals(ok.outcome, "migrates");
  const tech = m.teams.find((t) => t.name === "tech_experts")!;
  assertEquals(ok.transcript, { title: "001-daily", turns: [{ presenterId: tech.presenters[0].id, text: "Hello." }, { presenterId: tech.presenters[1].id, text: "Hi." }] });
  const failed = classify({ id: "episode:2", name: "002", job_status: "failed", audio_file: null, error_message: "Error code: 502", speaker_profile: sp, transcript: null }, m.teams, m.ids);
  assertEquals(failed.outcome, "archived");
  assert(failed.reason.includes("no transcript") && failed.reason.includes("502"));
  const stranger = classify({ id: "episode:3", name: "003", job_status: "completed", audio_file: "/a.mp3", speaker_profile: sp,
    transcript: { transcript: [{ speaker: "Someone Else", dialogue: "?" }] } }, m.teams, m.ids);
  assertEquals(stranger.outcome, "archived");
  const classes = byClass([ok, failed, stranger]);
  assertEquals(classes.length, 3);
  assert(classes.every((c) => c.reason.length > 20));
});
