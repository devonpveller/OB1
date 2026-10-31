// deno test src/sessions/one_rule_test.ts - rw-p4b-sessions round 3 (tester t-p4b-sessions2 defect 1:
// the timeline gave every user an admin's steer text). ONE rule decides whether a research job's question
// is read: OWN_QUERY (contracts/repo/sessions.ts) - the original prompt is its owner's, and a steer's text
// is its actor's and of who may act (sessions/repo.ts STEER_TEXT_HIDDEN).
// Round 4 (tester t-p4b-sessions3): the guard is per FUNCTION, not per file. Every read of a research job's
// question (`<alias>.query`, a bare `query` column selected from research_jobs, or a whole row as JSON) must
// sit inside one of the functions named below, and each of those functions must still carry its rule - so a
// rule dropped inside jobs(), session() or the card's job() goes red here, and so does a new reader anywhere.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { OWN_QUERY } from "../contracts/repo/sessions.ts";

const who = { sub: "carol", key: "carol", actor: "carol", admin: false };

Deno.test("round 3: OWN_QUERY applies the steer-text rule as well as the owner rule", () => {
  const q = OWN_QUERY("j", "$5", who, "$6").replace(/\s+/g, " ");
  assert(q.includes("research_prompts"), "the owner rule");
  assert(q.includes("j.branch_kind = 'steer'") && q.includes("research_steers"), `the steer-text rule: ${q}`);
});

