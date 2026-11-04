/**
 * R7 (plan 09 section 5; rw-boundary-core acceptance 4): for a DIRECT job (a typed prompt) the synthesis and the claim
 * the curator files carry no 5-word span of the prompt; a DERIVED job's synthesis is filed as written (its question
 * is public). Driven through the REAL runResearch with every seam stubbed; the stub synthesiser copies the prompt.
 * RED on 8241755 (harness.ts handed the curator `synthesis` and `claim` unfiltered, plan 09 2.6); GREEN on
 * rw-boundary-core. Self-contained on purpose (only harness.ts, prompt-private.ts and the credibility fixtures, which
 * the base has too), so the same file runs against the base:   deno test --allow-read boundary-r7.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type Deps, type FetchResult, type QueryClient, runResearch } from "./harness.ts";
import { promptSpans } from "./prompt-private.ts";
import { credibilityRows } from "./fixtures/credibility-seeds.ts";

const ENTITY = "vestibular motion sickness";
const PRIVATE = "zqPRMm1a2b3c4d";
const QUERY = `Research on the mechanism of vestibular motion sickness: what do studies show for ${PRIVATE} my cousin's long sailing trip next spring?`;
const PAPER = "https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2021.757735/full";
const NEWS = "https://www.reuters.com/health/vestibular-motion-sickness-2026";

function recordingDb(): QueryClient {
  return {
    queryObject<T>(sql: string): Promise<{ rows: T[] }> {
      const rows = (r: unknown[]) => Promise.resolve({ rows: r as T[] });
      const cred = credibilityRows(sql);
      if (cred) return rows(cred);
      if (/INSERT INTO public\.sessions/i.test(sql)) return rows([{ id: "00000000-0000-4000-8000-0000000000a1" }]);
      if (/find_or_create_source/i.test(sql)) return rows([{ id: "src:x", was_duplicate: false }]);
      return rows([]);
    },
  };
}

const page = (url: string, content: string): FetchResult => ({
  page: { url, title: `${ENTITY} - ${new URL(url).hostname}`, content, domain: new URL(url).hostname, links: [] }, outcome: "ok",
});

function deps() {
  const pkgs: Record<string, unknown>[] = [];
  const d: Deps = {
    embed: () => Promise.resolve(new Array(1024).fill(0)),
    chat: (sys, user) => {
      if (sys.includes("ENTAILMENT JUDGE")) return Promise.resolve(JSON.stringify({ verdict: "supports", rationale: "stub" }));
      if (sys.includes("research planner")) return Promise.resolve(JSON.stringify({ needs: ["What mechanism causes vestibular motion sickness?"] }));
      if (sys.includes("web-search queries")) return Promise.resolve(JSON.stringify({ entity: ENTITY, queries: ["mechanism studies"] }));
      if (sys.includes("already covered by KNOWN CLAIMS")) return Promise.resolve(JSON.stringify({ gaps: [0] }));
      if (sys.includes("GATHERED SOURCES")) return Promise.resolve(JSON.stringify({ open: [] }));
      if (sys.includes("research strategist")) return Promise.resolve(JSON.stringify({ queries: [] }));
      if (sys.includes("You screen a fetched web page")) return Promise.resolve("RELEVANT");
      if (sys.includes("You screen fetched web content")) return Promise.resolve("CLEAN");
      if (sys.includes("grounded synthesizer")) {
        const block = user.slice(user.indexOf("SOURCES:"));
        const n = (host: string) => Number((block.match(new RegExp(`\\[Source (\\d+)\\][^\\n]*\\(${host.replace(/\./g, "\\.")}\\)`)) ?? [])[1] ?? 0);
        // the stub synthesiser COPIES the prompt (the R7 shape): its first line restates it, a later line quotes a span
        return Promise.resolve([
          `[SOURCED] On ${QUERY.replace(/\?$/, "")}: visually induced ${ENTITY} follows a visual-vestibular mismatch. [Source ${n("www.frontiersin.org") || 1}]`,
          `[SOURCED] Doctors say ${ENTITY} is common among travellers, so what do studies show for ${PRIVATE} my cousin's trip. [Source ${n("www.reuters.com") || 2}]`,
        ].join("\n"));
      }
      return Promise.resolve("{}");
    },
    searchWeb: () => Promise.resolve([
      { url: PAPER, title: `${ENTITY}: an EEG study`, snippet: `${ENTITY} EEG` },
      { url: NEWS, title: `${ENTITY} is common, say doctors`, snippet: `${ENTITY} news` },
    ]),
    fetchPage: (url) => Promise.resolve(url === PAPER
      ? page(PAPER, `Visually induced ${ENTITY} follows a visual-vestibular mismatch. `.repeat(20))
      : page(url, `Doctors say ${ENTITY} is common among travellers. `.repeat(20))),
    delegateToCurator: (pkg) => {
      pkgs.push(pkg);
      return Promise.resolve({ thread_id: null, persist: { source_ids: [] }, claims: {} });
    },
  };
  return { d, pkgs };
}

async function run(kind: string | undefined) {
  const { d, pkgs } = deps();
  // the option is passed untyped so the same file type-checks against the base (which has no requestKind)
  const opts: Record<string, unknown> = { origin: "owui", jobId: "00000000-0000-4000-8000-0000000000r7" };
  if (kind) opts.requestKind = kind;
  await runResearch(d, recordingDb(), QUERY, opts as never);
  assertEquals(pkgs.length, 1, "the run handed the curator one package");
  return pkgs[0] as { synthesis: string; claim: string; prose: string; query: string };
}

Deno.test("R7: a direct job's filed synthesis and claim carry no 5-word span of the prompt", async () => {
  for (const kind of ["direct", "unclassified", "personal", undefined]) {
    const pkg = await run(kind);
    assertEquals(promptSpans(pkg.synthesis, QUERY), [], `[${kind}] the synthesis copies the prompt: ${pkg.synthesis.slice(0, 200)}`);
    assertEquals(promptSpans(pkg.claim, QUERY), [], `[${kind}] the claim copies the prompt`);
    assert(!pkg.synthesis.includes(PRIVATE) && !pkg.claim.includes(PRIVATE), `[${kind}] the private marker reached the filed copy`);
    // the research itself is still filed: the sourced lines and their citations stay
    assert(pkg.synthesis.includes("visual-vestibular mismatch") && /\[Source \d+\]/.test(pkg.synthesis), `[${kind}] the filed report lost its content`);
    assertEquals(pkg.synthesis.split("\n").length, 2, `[${kind}] the line structure is kept`);
  }
});

Deno.test("R7: a derived job's synthesis is filed as written (its question is public)", async () => {
  const pkg = await run("derived");
  assert(promptSpans(pkg.synthesis, QUERY).length > 0, "a derived job's synthesis was filtered");
});
