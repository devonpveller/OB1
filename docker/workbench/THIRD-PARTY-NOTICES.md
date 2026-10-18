# Third-party notices - Open Brain research workbench

The one third-party notices file of the research workbench (D9 rule 5). It ships in the
workbench image (`/app/THIRD-PARTY-NOTICES.md`) and `src/contracts/notices_test.ts` checks it
at every image build: a dependency in `deno.lock`, an import in `deno.json` or an
openbrain-mcp import without a row here fails the build.

Policy (D9): permissive code only (MIT, Apache-2.0, BSD-2/3, ISC, PostgreSQL, MPL-2.0 file-level,
BSD-2-Clause-Patent), Apache-2.0 preferred; AGPL, GPL, BUSL, FCL and non-commercial terms are
design-only; copyleft programs only as separate, unmodified processes or services; model
weights follow the same rule (a model card is a licence). Each licence below was read from the
pinned version's own metadata on 2026-10-17 (registry entry, LICENSE at the tag, model card).

## Code linked into the workbench (deno.lock)

| Name | Version | Licence | Copyright | URL |
|---|---|---|---|---|
| @hono/hono | 4.13.5 | MIT | 2021-present Yusuke Wada and Hono contributors | https://jsr.io/@hono/hono |
| @hono/zod-openapi | 1.6.3 | MIT | Hono contributors (honojs/middleware) | https://jsr.io/@hono/zod-openapi |
| @hono/zod-validator | 0.9.1 | MIT | Hono contributors (honojs/middleware) | https://jsr.io/@hono/zod-validator |
| @asteasolutions/zod-to-openapi | 9.1.0 | MIT | 2022 Astea Solutions | https://github.com/asteasolutions/zod-to-openapi |
| openapi3-ts | 4.6.2 | MIT | Metadev | https://github.com/metadevpro/openapi3-ts |
| yaml | 2.9.1 | ISC | Eemeli Aro | https://github.com/eemeli/yaml |
| zod | 4.6.5 | MIT | Colin McDonnell | https://github.com/colinhacks/zod |
| deno-postgres (deno.land/x/postgres) | 0.19.3 | MIT | 2018-2022 Bartlomiej Iwanczuk and Steven Guerrero | https://github.com/denodrivers/postgres |
| @std/assert (tests only) | 1.0.19 | MIT | 2018-2022 the Deno authors | https://jsr.io/@std/assert |
| @std/internal (tests only) | 1.0.14 | MIT | 2018-2022 the Deno authors | https://jsr.io/@std/internal |
| Deno standard library, deno.land/std (via deno-postgres) | 0.214.0 | MIT | the Deno authors | https://github.com/denoland/std |

## Code linked into openbrain-mcp (the MCP host of the contract, D14)

| Name | Version | Licence | Copyright | URL |
|---|---|---|---|---|
| @hono/mcp | 0.1.1 | MIT (package.json at the monorepo tag; honojs/middleware has no root LICENSE) | Hono contributors | https://www.npmjs.com/package/@hono/mcp |
| @modelcontextprotocol/sdk | 1.24.3 | MIT | Anthropic, PBC | https://github.com/modelcontextprotocol/typescript-sdk |
| hono (npm) | 4.9.2 | MIT | 2021-present Yusuke Wada and Hono contributors | https://www.npmjs.com/package/hono |
| zod (npm, openbrain-mcp) | 4.1.13 | MIT | Colin McDonnell | https://github.com/colinhacks/zod |
| deno-postgres (deno.land/x/postgres, openbrain-mcp) | 0.19.3 | MIT | 2018-2022 Bartlomiej Iwanczuk and Steven Guerrero | https://github.com/denodrivers/postgres |

## Runtimes, separate programs and test tools (not linked)

