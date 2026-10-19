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
| pandoc | 3.1.11.1 (Debian 3.1.11.1+ds-2) | GPL-2.0-or-later | SEPARATE PROCESS only (note export, markdown in / document out); never linked (D9 rule 4) | https://pandoc.org |
| WeasyPrint | 62.3 (Debian 62.3-1) | BSD-3-Clause | pandoc's PDF engine, separate process | https://weasyprint.org |
| git | 2.47.3 (Debian 1:2.47.3-0+deb13u1) | GPL-2.0-only | SEPARATE PROCESS only (vault commits) | https://git-scm.com |
| PostgreSQL + pgvector (image pgvector/pgvector:pg16@sha256:ccc6e83d...4d6b) | 16.15 / pgvector library 0.8.6 (extension catalog 0.8.2 on the live volume) | PostgreSQL | separate service | https://github.com/pgvector/pgvector |
| Dredd (contract test tool, never shipped) | 14.1.0 | MIT | contract-test/run-contract-tests.ps1 | https://github.com/apiaryio/dredd |
| Node.js (Dredd's runtime, test image only) | 20 (node:20-alpine) | MIT | contract test image only | https://nodejs.org |

## Data services queried by the research service (research-workbench P3a; no code used)

The research service (`integrations/research-service/scholarly.ts`) resolves scholarly
identifiers for the D15 credibility model by calling two public REST APIs through its egress
proxy. No code, SDK or dataset of either is copied, linked or shipped: the client is written in
this repository. The terms below are as the services publish them and were NOT re-read in
rw-p3a-entail (the item made no network call); re-verify before enabling the resolver
(`RESEARCH_SCHOLARLY_MAILTO`).

| Service | Used for | Data terms (as published) | URL |
|---|---|---|---|
| OpenAlex API (OurResearch) | work metadata (`cited_by_count`, `publication_date`, authorships) and author `works_count`; keyed client | data CC0; API key per the service's terms | https://openalex.org |
| Crossref REST API | fallback work metadata (`is-referenced-by-count`, `published`, authors) via the polite pool (`mailto`) | bibliographic metadata facts, no licence restriction stated for metadata | https://api.crossref.org |

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
