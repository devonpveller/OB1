/**
 * on-capture.ts - capture Open Notebook's podcasts before its removal (research-workbench P7a, D6).
 *
 * READ-ONLY against ON: SurrealDB is read through a client that sends single SELECT statements
 * only (src/on-capture/surreal-read.ts), and the episode audio is read from ON's data directory
 * (mounted read-only). Writes go only to the presenter model (openbrain-db, via PostgREST) and the
 * podcast archive (wherever the configuration store's podcast.archive_destination points NOW).
 *
 *   deno run -A on-capture.ts capture   [--no-db] [--link-reports=<dir>]
 *   deno run -A on-capture.ts verify-quiesced --manifest=<path>
 *   deno run -A on-capture.ts rerender --manifest=<path> --episode=<ON episode id>   (needs TTS)
 *
 * capture: (1) every speaker_profile / episode_profile / podcast_config -> the presenter model
 * (src/on-capture/on-mapping.ts; owner WORKSPACE_DEFAULT_SUB) with the field ledger; (2) every ON
 * episode -> the archive (origin on-archive): the audio file as ON stored it (its native format),
 * row.json (the row, `content` included), outline.json, transcript.json, sources.json, profile.json
 * (the episode's own profile snapshots) and the sidecar; (3) the migration investigation (one
 * outcome per episode class, src/on-capture/migration.ts); (4) the capture manifest: counts, the
 * archived directories and a per-table fingerprint of ON's datastore, which verify-quiesced
 * recomputes - any change after the capture is a write that reached ON.
 *
 * Env: SURREAL_URL (http://surrealdb:8000), SURREAL_USER, SURREAL_PASSWORD, SURREAL_NS / SURREAL_DB
 * (open_notebook), ON_DATA_DIR (where ON's /app/data is mounted, e.g. /on-data), ON_DATA_PREFIX
 * (/app/data), WORKSPACE_DEFAULT_SUB (the owner), BRAIN_REST_URL, WORKBENCH_URL, MCP_ACCESS_KEY,
 * and for rerender the P7a audio env (CHAT_API_BASE, PODCAST_TTS_KEY, PODCAST_SEGMENT_CACHE_DIR, FFMPEG_BIN).
 */
import { ArchiveWriter, sha256Hex, storeDestination } from "./src/podcast/archive.ts";
import { voiceAndArchive } from "./src/podcast/episode-audio.ts";
import { PresenterStore } from "./src/podcast/presenter-store.ts";
import { SegmentCache } from "./src/podcast/segment-cache.ts";
import { gatewaySpeech } from "./src/podcast/tts-client.ts";
import { mapOn, type OnRecord, profileCounts } from "./src/on-capture/on-mapping.ts";
import { byClass, classify, CLEAN_MIGRATION_TEST } from "./src/on-capture/migration.ts";
import { SurrealReader } from "./src/on-capture/surreal-read.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const arg = (n: string) => Deno.args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const flag = (n: string) => Deno.args.includes(`--${n}`);
const verb = Deno.args[0] ?? "";

const surreal = new SurrealReader({
  url: env("SURREAL_URL", "http://surrealdb:8000"), ns: env("SURREAL_NS", "open_notebook"), db: env("SURREAL_DB", "open_notebook"),
  user: env("SURREAL_USER"), pass: env("SURREAL_PASSWORD"),
});
const OWNER = env("WORKSPACE_DEFAULT_SUB").trim() || "operator";
const destination = storeDestination({ workbenchUrl: env("WORKBENCH_URL", "http://openbrain-workbench:8000"), key: env("MCP_ACCESS_KEY") });
const archive = new ArchiveWriter(destination);
const store = new PresenterStore(env("BRAIN_REST_URL", "http://openbrain-rest"));

// ── ON's datastore fingerprint (what verify-quiesced compares) ─────────────────────────────────
async function tables(): Promise<string[]> {
  const info = await surreal.query<unknown>("INFO FOR DB") as unknown as { tables?: Record<string, string> };
  return Object.keys(info.tables ?? {}).sort();
}

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

async function fingerprint(): Promise<Record<string, { rows: number; sha256: string }>> {
  const out: Record<string, { rows: number; sha256: string }> = {};
  for (const t of await tables()) {
    if (!/^[a-z_][a-z0-9_]*$/.test(t)) throw new Error(`unexpected table name ${t}`);
    // the embedding vectors are omitted (size); their rows, ids and every other field are hashed
    const rows = await surreal.query<OnRecord>(t === "source_embedding" ? `SELECT * OMIT embedding FROM ${t}` : `SELECT * FROM ${t}`);
    rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    out[t] = { rows: rows.length, sha256: await sha256Hex(new TextEncoder().encode(canon(rows))) };
  }
  return out;
}

