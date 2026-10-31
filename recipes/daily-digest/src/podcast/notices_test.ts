// deno test src/podcast/notices_test.ts - D9 rule 5 for the podcast chain (rw-p7a-tts): the notices file
// lists ffmpeg at the version of the binary in this image (and that build is not nonfree), the
// Kokoro-FastAPI image and its GPL chain with versions, and the source offer. Runs in the image's build
// gate (PODCAST_REQUIRE_FFMPEG=1 there: the binary must exist); in the repo the ffmpeg-version case is
// skipped when there is no ffmpeg.
import { assert } from "jsr:@std/assert@1";

const notices = await Deno.readTextFile(new URL("../../THIRD-PARTY-NOTICES.md", import.meta.url));
const rows = notices.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("|---"));
const row = (name: string) => rows.find((r) => r.split("|")[1]?.includes(name));

Deno.test("the Kokoro-FastAPI image, its GPL chain and the model are listed with versions", () => {
  // the compose file is in the parent repo (ai-stack inference/compose/tts.yml): checked when present
  let compose = "";
  try {
    compose = Deno.readTextFileSync(new URL("../../../../../inference/compose/tts.yml", import.meta.url)).match(/^\s+image:\s*(\S+)/m)?.[1] ?? "";
  } catch { /* not in the image's build context */ }
  for (const [name, version] of [["Kokoro-FastAPI", "v0.2.4"], ["kokoro (inside", "0.9.2"], ["misaki", "0.9.3"], ["phonemizer-fork", "3.3.2"],
    ["espeakng-loader", "0.2.4"], ["espeak-ng", "1.51+dfsg-10+deb12u2"], ["Kokoro-82M", "v1.0"]]) {
    const r = row(name);
    assert(r && r.split("|")[2].includes(version), `no notices row for ${name} ${version}`);
  }
  if (compose) assert(compose.includes("@sha256:") && row("Kokoro-FastAPI")!.includes(compose.split("@")[1]), `the compose image ${compose} is not the noticed digest`);
});

Deno.test("a source offer covers every shipped GPL image", () => {
  assert(/## Source offer/.test(notices) && /complete corresponding source code/.test(notices));
  for (const gpl of ["ffmpeg 8.1.3-r0", "espeak-ng", "phonemizer-fork", "espeakng-loader"]) assert(notices.includes(gpl), gpl);
});

async function ffmpegVersion(): Promise<string | null> {
  try {
    const o = await new Deno.Command(Deno.env.get("FFMPEG_BIN") ?? "ffmpeg", { args: ["-hide_banner", "-version"], stdout: "piped" }).output();
    return o.success ? new TextDecoder().decode(o.stdout).split("\n")[0] : null;
  } catch {
    return null;
  }
}
const ver = await ffmpegVersion();

Deno.test({
  name: "the ffmpeg row carries the image binary's version, and the build is not nonfree",
  ignore: ver === null && Deno.env.get("PODCAST_REQUIRE_FFMPEG") !== "1",
  fn: async () => {
    assert(ver, "no ffmpeg binary in this image");
    const v = /^ffmpeg version (\S+)/.exec(ver)![1];
    const r = row("ffmpeg (Alpine");
    assert(r && r.split("|")[2].trim().startsWith(v), `ffmpeg ${v} is not the noticed version (${r?.split("|")[2]})`);
    const conf = new TextDecoder().decode((await new Deno.Command("ffmpeg", { args: ["-hide_banner", "-buildconf"], stdout: "piped" }).output()).stdout);
    assert(!conf.includes("--enable-nonfree"), "a nonfree ffmpeg build");
  },
});
