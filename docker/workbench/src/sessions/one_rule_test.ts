// deno test src/sessions/one_rule_test.ts - rw-p4b-sessions round 3 (tester t-p4b-sessions2 defect 1:
// the timeline gave every user an admin's steer text). ONE rule decides whether a research job's question
// is read: OWN_QUERY (contracts/repo/sessions.ts) - the original prompt is its owner's, and a steer's text
// is its actor's and of who may act (sessions/repo.ts STEER_TEXT_HIDDEN). Every SQL in the workbench that
// selects research_jobs.query goes through it (or through the allow-list routes that build on the same
// helpers); a new place that reads `<alias>.query` of research_jobs any other way fails here.
import { assert } from "jsr:@std/assert@1";
import { OWN_QUERY } from "../contracts/repo/sessions.ts";

const who = { sub: "carol", key: "carol", actor: "carol", admin: false };

Deno.test("round 3: OWN_QUERY applies the steer-text rule as well as the owner rule", () => {
  const q = OWN_QUERY("j", "$5", who, "$6").replace(/\s+/g, " ");
  assert(q.includes("research_prompts"), "the owner rule");
  assert(q.includes("j.branch_kind = 'steer'") && q.includes("research_steers"), `the steer-text rule: ${q}`);
});

// Every non-test source file that reads a research job's question: the places that are allowed to, and why.
const ALLOWED: Record<string, RegExp> = {
  // the one rule itself
  "contracts/repo/sessions.ts": /OWN_QUERY|STEER_TEXT_HIDDEN|CASE WHEN o\.others/,
  // the running-session cards: query selected under STEER_TEXT_HIDDEN / FOREIGN_JOB; branch texts via cards.ts treeOf
  "sessions/repo.ts": /STEER_TEXT_HIDDEN|branches\(/,
  // an idea's own sessions, read for the idea's owner only (requireIdea / FOREIGN_IDEA), roots only
  "contracts/repo/ideas.ts": /sessionsOf/,
};

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) yield* walk(u);
    else if (e.name.endsWith(".ts") && !e.name.endsWith("_test.ts")) yield u;
  }
}

Deno.test("round 3: no other workbench SQL selects a research job's question", async () => {
  const root = new URL("../", import.meta.url);
  const offenders: string[] = [];
  for await (const f of walk(root)) {
    const rel = f.href.slice(root.href.length);
    if (rel.startsWith("contracts/generated/")) continue;
    const src = await Deno.readTextFile(f);
    if (!/research_jobs/.test(src)) continue;
    // a SQL select of <alias>.query, or a bare `query` column next to research_jobs columns
    const reads = src.match(/\b[a-z]\.query\b(?![(<])|\bSELECT[^`]*\bquery\b[^`]*FROM public\.research_jobs/g) ?? [];
    if (!reads.length) continue;
    const allow = ALLOWED[rel];
    if (!allow || !allow.test(src)) offenders.push(`${rel}: ${reads.slice(0, 3).join(" | ")}`);
  }
  assert(offenders.length === 0, `research job questions read outside the one rule:\n${offenders.join("\n")}`);
});

Deno.test("round 3: the timeline reads job questions through OWN_QUERY with the viewer", async () => {
  const src = await Deno.readTextFile(new URL("../contracts/repo/knowledge.ts", import.meta.url));
  const calls = src.match(/OWN_QUERY\([^)]*\)/g) ?? [];
  assert(calls.length >= 2, "the timeline uses OWN_QUERY");
  for (const c of calls) assert(/who/.test(c), `OWN_QUERY is called with the viewer (admin flag, actor): ${c}`);
});