// ── capture ────────────────────────────────────────────────────────────────────────────────────
async function readOn() {
  const [speakerProfiles, episodeProfiles, podcastConfigs, models, episodes] = await Promise.all([
    surreal.query<OnRecord>("SELECT * FROM speaker_profile"),
    surreal.query<OnRecord>("SELECT * FROM episode_profile"),
    surreal.query<OnRecord>("SELECT * FROM podcast_config"),
    surreal.query<OnRecord>("SELECT id, name, type, provider, credential FROM model"),
    surreal.query<OnRecord>("SELECT * FROM episode"),
  ]);
  const commands = await surreal.query<OnRecord>("SELECT id, name, status, args, error_message FROM command WHERE name = 'generate_podcast'");
  return { speakerProfiles, episodeProfiles, podcastConfigs, models, episodes, commands };
}

const safe = (onId: string) => onId.replace(/^episode:/, "on-episode-").replace(/[^A-Za-z0-9._-]/g, "");

async function linkReport(dir: string | undefined, created: string): Promise<unknown> {
  if (!dir) return null;
  const day = created.slice(0, 10);
  try {
    const r = JSON.parse(await Deno.readTextFile(`${dir}/podcast-link-report-${day}.json`));
    return { file: `podcast-link-report-${day}.json`, entries: (r.entries ?? []).map((e: Record<string, unknown>) => ({ label: e.label, url: e.url, status: e.status, note: e.note ?? null })) };
  } catch {
    return null;
  }
}

async function capture() {
  const t0 = new Date().toISOString();
  const before = await fingerprint();
  const on = await readOn();
  const mapped = mapOn(on);
  const counts = profileCounts(on, mapped);
  if (!counts.equal) throw new Error(`profile counts differ: ${JSON.stringify(counts)}`);
  if (!flag("no-db")) await store.insertModel(OWNER, mapped);
  const dataDir = env("ON_DATA_DIR", "/on-data").replace(/\/+$/, "");
  const prefix = env("ON_DATA_PREFIX", "/app/data").replace(/\/+$/, "");
  const cmdById = new Map(on.commands.map((c) => [String(c.id), c]));
  const archived: { on_id: string; dir: string; audio: string | null; audio_sha256: string | null }[] = [];
  const classified = [];
  for (const ep of on.episodes) {
    const onId = String(ep.id);
    let audio: { data: Uint8Array; format: string } | null = null;
    const absent: string[] = [];
    const af = ep.audio_file ? String(ep.audio_file) : "";
    if (af) {
      if (!af.startsWith(`${prefix}/`)) throw new Error(`${onId}: audio_file ${af} is outside ${prefix}`);
      const data = await Deno.readFile(`${dataDir}${af.slice(prefix.length)}`); // a missing file fails the capture
      audio = { data, format: af.slice(af.lastIndexOf(".") + 1).toLowerCase() };
    } else {
      absent.push(`audio: ON has no audio for this episode (status ${ep.job_status ?? cmdById.get(String(ep.command))?.status ?? "?"})`);
    }
    if (!ep.outline) absent.push("outline: ON stored none");
    if (!ep.transcript) absent.push("transcript: ON stored none");
    const cmd = cmdById.get(String(ep.command));
    const args = (cmd?.args ?? {}) as OnRecord;
    const sources = {
      note: "ON generated every daily episode from `content` (the grounded script handed over by the daily chain), never from a notebook: ON holds no source records for them.",
      on_sources: { notebook_id: args.notebook_id ?? null, source_ids: args.source_ids ?? [] },
      content_chars: String(ep.content ?? "").length,
      daily_chain_link_report: await linkReport(arg("link-reports"), String(ep.created ?? "")),
    };
    const status = String(cmd?.status ?? (af ? "completed" : "unknown"));
    const { dir, sidecar } = await archive.write({
      origin: "on-archive", episodeId: safe(onId), title: String(ep.name ?? onId), createdAt: String(ep.created ?? ""),
      ownerSub: OWNER, requesterSub: OWNER, shared: false, audio,
      parts: [
        { name: "row.json", data: JSON.stringify(ep, null, 2) + "\n" },
        { name: "outline.json", data: JSON.stringify(ep.outline ?? null, null, 2) + "\n" },
        { name: "transcript.json", data: JSON.stringify(ep.transcript ?? null, null, 2) + "\n" },
        { name: "sources.json", data: JSON.stringify(sources, null, 2) + "\n" },
        { name: "profile.json", data: JSON.stringify({ episode_profile: ep.episode_profile ?? null, speaker_profile: ep.speaker_profile ?? null, command: cmd ? { id: cmd.id, status: cmd.status, error_message: cmd.error_message ?? null } : null }, null, 2) + "\n" },
      ],
      meta: { on_id: onId, on_status: status, absent, mapped_team: mapped.ids[String((ep.speaker_profile as OnRecord)?.id ?? "")] ?? null, mapped_format: mapped.ids[String((ep.episode_profile as OnRecord)?.id ?? "")] ?? null },
    });
    archived.push({ on_id: onId, dir, audio: sidecar.audio?.file ?? null, audio_sha256: sidecar.audio?.sha256 ?? null });
    classified.push(classify({ ...ep, job_status: status }, mapped.teams, mapped.ids));
  }
  const after = await fingerprint();
  const dest = await destination();
  const manifest = {
    schema: "on-capture-manifest/1", started_at: t0, finished_at: new Date().toISOString(), owner_sub: OWNER,
    destination: dest, counts: { ...counts, on_episodes: on.episodes.length, archived: archived.length },
    unchanged_during_capture: canon(before) === canon(after),
    fingerprint: after, ledger: mapped.ledger, ids: mapped.ids,
    migration: { test: CLEAN_MIGRATION_TEST, classes: byClass(classified), per_episode: classified.map(({ transcript: _t, ...c }) => c) },
    archived, surreal_statements: surreal.statements,
  };
  const path = `${dest.path.replace(/\/+$/, "")}/on-archive/CAPTURE-${t0.replace(/[:.]/g, "")}.json`;
  await Deno.writeTextFile(path, JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ manifest: path, counts: manifest.counts, unchanged_during_capture: manifest.unchanged_during_capture, classes: manifest.migration.classes.map((c) => ({ cls: c.cls, outcome: c.outcome, count: c.count })) }, null, 2));
  if (archived.length !== on.episodes.length) Deno.exit(1);
}

