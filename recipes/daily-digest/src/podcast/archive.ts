/**
 * The podcast archive writer (research-workbench P7a, D6 item 5).
 *
 * WHERE: the destination is the configuration store's `podcast.archive_destination` setting, read
 * on EVERY write (never cached, never written in code, compose or .env). The workbench owns the
 * store and resolves a value to a directory (`{"mount": "podcast-archive"}` -> <mounts root>/
 * podcast-archive, the bind of the host backups folder's podcasts/ subfolder; `{"path": "/..."}` -> that directory);
 * this writer asks it (GET /workbench/contract/settings/podcast.archive_destination) and writes
 * where it says. The host folder is under ./backups/, so the weekly backup-to-nas.ps1 mirror
 * carries it to the NAS with no new mount, credential or schedule. Changing the setting redirects
 * the NEXT write; files already written stay where they are.
 *
 * WHAT: one directory per episode - the audio in its native format, `sidecar.json` (origin,
 * owner, the destination as read, the audio's format and SHA-256, ...) and any other parts the
 * caller passes (transcript, outline, sources, profile). A transcode adds a NEW file and a line
 * in the sidecar; the original audio is never opened for writing again.
 */
import { type Ffmpeg, targetOf, transcodeFile } from "./ffmpeg.ts";

export const SETTING_KEY = "podcast.archive_destination";
export const SIDECAR = "sidecar.json";
export type Origin = "render" | "on-archive";

export interface Destination {
  path: string; // the directory, as this process sees it
  value: Record<string, unknown>; // the stored setting value
  version: number;
  via: string;
}

export type DestinationFn = () => Promise<Destination>;

/** The destination from the workbench's configuration store, read fresh on every call. */
export function storeDestination(o: { workbenchUrl: string; key: string; fetchFn?: typeof fetch }): DestinationFn {
  const url = `${o.workbenchUrl.replace(/\/+$/, "")}/workbench/contract/settings/${SETTING_KEY}`;
  return async () => {
    const res = await (o.fetchFn ?? fetch)(url, { headers: { "X-Brain-Key": o.key }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`the configuration store answered ${res.status} for ${SETTING_KEY}`);
    const s = await res.json() as { value: Record<string, unknown>; version: number; resolved: { path: string | null; via: string } };
    if (!s.resolved?.path) throw new Error(`${SETTING_KEY} does not resolve to a directory (${s.resolved?.via})`);
    return { path: s.resolved.path, value: s.value, version: s.version, via: s.resolved.via };
  };
}

export interface ArchivePart {
  name: string; // a file name inside the episode directory
  data: Uint8Array | string;
}

export interface Sidecar {
  schema: "podcast-archive-sidecar/1";
  origin: Origin;
  episode_id: string;
  title: string;
  created_at: string;
  archived_at: string;
  owner_sub: string;
  requester_sub: string | null;
  shared: boolean;
  destination: { setting: string; value: Record<string, unknown>; version: number; via: string; path: string };
  audio: { file: string; format: string; bytes: number; sha256: string; seconds: number | null } | null;
  parts: string[];
  transcodes: { source_format: string; target_format: string; file: string; bytes: number; sha256: string; at: string }[];
  meta: Record<string, unknown>;
}

export async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(b));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function safeName(n: string, what: string): string {
  if (!SAFE.test(n) || n === "." || n === "..") throw new Error(`unsafe ${what} "${n}"`);
  return n;
}

async function writeAtomic(path: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  if (typeof data === "string") await Deno.writeTextFile(tmp, data);
  else await Deno.writeFile(tmp, data);
  await Deno.rename(tmp, path);
}

export interface EpisodeWrite {
  origin: Origin;
  episodeId: string; // the directory name (safe)
  title: string;
  createdAt: string;
  ownerSub: string;
  requesterSub?: string | null;
  shared?: boolean;
  audio?: { data: Uint8Array; format: string; seconds?: number | null } | null;
  parts?: ArchivePart[];
  meta?: Record<string, unknown>;
}

export class ArchiveWriter {
  constructor(readonly destination: DestinationFn) {}

  /** Write one episode under the destination the store names NOW. Refuses to overwrite one. */
  async write(e: EpisodeWrite): Promise<{ dir: string; sidecar: Sidecar }> {
    const dest = await this.destination();
    const group = e.origin === "on-archive" ? "on-archive" : "renders";
    const dir = `${dest.path.replace(/\/+$/, "")}/${group}/${safeName(e.episodeId, "episode id")}`;
    try {
      await Deno.lstat(`${dir}/${SIDECAR}`);
      throw new Error(`${dir} is already archived: an archive entry is never overwritten`);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    await Deno.mkdir(dir, { recursive: true });
    let audio: Sidecar["audio"] = null;
    if (e.audio) {
      const file = `audio.${targetOf(e.audio.format).ext}`;
      await writeAtomic(`${dir}/${file}`, e.audio.data);
      audio = { file, format: e.audio.format, bytes: e.audio.data.length, sha256: await sha256Hex(e.audio.data), seconds: e.audio.seconds ?? null };
    }
    const parts: string[] = [];
    for (const p of e.parts ?? []) {
      const n = safeName(p.name, "part name");
      if (n === SIDECAR || (audio && n === audio.file)) throw new Error(`part name ${n} is reserved`);
      await writeAtomic(`${dir}/${n}`, p.data);
      parts.push(n);
    }
    const sidecar: Sidecar = {
      schema: "podcast-archive-sidecar/1",
      origin: e.origin,
      episode_id: e.episodeId,
      title: e.title,
      created_at: e.createdAt,
      archived_at: new Date().toISOString(),
      owner_sub: e.ownerSub,
      requester_sub: e.requesterSub ?? null,
      shared: e.shared ?? false,
      destination: { setting: SETTING_KEY, value: dest.value, version: dest.version, via: dest.via, path: dest.path },
      audio,
      parts,
      transcodes: [],
      meta: e.meta ?? {},
    };
    await writeAtomic(`${dir}/${SIDECAR}`, JSON.stringify(sidecar, null, 2) + "\n");
    return { dir, sidecar };
  }
}

export async function readSidecar(dir: string): Promise<Sidecar> {
  return JSON.parse(await Deno.readTextFile(`${dir}/${SIDECAR}`)) as Sidecar;
}

/**
 * Transcode an archived episode to a menu format: a NEW file beside the original, recorded in
 * the sidecar (source and target format). The original is never written; its SHA-256 is checked
 * before and after.
 */
export async function transcodeArchived(ff: Ffmpeg, dir: string, target: string): Promise<{ file: string; sidecar: Sidecar }> {
  const t = targetOf(target);
  const sc = await readSidecar(dir);
  if (!sc.audio) throw new Error(`${dir} has no audio to transcode`);
  const src = `${dir}/${sc.audio.file}`;
  const before = await sha256Hex(await Deno.readFile(src));
  if (before !== sc.audio.sha256) throw new Error(`${src} does not match its sidecar's SHA-256: refusing to transcode`);
  const file = `audio.from-${sc.audio.format}.${t.ext}`;
  await transcodeFile(ff, src, `${dir}/${file}`, target);
  const after = await sha256Hex(await Deno.readFile(src));
  if (after !== before) throw new Error(`the original ${src} changed during a transcode`);
  const out = await Deno.readFile(`${dir}/${file}`);
  sc.transcodes.push({ source_format: sc.audio.format, target_format: target, file, bytes: out.length, sha256: await sha256Hex(out), at: new Date().toISOString() });
  await writeAtomic(`${dir}/${SIDECAR}`, JSON.stringify(sc, null, 2) + "\n");
  return { file, sidecar: sc };
}