// file -> function (or const) -> the rule its body must carry (why it may read a job's question)
const ALLOWED: Record<string, Record<string, RegExp[]>> = {
  "contracts/repo/sessions.ts": {
    // the one rule itself: the owner rule AND the steer-text rule
    "const OWN_QUERY": [/OWNERLESS_FOREIGN\(/, /STEER_TEXT_HIDDEN\(/],
    // the job by id: the allow-list for anyone but the owner, the steer text hidden from a non-actor
    "function session": [/FOREIGN_JOB\(/, /STEER_TEXT_HIDDEN\(/, /CASE WHEN o\.others THEN '' ELSE j\.query END/],
    // the jobs list: the same
    "function jobs": [/FOREIGN_JOB\(/, /STEER_TEXT_HIDDEN\(/, /CASE WHEN o\.others THEN '' ELSE left\(j\.query/],
    // shapes a row the SQL above already decided (TS, not SQL)
    "function shapeSession": [/query: r\.query/],
  },
  "sessions/repo.ts": {
    // the card's job: foreign or a hidden steer text reads as ''
    "function job": [/FOREIGN_JOB\(/, /STEER_TEXT_HIDDEN\(/, /CASE WHEN o\.others OR \$\{STEER_TEXT_HIDDEN/],
    // the tree's branches: their texts are decided by cards.ts treeOf (foreign, may act, own steers)
    "function branches": [/research_jobs/],
    // builds the card from job() (TS)
    "function card": [/treeOf|cardOf\(/],
  },
  "contracts/repo/knowledge.ts": {
    // the timeline: every job question through OWN_QUERY, with the viewer (admin flag, actor)
    "function timeline": [/OWN_QUERY\("j", "\$5", who, "\$6"\)/],
  },
  "contracts/repo/ideas.ts": {
    // an idea's own sessions (roots), read for the idea's owner only
    "function sessionsOf": [/refinery_id = \$1/],
  },
};

// the span of a top-level function / const: from its declaration to the next top-level declaration
function spans(src: string): { name: string; from: number; to: number }[] {
  const re = /^(?:export\s+)?(?:async\s+)?(function\s+([A-Za-z0-9_]+)|const\s+([A-Za-z0-9_]+))/gm;
  const starts: { name: string; at: number }[] = [];
  for (const m of src.matchAll(re)) starts.push({ name: m[2] ? `function ${m[2]}` : `const ${m[3]}`, at: m.index! });
  return starts.map((s, i) => ({ name: s.name, from: s.at, to: i + 1 < starts.length ? starts[i + 1].at : src.length }));
}

const READ = /\b[a-z]{1,3}\.query\b(?![(<])|\bSELECT\b[^`]*?\bquery\b[^`]*?\bFROM public\.research_jobs\b|\b(?:to_jsonb|row_to_json|to_json)\(\s*[a-z]{1,3}\s*\)/g;

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
    if (e.isDirectory) yield* walk(u);
    else if (e.name.endsWith(".ts") && !e.name.endsWith("_test.ts")) yield u;
  }
}

export function offendersIn(rel: string, src: string): string[] {
  if (!/research_jobs/.test(src)) return [];
  const out: string[] = [];
  const sp = spans(src);
  const allow = ALLOWED[rel] ?? {};
  for (const m of src.matchAll(READ)) {
    const at = m.index!;
    const fn = sp.find((s) => at >= s.from && at < s.to)?.name ?? "(top level)";
    if (!allow[fn]) out.push(`${rel} ${fn}: reads a job's question outside the one rule (${m[0].slice(0, 60)})`);
  }
  for (const [fn, rules] of Object.entries(allow)) {
    const s = sp.find((x) => x.name === fn);
    if (!s) continue;
    const body = src.slice(s.from, s.to);
    for (const r of rules) if (!r.test(body)) out.push(`${rel} ${fn}: its rule is gone (${r.source})`);
  }
  return out;
}

Deno.test("round 4: every read of a research job's question sits in a named function that still carries its rule", async () => {
  const root = new URL("../", import.meta.url);
  const offenders: string[] = [];
  for await (const f of walk(root)) {
    const rel = f.href.slice(root.href.length);
    if (rel.startsWith("contracts/generated/")) continue;
    offenders.push(...offendersIn(rel, await Deno.readTextFile(f)));
  }
  for (const rel of Object.keys(ALLOWED)) {
    for (const fn of Object.keys(ALLOWED[rel])) {
      const src = await Deno.readTextFile(new URL(rel, root));
      assert(spans(src).some((s) => s.name === fn), `${rel}: ${fn} exists`);
    }
  }
  assertEquals(offenders, [], offenders.join("\n"));
});

Deno.test("round 4: the guard goes red on a dropped rule and on a new reader (mutations)", async () => {
  const root = new URL("../", import.meta.url);
  const ses = await Deno.readTextFile(new URL("contracts/repo/sessions.ts", root));
  const repo = await Deno.readTextFile(new URL("sessions/repo.ts", root));
  // the rule dropped inside session(), jobs(), the card's job(), OWN_QUERY
  const mutants: [string, string][] = [
    ["contracts/repo/sessions.ts", ses.replace(/\n\s*OR \$\{STEER_TEXT_HIDDEN\("j", "\$2", "\$4", who\)\}/, "")],
    ["contracts/repo/sessions.ts", ses.replace(/\n\s*OR \$\{STEER_TEXT_HIDDEN\("j", "\$3", "\$5", who\)\}/, "")],
    ["contracts/repo/sessions.ts", ses.replace(/OR \$\{STEER_TEXT_HIDDEN\(alias, ownerParam, actorParam, who\)\}/, "")],
    ["sessions/repo.ts", repo.replace(/CASE WHEN o\.others OR \$\{STEER_TEXT_HIDDEN\("j", "\$2", "\$4", who\)\} THEN '' ELSE j\.query END/, "j.query")],
    // a new reader in an allow-listed file, and in a new file (raw column, a whole row as JSON)
    ["contracts/repo/sessions.ts", ses + "\nexport async function leak(db: Db) { return await db.query(`SELECT j.query FROM public.research_jobs j`); }\n"],
    ["contracts/repo/new.ts", "export async function leak(db) { return await db.query(`SELECT to_jsonb(j) FROM public.research_jobs j`); }\n"],
    ["contracts/repo/new2.ts", "export async function leak(db) { return await db.query(`SELECT id, query FROM public.research_jobs`); }\n"],
  ];
  mutants.forEach(([rel, src], i) => {
    assert(src !== ses && src !== repo, `mutant ${i} changed nothing`);
    assert(offendersIn(rel, src).length > 0, `mutant ${i} (${rel}) stays green`);
  });
});