| Name | Version | Licence | Use | URL |
|---|---|---|---|---|
| Deno | 2.3.3 | MIT | runtime (base image denoland/deno:2.3.3) | https://github.com/denoland/deno |
| pandoc | 3.11 (upstream release binary pandoc-3.11-linux-amd64, sha256 37edb3bb...062ab6) | GPL-2.0-or-later (COPYRIGHT and pandoc.cabal at tag 3.11) | SEPARATE PROCESS only (the export: markdown + a JSON metadata file + a CSL-JSON bibliography file + the verified CSL style in, PDF/DOCX/MD/TXT out, --citeproc built in); never linked, no Lua or JSON filter, no JSON-AST round trip (D9 rule 4); source offer below | https://pandoc.org |
| Typst | 0.15.1 (upstream release binary typst-x86_64-unknown-linux-musl, sha256 a6d077d0...33118c) | Apache-2.0 (LICENSE in the release archive; its NOTICE is carried to /usr/local/share/doc/typst/NOTICE) | separate process: pandoc's PDF engine | https://typst.app |
| Noto CJK fonts (fonts-noto-cjk) | Debian 1:20240730+repack1-1 | OFL-1.1 (Debian copyright: SIL-1.1, Copyright 2010-2012 Google Corporation) | font data: Noto Serif CJK SC is the PDF's main face (CJK glyphs, acceptance 4) | https://github.com/notofonts/noto-cjk |
| Noto Color Emoji (fonts-noto-color-emoji) | Debian 2.051-0+deb13u1 | OFL-1.1 for the font (Debian copyright: `Files: fonts/*`, SIL-1.1, Copyright 2013-2017 Google Inc.; the build tooling is Apache-2.0 and not shipped) | font data: the face Typst falls back to for emoji (rw-p6a-resolve attempt 2) | https://github.com/googlefonts/noto-emoji |
| DejaVu fonts (fonts-dejavu-core) | Debian 2.37-8 | Bitstream-Vera (Debian copyright: `License: bitstream-vera`, Copyright (c) 2003 Bitstream, Inc.; DejaVu changes in the public domain) | font data: Hebrew, Arabic and other scripts in the PDF, the same coverage as Typst's embedded DejaVu Sans Mono (rw-p6a-resolve attempt 2) | https://dejavu-fonts.github.io/ |
| poppler-utils (pdftoppm, pdftotext, pdffonts, pdfinfo) | 25.03.0 (Debian 25.03.0-5+deb13u4) | GPL-2.0-only OR GPL-3.0-only (Debian copyright: GPL-2 or GPL-3) | SEPARATE PROCESS only, over files: reads the export's PDFs back in the image's TEST and PARITY stages; not in the runtime image | https://poppler.freedesktop.org |
| WeasyPrint (parity stage only, never shipped) | 62.3 (Debian 62.3-1) | BSD-3-Clause | the PDF engine before P6a; kept ONLY in the image's parity stage to render the parity fixture through the retired path (acceptance 6); removed from the runtime image | https://weasyprint.org |
| git | 2.47.3 (Debian 1:2.47.3-0+deb13u1) | GPL-2.0-only | SEPARATE PROCESS only (vault commits) | https://git-scm.com |
| PostgreSQL + pgvector (image pgvector/pgvector:pg16@sha256:ccc6e83d...4d6b) | 16.15 / pgvector library 0.8.6 (extension catalog 0.8.2 on the live volume) | PostgreSQL | separate service | https://github.com/pgvector/pgvector |
| Dredd (contract test tool, never shipped) | 14.1.0 | MIT | contract-test/run-contract-tests.ps1 | https://github.com/apiaryio/dredd |
| Node.js (Dredd's runtime, test image only) | 20 (node:20-alpine) | MIT | contract test image only | https://nodejs.org |

## Model weights in use

Every weight the stack configures to serve or load, with the licence its model card states.
"Product" = reached by the research workbench (through LiteLLM, never directly); "beside" =
used by an upstream the product sits beside (D9 rule 7). Inventory taken 2026-10-17 from the
inference plane config, the intake classifier pin and the Open WebUI config (findings
rw-p0-contract).

| Model (repository) | Role | Licence (model card) | Product / beside | Note |
|---|---|---|---|---|
| unsloth/Qwen3.8-27B-GGUF (Qwen3.8-27B-Q4_K_M) | the live chat model behind local-large / local-small (llama-swap slot qwen36-27b) | apache-2.0 (base Qwen/Qwen3.8-27B: apache-2.0) | product | the slot is still labelled ThinkingCap in comments; it serves Qwen3.8 |
| lmstudio-community/Qwen3.6-27B-GGUF | the tracked default for the same slot (.env.example) | apache-2.0 (base Qwen/Qwen3.6-27B: apache-2.0) | product | |
| lmstudio-community/Qwen3.6-35B-A3B-GGUF | configured llama-swap entry, not registered in LiteLLM | apache-2.0 | product (not routed) | |
| bottlecapai/ThinkingCap-Qwen3.6-27B (fine-tune) and its GGUF quant repo | NOT configured live (weights on disk; the slot serves Qwen3.8) | fine-tune card apache-2.0; the GGUF quant repo carries NO licence field | product (not in use) | the missing field on the quant repo is the recorded gap (D9 table) |
| BAAI/bge-m3 (bge-m3-f16.gguf) | embeddings (local-embed) | MIT | product | |
| protectai/deberta-v3-base-prompt-injection-v2 @ 90c9989b | intake I3 classifier (CPU) | apache-2.0 (base microsoft/deberta-v3-base: MIT) | product | |
| hexgrad/Kokoro-82M | TTS - lands in P7a, not deployed | apache-2.0 | product (P7a) | the Kokoro-FastAPI runtime chain is GPL-3 and runs as a separate container (D9) |
| BAAI/bge-reranker-v2-m3 | Open WebUI hybrid-search reranker | apache-2.0 | beside (Open WebUI) | |
| Systran/faster-whisper-base | Open WebUI local speech-to-text | MIT | beside (Open WebUI) | |
| openai/whisper-medium | host STT service the extract sidecar calls | apache-2.0 (card); code MIT | beside (host service) | |
| rhasspy/piper-voices (en_US-amy-medium and four more) | Open Notebook TTS (retires in P7b) | repo card MIT; the amy voice's dataset says "See URL" | beside (Open Notebook) | per-voice dataset licences are not verified; recorded as a gap |

## Attribution text carried verbatim

- MIT (hono, zod, @hono/zod-openapi, @hono/zod-validator, zod-to-openapi, openapi3-ts,
  deno-postgres, deno std, @hono/mcp, @modelcontextprotocol/sdk, Deno, Dredd): "Permission is hereby
  granted, free of charge, to any person obtaining a copy of this software and associated
  documentation files (the "Software"), to deal in the Software without restriction ... THE
  SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND." - each with the copyright line
  in the tables above.
- ISC (yaml): "Permission to use, copy, modify, and/or distribute this software for any purpose
  with or without fee is hereby granted, provided that the above copyright notice and this
  permission notice appear in all copies."

## Code ported into the workbench (research-workbench P6a)

| Name | Version | Licence | Copyright | URL |
|---|---|---|---|---|
| manubot (ported, not installed: the citekey grammar and CSL item clean-up, in src/export/identifiers.ts and src/export/csl.ts) | trunk commit 859dd15850d7e89184e75c3a63e9d9e3f9ab9873 (2026-08-02; manubot/__init__.py says 0.6.1) | BSD-2-Clause-Patent (the repo's LICENSE.md, "BSD-2-Clause Plus Patent License", read at 859dd15) | 2017-2020, Contributors & the Greene Lab at the University of Pennsylvania | https://github.com/manubot/manubot |

**Recorded mismatch (D9 rule 6):** manubot disagrees with itself about its licence. The shipped
`LICENSE.md` at 859dd15 is BSD-2-Clause Plus Patent; `setup.cfg` at the same commit says
`license = BSD 3-Clause License`, and the PyPI metadata of 0.6.1 (`pypi.org/pypi/manubot/0.6.1/json`,
read 2026-10-18) says `BSD 3-Clause License` with the classifier `License :: OSI Approved :: BSD
License`. Both are permissive; this notice follows the repo's LICENSE.md file. Why a port and not
the package: manubot's own retrievers call doi.org, shortdoi.org, NCBI E-utilities and a Zotero
translation-server (AGPL-3.0, design-only under D9) with a User-Agent carrying its author's
address; the export may call only the keyed OpenAlex API and Crossref's polite pool, through the
egress proxy. The manubot licence, verbatim:

> # BSD-2-Clause Plus Patent License
>
> _Copyright © 2017–2020, Contributors & the Greene Lab at the University of Pennsylvania_
>
> Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
>
> 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
>
> 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
>
> Subject to the terms and conditions of this license, each copyright holder and contributor hereby grants to those receiving rights under this license a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable (except for failure to satisfy the conditions of this license) patent license to make, have made, use, offer to sell, sell, import, and otherwise transfer this software, where such license applies only to those patent claims, already acquired or hereafter acquired, licensable by such copyright holder or contributor that are necessarily infringed by:
>
> (a) their Contribution(s) (the licensed copyrights of copyright holders and non-copyrightable additions of contributors, in source or binary form) alone; or
>
> (b) combination of their Contribution(s) with the work of authorship to which such Contribution(s) was added by such copyright holder or contributor, if, at the time the Contribution is added, such addition causes such combination to be necessarily infringed. The patent license shall not apply to any other combinations which include the Contribution.
>
> Except as expressly stated above, no rights or licenses from any copyright holder or contributor is granted under this license, whether expressly, by implication, estoppel or otherwise.
>
> DISCLAIMER
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Citation styles (data, used unmodified)

The export formats citations with styles from the **Citation Style Language (CSL) project**,
https://citationstyles.org/ (styles repository https://github.com/citation-style-language/styles,
fetched at commit 0e5503bd9a75668c402567a93e20b7327784e4fa). The styles are released under the
Creative Commons Attribution-ShareAlike 3.0 Unported licence (https://creativecommons.org/licenses/by-sa/3.0/);
the repository's README asks that software using them mention the CSL project with a link to
https://citationstyles.org/ and keep each style's listing of authors and contributors as is. Each
file in `csl/` is the upstream file byte for byte (its sha256 is in the `citation_styles` registry
and checked at every image build) - a style is never edited, so nothing here is a derivative
that BY-SA would require publishing. The export's about text (`GET /workbench/export/about`)
carries the same mention.

| Style (file) | Title | sha256 | Authors | Contributors |
|---|---|---|---|---|
| ieee.csl | IEEE Reference Guide version 11.29.2023 | b4c7619fc16c45a31e4cc3271eab94ffe83192d3b4c7fc729470a3b459448de3 | Michael Berkowitz | Julian Onions, Rintze Zelle, Stephen Frank, Sebastian Karcher, Giuseppe Silano, Patrick O'Brien, Brenton M. Wiernik, Oliver Couch, Andrew Dunning |
| elsevier-vancouver.csl | Elsevier - NLM/Vancouver (citation-sequence) | 005e915c3419eb2b84eb2b31bffc411dce3890619d3fd0ed23ac6591ac128335 | Richard Karnesky | (none listed) |
| apa.csl | APA Style 7th edition | 3917def5fc951b104d64216c3373096042368b9704ba269ca83c14ebaba889fc | Brenton M. Wiernik, Andrew Dunning | Jay Pfaffman |

## Metadata services the export's resolver calls (shipped inert)

| Service | Used for | Terms (as the service publishes them; re-read before enabling the resolver) |
|---|---|---|
| OpenAlex API (keyed: OPENALEX_API_KEY) | canonical metadata of a work by DOI, arXiv, PubMed, PMC or OpenAlex id | OpenAlex data is released under CC0 |
| Crossref REST API, polite pool (CROSSREF_MAILTO) | the fallback for a DOI | Crossref bibliographic metadata is offered without restriction (facts); abstracts are not used |

## pandoc: GPL-2.0-or-later source offer

The image carries the unmodified upstream pandoc 3.11 release binary
(https://github.com/jgm/pandoc/releases/tag/3.11), licensed under the GNU General Public License,
version 2 or later. The workbench runs it as a separate program (markdown and a metadata file in,
a document out); pandoc is not part of the workbench and is not linked to it. Its complete
corresponding source code is https://github.com/jgm/pandoc/archive/refs/tags/3.11.tar.gz (also
on Hackage as pandoc-3.11). Whoever distributes an image carrying this binary offers, for at
least three years from that distribution, to give anyone a copy of that source on a medium
customarily used for software interchange, for no more than the cost of performing the copy.
poppler-utils (GPL) is never in a distributed image: it is installed in the test and parity
build stages only.

## Fonts

- Noto CJK (Noto Serif CJK SC, the export PDF's main face): SIL Open Font License 1.1 (Debian's
  copyright file: `Files: *`, `Copyright: 2010-2012, Google Corporation`, `License: SIL-1.1`); the
  font files are used unmodified from Debian's `fonts-noto-cjk` 1:20240730+repack1-1, whose
  copyright file carries the licence text (`/usr/share/doc/fonts-noto-cjk/copyright` in the image).
- Noto Color Emoji (the export PDF's emoji fallback face): SIL Open Font License 1.1 (Debian's
  copyright file: `Files: fonts/*`, `Copyright: 2013-2017 Google Inc.`, `License: SIL-1.1`); the
  font file is used unmodified from Debian's `fonts-noto-color-emoji` 2.051-0+deb13u1, whose
  copyright file carries the licence text (`/usr/share/doc/fonts-noto-color-emoji/copyright`).
- DejaVu (Sans, Serif, Mono; Hebrew, Arabic and more in the export PDF): the Bitstream Vera licence
  (Copyright (c) 2003 by Bitstream, Inc.; DejaVu changes are in the public domain), unmodified from
  Debian's `fonts-dejavu-core` 2.37-8, whose copyright file carries the licence text
  (`/usr/share/doc/fonts-dejavu-core/copyright`).
- Typst embeds its own default fonts (Libertinus Serif, New Computer Modern, DejaVu Sans Mono);
  their licences are listed in Typst's NOTICE, carried to `/usr/local/share/doc/typst/NOTICE`.
