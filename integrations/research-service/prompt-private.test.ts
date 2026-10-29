/**
 * rw-identity round 5 (tester attempt 2; operator 2026-10-28: the original prompt is private, what
 * research derives from it is shared) - NO VERBATIM PROMPT REACHES SHARED KNOWLEDGE (offline; every
 * seam stubbed, as figure-filed.test.ts).
 *   - the curator package's `query` is the DERIVED research question (from the planner's needs), never
 *     the raw prompt; `needs`, `followup_queries` and `prose` carry no span of 5+ consecutive words of it
 *   - the staging session row (public.sessions.query_text) names the run, not the prompt
 *   - every argument the run writes to a shared table carries no 5-word span of the prompt
 * The planner stub here COPIES the prompt verbatim into a need and a follow-up (the worst case).
 * Run: deno test --allow-env --allow-read --allow-net prompt-private.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type Deps, type FetchResult, type QueryClient, runResearch } from "./harness.ts";
import { claimList } from "./claim-list.ts";
import { credibilityRows } from "./fixtures/credibility-seeds.ts";
import { fixtureResolver } from "./fixtures/scholarly-network.ts";
import { promptSpans, withoutPromptSpans } from "./prompt-private.ts";

const ENTITY = "vestibular motion sickness";
const QUERY = "My lawyer Zq01 Smith asked me to research the mechanism of vestibular motion sickness for my case";
const PAPER = "https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2021.757735/full";
const SYN_ID = "00000000-0000-4000-8000-00000000c0de";

interface Logged { sql: string; args: unknown[] }
function recordingDb() {
  const log: Logged[] = [];
  const client: QueryClient = {
    queryObject<T>(sql: string, args: unknown[] = []): Promise<{ rows: T[] }> {
      log.push({ sql: sql.replace(/\s+/g, " ").trim(), args });
      const rows = (r: unknown[]) => Promise.resolve({ rows: r as T[] });
      const cred = credibilityRows(sql);
      if (cred) return rows(cred);
      if (/INSERT INTO public\.sessions/i.test(sql)) return rows([{ id: "00000000-0000-4000-8000-0000000000a1" }]);
      if (/find_or_create_source/i.test(sql)) return rows([{ id: `src:${args[0]}`, was_duplicate: false }]);
      return rows([]);
    },
  };
  return { client, log };
}
const page = (url: string, content: string): FetchResult => ({
  page: { url, title: `${ENTITY} - ${new URL(url).hostname}`, content, domain: new URL(url).hostname, links: [] }, outcome: "ok",
});

function deps() {
  const seen = { pkgs: [] as Record<string, unknown>[] };
  const d: Deps = {
    embed: () => Promise.resolve(new Array(1024).fill(0)),
    chat: (sys, user) => {
      if (sys.includes("ENTAILMENT JUDGE")) return Promise.resolve(JSON.stringify({ verdict: "supports", rationale: "stub" }));
      // the worst case: the planner copies the whole prompt into a need
      if (sys.includes("research planner")) return Promise.resolve(JSON.stringify({ needs: [QUERY, "What mechanism causes vestibular motion sickness?"] }));
      if (sys.includes("web-search queries")) return Promise.resolve(JSON.stringify({ entity: ENTITY, queries: ["mechanism studies"] }));
      if (sys.includes("already covered by KNOWN CLAIMS")) return Promise.resolve(JSON.stringify({ gaps: [0] }));
      if (sys.includes("GATHERED SOURCES")) return Promise.resolve(JSON.stringify({ open: [] }));
      if (sys.includes("research strategist")) return Promise.resolve(JSON.stringify({ queries: [`${QUERY} deeper`] }));
      if (sys.includes("You screen a fetched web page")) return Promise.resolve("RELEVANT");
      if (sys.includes("You screen fetched web content")) return Promise.resolve("CLEAN");
      if (sys.includes("grounded synthesizer")) {
        const block = user.slice(user.indexOf("SOURCES:"));
        const m = block.match(/\[Source (\d+)\]/);
        return Promise.resolve(`[SOURCED] Visually induced ${ENTITY} follows a visual-vestibular mismatch. [Source ${m ? m[1] : 1}]`);
      }
      return Promise.resolve("{}");
    },
    searchWeb: () => Promise.resolve([{ url: PAPER, title: `${ENTITY}: an EEG study`, snippet: `${ENTITY} EEG` }]),
    fetchPage: (url) => Promise.resolve(page(url, `Visually induced ${ENTITY} follows a visual-vestibular mismatch. `.repeat(20))),
    delegateToCurator: (pkg) => {
      seen.pkgs.push(pkg);
      const list = claimList(String(pkg.synthesis ?? "").trim()).claims;
      const sources = pkg.sources as Array<{ url: string }>;
      return Promise.resolve({
        thread_id: null, persist: { synthesis_id: SYN_ID, source_ids: sources.map((s) => `src:${s.url}`) },
        claims: { claimsWritten: list.length, claimsDeduped: 0, claimIds: list.map((_, k) => `c-${k}`), filed: list.map((_, k) => `c-${k}`) },
        claims_error: null,
      });
    },
    scholarly: fixtureResolver(),
    admission: null,
  };
  return { d, seen };
}

const carries = (v: unknown) => promptSpans(JSON.stringify(v ?? ""), QUERY).length > 0;

Deno.test("promptSpans / withoutPromptSpans: 5+ consecutive prompt words, any case and punctuation", () => {
  assertEquals(promptSpans("nothing in common here", QUERY), []);
  assert(promptSpans("the MECHANISM of vestibular motion, sickness!", QUERY).length > 0);
  assert(!promptSpans("vestibular motion sickness studies", QUERY).length, "a 3-word overlap (the topic) is research, not the prompt");
  const out = withoutPromptSpans(`Research: ${QUERY}. Then more.`, QUERY);
  assert(!promptSpans(out, QUERY).length, out);
  assert(out.includes("Then more"), out);
  // a short prompt (under 5 words) is withheld when it appears whole
  assert(!withoutPromptSpans("about Zq01 Smith sues", "Zq01 Smith sues").includes("Zq01"));
});

Deno.test("the curator package files the derived question, and no prompt span in needs, follow-ups or prose", async () => {
  const db = recordingDb();
  const { d, seen } = deps();
  await runResearch(d, db.client, QUERY, { origin: "owui" });
  assertEquals(seen.pkgs.length >= 1, true, "the run reached the curator");
  for (const pkg of seen.pkgs) {
    assert(pkg.query !== QUERY, "the filed query is not the raw prompt");
    assert(String(pkg.query ?? "").trim().length > 0, "a derived question is filed");
    for (const k of ["query", "needs", "followup_queries", "prose"]) assert(!carries(pkg[k]), `pkg.${k} carries a prompt span: ${JSON.stringify(pkg[k]).slice(0, 200)}`);
  }
});

Deno.test("no shared-table write of the run carries a prompt span (the staging session names the run)", async () => {
  const db = recordingDb();
  const { d } = deps();
  await runResearch(d, db.client, QUERY, { origin: "owui" });
  const session = db.log.find((l) => /INSERT INTO public\.sessions/i.test(l.sql));
  assert(session, "the staging session is written");
  assert(!carries(session!.args), `sessions.query_text carries the prompt: ${JSON.stringify(session!.args).slice(0, 200)}`);
  // research_jobs / research_prompts / research_job_events are the job's own (owner-scoped); every other table is shared
  const shared = db.log.filter((l) => /^(INSERT|UPDATE)/i.test(l.sql) && !/research_jobs|research_prompts|research_job_events|research_steers/i.test(l.sql));
  for (const l of shared) assert(!carries(l.args), `${l.sql.slice(0, 80)} carries a prompt span`);
});
