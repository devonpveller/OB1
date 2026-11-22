// Episode audio (rwr-podcast-audio-api): which file an episode row names, and the byte range a
// request asks for. Pure apart from the file system reads in resolveEpisodeAudio, which never
// write and never follow a name the caller supplied: the caller gives an episode id, the database
// gives the row's archive_dir, and the archive's own sidecar.json (written by openbrain-podcast's
// ArchiveWriter, recipes/daily-digest/src/podcast/archive.ts) names the audio file inside it.
//
// The archive root is the contract's mounts root (CONTRACT_MOUNTS_ROOT, /mounts): every archive
// destination resolves under it (repo/system.ts validateDestination; the renderer refuses any
// other). A row whose archive_dir, or whose sidecar's file name, would leave that root - by a
// "..", an absolute name, or a symbolic link pointing outside - is refused here before a byte is
// read, and the refusal is the same "not found" a missing episode gets.

// The transcode menu's media types (recipes/daily-digest/src/podcast/ffmpeg.ts TARGET_MENU); any
// other recorded format is served as opaque bytes.
const MEDIA: Readonly<Record<string, string>> = Object.freeze({
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  wav: "audio/wav",
});

export function mediaTypeOf(format: string): string {
  return Object.hasOwn(MEDIA, format) ? MEDIA[format] : "application/octet-stream";
}

// A file name inside an episode directory: one plain segment (the writer's own rule, safeName).
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SIDECAR = "sidecar.json";
const SIDECAR_MAX = 1 << 20; // a sidecar is a few kB; a bigger one is not the writer's

export class AudioUnavailable extends Error {
  // the reason is for the log only: every caller-facing refusal is the same "no such episode"
  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface AudioFs {
  realPath(p: string): Promise<string>;
  stat(p: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }>;
  readTextFile(p: string): Promise<string>;
}

// The service runs on Linux. On a Windows host (a developer's test run only) a real path comes back
// as C:\...; it is written with forward slashes, and "C:" counts as the leading "/".
const WINDOWS = Deno.build.os === "windows";
const DRIVE = /^[A-Za-z]:(?=\/)/;

export const denoFs: AudioFs = {
  realPath: async (p) => {
    const r = await Deno.realPath(p);
    return WINDOWS ? r.replace(/\\/g, "/") : r;
  },
  stat: (p) => Deno.stat(p),
  readTextFile: (p) => Deno.readTextFile(p),
};

const trim = (p: string) => p.replace(/\/+$/, "");

// Inside root: the path is root itself or below "root/" (a sibling "root-alt" is not inside).
export function within(root: string, p: string): boolean {
  const r = trim(root);
  return r !== "" && p.startsWith(`${r}/`);
}

// An absolute POSIX path with no empty, "." or ".." segment.
function cleanAbsolute(p: string): boolean {
  const q = WINDOWS ? p.replace(DRIVE, "") : p;
  if (!q.startsWith("/") || q.includes("\0") || q.includes("\\")) return false;
  return trim(q).split("/").slice(1).every((s) => s !== "" && s !== "." && s !== "..");
}

export interface EpisodeAudio {
  path: string; // the real path of the audio file, inside the real archive root
  size: number;
}

// The audio file of an episode row: archive_dir must be a clean path under the root, the sidecar
// names the file, and the REAL path of both (symbolic links resolved) must stay under the REAL root.
export async function resolveEpisodeAudio(archiveDir: string, root: string, fs: AudioFs = denoFs): Promise<EpisodeAudio> {
  if (!cleanAbsolute(root)) throw new AudioUnavailable(`the archive root ${root} is not a clean absolute path`);
  if (!cleanAbsolute(archiveDir) || !within(root, archiveDir)) {
    throw new AudioUnavailable(`archive_dir ${JSON.stringify(archiveDir)} is not a clean path under ${root}`);
  }
  let realRoot: string, realDir: string;
  try {
    realRoot = await fs.realPath(root);
    realDir = await fs.realPath(archiveDir);
  } catch (e) {
    throw new AudioUnavailable(`the archive directory cannot be read: ${(e as Error)?.name ?? e}`);
  }
  if (!within(realRoot, realDir)) throw new AudioUnavailable(`archive_dir resolves to ${realDir}, outside ${realRoot}`);
  let file: unknown;
  try {
    const sc = `${realDir}/${SIDECAR}`;
    const st = await fs.stat(sc);
    if (!st.isFile || st.size > SIDECAR_MAX) throw new Error("not a sidecar file");
    const realSc = await fs.realPath(sc);
    if (!within(realDir, realSc)) throw new Error("the sidecar leaves the episode directory");
    file = (JSON.parse(await fs.readTextFile(realSc)) as { audio?: { file?: unknown } })?.audio?.file;
  } catch (e) {
    throw new AudioUnavailable(`the episode's sidecar cannot be read: ${(e as Error)?.message ?? e}`);
  }
  if (typeof file !== "string" || !FILE_NAME.test(file) || file === SIDECAR) {
    throw new AudioUnavailable(`the sidecar names no plain audio file (${JSON.stringify(file)})`);
  }
  let real: string, size: number;
  try {
    real = await fs.realPath(`${realDir}/${file}`);
    const st = await fs.stat(real);
    if (!st.isFile) throw new Error("not a file");
    size = st.size;
  } catch (e) {
    throw new AudioUnavailable(`the audio file cannot be read: ${(e as Error)?.message ?? e}`);
  }
  if (!within(realDir, real) || !within(realRoot, real)) throw new AudioUnavailable(`the audio file resolves to ${real}, outside ${realDir}`);
  return { path: real, size };
}

export type ByteRange =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number } // inclusive, as Content-Range writes it
  | { kind: "unsatisfiable" };

// RFC 9110 §14: one range of `bytes` is honoured; a header this does not understand (another unit,
// several ranges, a malformed spec) is ignored and the whole file is sent, which the RFC allows. A
// well-formed range that selects nothing is 416.
export function parseRange(header: string | undefined | null, size: number): ByteRange {
  if (!header) return { kind: "full" };
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m || (m[1] === "" && m[2] === "")) return { kind: "full" };
  if (m[1] === "") {
    // a suffix: the last N bytes
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n)) return { kind: "full" };
    if (n === 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { kind: "full" };
  if (m[2] !== "" && end < start) return { kind: "full" }; // invalid spec: ignored
  if (start >= size) return { kind: "unsatisfiable" };
  return { kind: "partial", start, end: Math.min(end, size - 1) };
}

// Who may hear an episode: its owner; a shared one, any signed-in user (never a service key, never
// the anonymous identity). The row's visibility to the caller is decided in SQL (repo/podcasts.ts
// episodeAudio); this is the identity-kind half of the same rule.
export function mayHearShared(kind: string | undefined): boolean {
  return kind !== "service" && kind !== "anonymous";
}

// Never a public or shared cache (anchor line 6). The bytes are behind a sign-in either way, so a
// shared episode is no different: private, and not stored by anything between.
export const AUDIO_CACHE_CONTROL = "private, no-store";
