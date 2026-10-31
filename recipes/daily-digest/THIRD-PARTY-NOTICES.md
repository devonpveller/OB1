# Third-party notices - the daily podcast (openbrain-podcast) and its speech backend

The notices file of the podcast chain (research-workbench P7a, D9 rule 5). `src/podcast/notices_test.ts`
checks it at every image build (`Dockerfile`, stage `test`): the ffmpeg row must carry the version of
the binary in the image, its build must not be configured `--enable-nonfree`, and the Kokoro-FastAPI
rows and the source offer below must be present.

Policy (D9): permissive code only in product processes; copyleft programs only as SEPARATE, UNMODIFIED
processes or services, listed here with versions; model weights follow the same rule. Each licence below
was read from the pinned version's own metadata on 2026-10-30 (the image's package database, the
package's METADATA / dist-info, the model card).

## Programs run as separate, unmodified processes or services (never linked or imported)

| Name | Version | Licence | How it is used | Source |
|---|---|---|---|---|
| ffmpeg (Alpine package `ffmpeg`, with `ffmpeg-libav*`) | 8.1.3-r0 | GPL-2.0-or-later AND LGPL-2.1-or-later (Alpine's declaration); this build is configured `--enable-gpl --enable-version3` (so GPL-3.0-or-later as built), no `--enable-nonfree` | spawned by `src/podcast/ffmpeg.ts` (`Deno.Command`) to encode an episode and to transcode an archived one; installed in the openbrain-podcast image by `apk add ffmpeg=8.1.3-r0` | https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz ; Alpine aports `community/ffmpeg` at v3.24 |
| lame-libs (ffmpeg's MP3 encoder library, `libmp3lame`) | 3.100-r5 | LGPL-2.0-or-later | loaded by the ffmpeg process only | https://lame.sourceforge.io ; Alpine aports `main/lame` |
| opus (ffmpeg's Opus encoder library) | 1.6.1-r0 | BSD-3-Clause | loaded by the ffmpeg process only | https://opus-codec.org |
| Kokoro-FastAPI (image `ghcr.io/remsky/kokoro-fastapi-cpu:v0.2.4@sha256:c8812546d358cbfd6a5c4087a28795b2b001d8e32d7a322eedd246e6bc13cb55`; its package metadata reads `kokoro_fastapi` 0.3.0) | v0.2.4 | Apache-2.0 | its own container `kokoro-tts-upstream` (inference plane), reached only over HTTP through LiteLLM (`/v1/audio/speech`, route `local-tts`) | https://github.com/remsky/Kokoro-FastAPI/tree/v0.2.4 |
| kokoro (inside that image) | 0.9.2 | Apache-2.0 | inside the Kokoro container only | https://github.com/hexgrad/kokoro |
| misaki (inside that image) | 0.9.3 | Apache-2.0 | inside the Kokoro container only | https://github.com/hexgrad/misaki |
| phonemizer-fork (inside that image) | 3.3.2 | GPL-3.0 | inside the Kokoro container only (misaki's English fallback phonemizer) | https://pypi.org/project/phonemizer-fork/3.3.2/ |
| espeakng-loader (inside that image) | 0.2.4 | GPL-3.0 (bundles espeak-ng) | inside the Kokoro container only | https://pypi.org/project/espeakng-loader/0.2.4/ |
| espeak-ng (Debian package, inside that image) | 1.51+dfsg-10+deb12u2 | GPL-3.0-or-later | inside the Kokoro container only | Debian bookworm source package `espeak-ng` 1.51+dfsg-10+deb12u2 |
| ffmpeg (Debian package, inside that image) | 7:5.1.6-0+deb12u1 | GPL-2.0-or-later / LGPL-2.1-or-later | inside the Kokoro container only | Debian bookworm source package `ffmpeg` 7:5.1.6-0+deb12u1 |
| Deno (image `denoland/deno:alpine-2.9.5`) | 2.9.5 | MIT | the runtime of openbrain-podcast | https://github.com/denoland/deno/tree/v2.9.5 |

## Model weights

| Name | Version | Licence | Where |
|---|---|---|---|
| Kokoro-82M (`kokoro-v1_0.pth` and the voice packs, baked into the Kokoro-FastAPI image) | v1.0 | Apache-2.0 (model card, hexgrad/Kokoro-82M) | inside the Kokoro container only |

## Source offer (GPL components in images this stack ships)

Two images carry GPL programs: openbrain-podcast (ffmpeg 8.1.3-r0, from Alpine) and kokoro-fastapi-cpu
v0.2.4 (espeak-ng, phonemizer-fork, espeakng-loader and Debian's ffmpeg, from its upstream). Both are run
UNMODIFIED. For three years from the date you received either image, the operator of this stack will
provide, on written request, the complete corresponding source code for every GPL component listed
above at the version listed, for no more than the cost of physically performing the distribution. The
same source is published at the locations in the "Source" column: the Alpine and Debian source packages
for the distribution builds, the upstream release archives, and the Kokoro-FastAPI repository at tag
v0.2.4 (its Dockerfile builds the image from those packages).

## What no product process does

No product code imports or links `kokoro`, `misaki`, `phonemizer` or `espeakng-loader` (checked by
`src/podcast/podcast-audio.test.ts`, "C7"), and no product code links an ffmpeg library: the binary is
spawned.
