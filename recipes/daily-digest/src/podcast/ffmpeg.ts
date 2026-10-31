/**
 * ffmpeg as a SEPARATE, UNMODIFIED PROCESS (research-workbench P7a, D9). Nothing here links a
 * codec: the episode is encoded, and an archived file transcoded, by spawning the `ffmpeg` binary
 * of the image (Alpine's package; its build configuration is recorded in THIRD-PARTY-NOTICES.md
 * and checked by ffmpeg_test.ts to carry no --enable-nonfree).
 *
 * The transcode TARGET MENU is fixed: a request for any other format is refused before ffmpeg
 * runs. A transcode always writes a NEW file beside the source; the source is opened read-only and
 * never replaced.
 */
import { PCM } from "./tts-client.ts";

export interface TargetFormat {
  ext: string;
  mime: string;
  args: string[]; // the codec arguments, after the input
}

/** The fixed transcode target menu. */
export const TARGET_MENU: Readonly<Record<string, TargetFormat>> = Object.freeze({
  mp3: { ext: "mp3", mime: "audio/mpeg", args: ["-c:a", "libmp3lame", "-b:a", "128k"] },
  opus: { ext: "opus", mime: "audio/ogg", args: ["-c:a", "libopus", "-b:a", "64k"] },
  m4a: { ext: "m4a", mime: "audio/mp4", args: ["-c:a", "aac", "-b:a", "128k"] },
  flac: { ext: "flac", mime: "audio/flac", args: ["-c:a", "flac"] },
  wav: { ext: "wav", mime: "audio/wav", args: ["-c:a", "pcm_s16le"] },
});

/** The renderer's native archive format. */
export const NATIVE_FORMAT = "mp3";

export function targetOf(name: string): TargetFormat {
  const t = Object.hasOwn(TARGET_MENU, name) ? TARGET_MENU[name] : undefined;
  if (!t) throw new RangeError(`"${name}" is not on the transcode menu (${Object.keys(TARGET_MENU).join(", ")})`);
  return t;
}

export interface Ffmpeg {
  bin: string;
}

async function run(ff: Ffmpeg, args: string[], stdin?: Uint8Array): Promise<void> {
  const child = new Deno.Command(ff.bin, {
    // -nostdin only when nothing is piped in (the PCM encode reads its input from stdin)
    args: ["-hide_banner", "-loglevel", "error", ...(stdin ? [] : ["-nostdin"]), ...args],
    stdin: stdin ? "piped" : "null", stdout: "null", stderr: "piped",
  }).spawn();
  if (stdin) {
    const w = child.stdin.getWriter();
    await w.write(stdin);
    await w.close();
  }
  const out = await child.output();
  if (!out.success) throw new Error(`ffmpeg exited ${out.code}: ${new TextDecoder().decode(out.stderr).slice(-400)}`);
}

/** Encode the renderer's PCM into `outPath` in `format` (a menu entry). */
export async function encodePcm(ff: Ffmpeg, pcm: Uint8Array, outPath: string, format = NATIVE_FORMAT): Promise<void> {
  const t = targetOf(format);
  await run(ff, ["-f", "s16le", "-ar", String(PCM.sampleRate), "-ac", String(PCM.channels), "-i", "pipe:0", ...t.args, "-y", outPath], pcm);
}

/** Transcode `src` to a NEW file `dst` in `format`. Refuses to write over the source. */
export async function transcodeFile(ff: Ffmpeg, src: string, dst: string, format: string): Promise<void> {
  const t = targetOf(format);
  if ((await Deno.realPath(src)) === dst || src === dst) throw new Error("a transcode never writes over its source");
  try {
    await Deno.lstat(dst);
    throw new Error(`${dst} exists: a transcode never replaces a file`);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  await run(ff, ["-i", src, "-vn", ...t.args, "-n", dst]);
}

/** The binary's version line and configuration (for the notices check). */
export async function ffmpegBuild(ff: Ffmpeg): Promise<{ version: string; configuration: string }> {
  const out = await new Deno.Command(ff.bin, { args: ["-hide_banner", "-buildconf"], stdout: "piped", stderr: "piped" }).output();
  const v = await new Deno.Command(ff.bin, { args: ["-version"], stdout: "piped", stderr: "piped" }).output();
  return {
    version: new TextDecoder().decode(v.stdout).split("\n")[0] ?? "",
    configuration: new TextDecoder().decode(out.stdout),
  };
}