async function verifyQuiesced() {
  const m = JSON.parse(await Deno.readTextFile(arg("manifest") ?? "")) as { fingerprint: Record<string, { rows: number; sha256: string }> };
  const now = await fingerprint();
  const changed = Object.keys({ ...m.fingerprint, ...now }).filter((t) => canon(m.fingerprint[t]) !== canon(now[t]));
  console.log(JSON.stringify({ quiesced: changed.length === 0, changed_tables: changed, now }, null, 2));
  Deno.exit(changed.length ? 1 : 0);
}

async function rerender() {
  const m = JSON.parse(await Deno.readTextFile(arg("manifest") ?? "")) as { ids: Record<string, string>; archived: { on_id: string; dir: string; audio: string | null; audio_sha256: string | null }[]; owner_sub: string };
  const onId = arg("episode") ?? "";
  const entry = m.archived.find((a) => a.on_id === onId);
  if (!entry) throw new Error(`episode ${onId} is not in the capture manifest`);
  const row = JSON.parse(await Deno.readTextFile(`${entry.dir}/row.json`)) as OnRecord;
  const teamId = m.ids[String((row.speaker_profile as OnRecord).id)];
  const team = await store.team(m.owner_sub, teamId);
  if (!team) throw new Error(`team ${teamId} is not in the presenter model`);
  const c = classify({ ...row, job_status: entry.audio ? "completed" : "failed" }, [team], m.ids);
  if (c.outcome !== "migrates" || !c.transcript) throw new Error(`${onId} does not migrate: ${c.reason}`);
  const limit = Number(arg("turns") ?? "0");
  const transcript = limit > 0 ? { ...c.transcript, turns: c.transcript.turns.slice(0, limit) } : c.transcript;
  const origBefore = entry.audio ? await sha256Hex(await Deno.readFile(`${entry.dir}/${entry.audio}`)) : null;
  const cache = new SegmentCache(env("PODCAST_SEGMENT_CACHE_DIR", "/tmp/podcast-segment-cache"),
    gatewaySpeech({ apiBase: env("CHAT_API_BASE", "http://llama-cpp:8080/v1"), apiKey: env("PODCAST_TTS_KEY") }));
  const v = await voiceAndArchive(transcript, team, { ownerSub: m.owner_sub, requesterSub: m.owner_sub, shared: false, slug: `migrated-${String(row.name ?? onId)}`, meta: { migrated_from_archive: entry.dir } },
    { cache, concurrency: Number(env("PODCAST_TTS_CONCURRENCY", "2")), ffmpeg: { bin: env("FFMPEG_BIN", "ffmpeg") }, archive, store: flag("no-db") ? null : store });
  const origAfter = entry.audio ? await sha256Hex(await Deno.readFile(`${entry.dir}/${entry.audio}`)) : null;
  console.log(JSON.stringify({ on_id: onId, new_render: v.dir, turns: v.rendered.stats.turns, seconds: v.rendered.seconds, archived_audio_unchanged: origBefore === origAfter && origBefore === entry.audio_sha256, archived: entry.dir }, null, 2));
}

if (verb === "capture") await capture();
else if (verb === "verify-quiesced") await verifyQuiesced();
else if (verb === "rerender") await rerender();
else {
  console.error("usage: on-capture.ts capture [--no-db] [--link-reports=<dir>] | verify-quiesced --manifest=<p> | rerender --manifest=<p> --episode=<id> [--turns=N] [--no-db]");
  Deno.exit(2);
}
