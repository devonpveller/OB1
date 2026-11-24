// deno test src/inlet/private_report_claims_scope_test.ts - slot 575 (init-private-report-claims-scope.sql, research-workbench
// rw-570-hub-note-scope): the migration files read as text. Inside the image the migrations are not in the build context and
// every case returns early; on a checkout they run (the lab, run-private-report-claims-scope-lab.ps1, runs the SQL itself).
import { assert, assertEquals } from "jsr:@std/assert@1";

const dir = new URL("../../../", import.meta.url); // OB1/docker/
async function read(name: string): Promise<string | null> {
  try {
    return (await Deno.readTextFile(new URL(name, dir))).replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}
// a CREATE OR REPLACE FUNCTION statement, through the "$$;" that closes its body (the next REVOKE excluded)
function fn(text: string, name: string): string {
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION ${name}`);
  assert(start >= 0, `${name} is defined`);
  const open = text.indexOf("AS $$\n", start);
  const close = text.indexOf("\n$$;", open);
  assert(open > start && close > open, `${name}: a $$ body`);
  return text.slice(start, close + 4);
}
// a pg_temp helper's whole definition, through its closing "$$;"
function tempFn(text: string, name: string): string {
  const start = text.indexOf(`CREATE OR REPLACE FUNCTION pg_temp.${name}(`);
  assert(start >= 0, `pg_temp.${name} is defined`);
  const close = text.indexOf("\n$$;", start);
  return text.slice(start, close + 4);
}

Deno.test("slot 575 is mounted once in the initdb chain, after 570 and before 580, with its live order and revert", async () => {
  const compose = await read("docker-compose.yml");
  if (compose === null) return;
  const mount = "./init-private-report-claims-scope.sql:/docker-entrypoint-initdb.d/575-init-private-report-claims-scope.sql:ro";
  assertEquals(compose.split(mount).length - 1, 1, "mounted once");
  assertEquals((compose.match(/\/docker-entrypoint-initdb\.d\/575-/g) ?? []).length, 1, "slot 575 is this file's alone");
  const i570 = compose.indexOf("570-init-private-report-claims.sql"), i575 = compose.indexOf(mount), i580 = compose.indexOf("580-init-boundary-ideas.sql");
  assert(i570 > 0 && i575 > i570 && i580 > i575, "570, then 575, then 580");
  const line = compose.slice(i575, compose.indexOf("\n", i575));
  for (const s of ["live: psql -f AFTER 570", "RE-RUN IT AFTER ANY 570 RE-RUN", "revert: revert-private-report-claims-scope.sql FIRST", "check: check-private-report-claims-scope.sql"]) {
    assert(line.includes(s), `the mount's comment says: ${s}`);
  }
});

Deno.test("slot 575's revert puts slot 570's two guard functions back byte for byte; its forward changes only the R1 / R4 lines", async () => {
  const s570 = await read("init-private-report-claims.sql");
  const fwd = await read("init-private-report-claims-scope.sql");
  const rev = await read("revert-private-report-claims-scope.sql");
  if (s570 === null || fwd === null || rev === null) return;
  for (const name of ["public.trg_private_report_claims_wiki_guard()", "public.trg_private_report_claims_gap_guard()"]) {
    assertEquals(fn(rev, name), fn(s570, name), `${name}: the revert's is 570's`);
  }
  // R4: the forward's gap guard is 570's but for exactly the three coalesce tests
  const a = fn(s570, "public.trg_private_report_claims_gap_guard()").split("\n");
  const b = fn(fwd, "public.trg_private_report_claims_gap_guard()").split("\n");
  assertEquals(a.length, b.length);
  const changed = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
  assertEquals(changed.map(([, y]) => y.trim()), [
    "IF coalesce(NEW.branch_kind, '') NOT IN ('gap', 'interhub') THEN RETURN NEW; END IF;",
    "IF coalesce(NEW.steer_kind, '') NOT IN ('gap', 'interhub') THEN RETURN NEW; END IF;",
    "IF NOT (coalesce(NEW.type, '') IN ('gap', 'interhub_gap')",
  ]);
  // R1: the forward's wiki guard sends only a person's note (the helper) to the author-only branch; 570's sent every 'note'
  const wg = fn(fwd, "public.trg_private_report_claims_wiki_guard()");
  assert(wg.includes("IF public.private_report_claims_person_note(NEW.slug, NEW.page_class) THEN") && !wg.includes("NEW.page_class = 'note'"));
  assert(fn(s570, "public.trg_private_report_claims_wiki_guard()").includes("IF NEW.page_class = 'note' THEN"), "570's guard (the RED)");
  assert(fwd.includes("SELECT (coalesce(p_class, '') = 'note' AND (left(coalesce(p_slug, ''), 6) = 'notes/' OR (left(coalesce(p_slug, ''), 18) = 'content/notebooks/' AND split_part(p_slug, '/', 4) <> '' AND NOT (split_part(p_slug, '/', 5) = '' AND split_part(p_slug, '/', 4) = split_part(p_slug, '/', 3)))))"), "a person's note: notes/..., or a structured note (content/notebooks/<nb>/<note>, not the hub or index)");
  assert(/DROP FUNCTION IF EXISTS public\.private_report_claims_person_note\(TEXT, TEXT\);/.test(rev), "the revert drops the helper");
});

Deno.test("slot 575 takes no ACCESS EXCLUSIVE lock: no constraint, column or trigger is dropped or added; it never names the hand-backs", async () => {
  const fwd = await read("init-private-report-claims-scope.sql");
  const rev = await read("revert-private-report-claims-scope.sql");
  if (fwd === null || rev === null) return;
  const code = (t: string) => t.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const [name, t] of [["forward", code(fwd)], ["revert", code(rev)]] as const) {
    assert(!/ACCESS EXCLUSIVE/i.test(t), `${name}: no ACCESS EXCLUSIVE`);
    assert(!/\b(CREATE|DROP)\s+TRIGGER\b/i.test(t), `${name}: no trigger created or dropped`);
    assert(!/ALTER\s+TABLE\s+public\./i.test(t), `${name}: no ALTER TABLE on a public table`);
    assert(!/DROP\s+CONSTRAINT|ADD\s+CONSTRAINT/i.test(t), `${name}: no constraint change`);
    for (const m of t.matchAll(/ALTER\s+TABLE\s+(\S+)/gi)) assert(m[1].startsWith("_sc_"), `${name}: ALTER TABLE only on its own temp tables (${m[1]})`);
    assert(!/handback/i.test(t), `${name}: the hand-backs are not named (the boundary lab's allow-list)`);
    assert(/IN SHARE ROW EXCLUSIVE MODE/.test(t), `${name}: writers wait, readers go on`);
  }
  // the archive actions it writes are ones slot 570's own revert restores (plus its batch marker z)
  const acts = new Set([...code(fwd).matchAll(/'public\.[a-z_]+', '([a-z])'/g)].map((m) => m[1]));
  for (const a of acts) assert(["k", "x", "e", "m", "j", "l", "w"].includes(a), `action ${a}`);
  assert(fwd.includes("VALUES (v_batch, 'slot 575', 'z', '575'"), "each batch carries the z marker");
  const r570 = await read("revert-private-report-claims.sql");
  if (r570) for (const a of ["k", "x", "e", "m", "j", "w", "l"]) assert(r570.includes(`action = ''${a}''`) || r570.includes(`action = '${a}'`) || r570.includes(`''${a}''`), `570's revert restores ${a}`);
});

Deno.test("the check, count and scope scripts judge as slot 575 does: the same normaliser as 570, the same person-note rule, the same fragment rule", async () => {
  const s570 = await read("init-private-report-claims.sql");
  const chk = await read("check-private-report-claims.sql");
  const cnt = await read("count-private-report-claim-reuse.sql");
  const scp = await read("check-private-report-claims-scope.sql");
  if (s570 === null || chk === null || cnt === null || scp === null) return;
  const body = (t: string, start: string) => { const i = t.indexOf(start); const j = t.indexOf("AS $$\n", i); return t.slice(j, t.indexOf("\n$$;", j)); };
  const norm570 = body(s570, "CREATE OR REPLACE FUNCTION public.private_report_claim_norm(");
  for (const [name, t] of [["check", chk], ["count", cnt], ["scope", scp]] as const) {
    assertEquals(body(t, "CREATE OR REPLACE FUNCTION pg_temp.prc_norm("), norm570, `${name}: prc_norm is 570's normaliser`);
    assertEquals(tempFn(t, "prc_frag"), tempFn(chk, "prc_frag"), `${name}: the fragment rule is the check script's`);
    assertEquals(tempFn(t, "prc_withheld"), tempFn(chk, "prc_withheld"), `${name}: the withheld texts are the check script's`);
  }
  const rule = "(coalesce(w.page_class, '') = 'note' AND (left(coalesce(w.slug, ''), 6) = 'notes/' OR (left(coalesce(w.slug, ''), 18) = 'content/notebooks/' AND split_part(w.slug, '/', 4) <> '' AND NOT (split_part(w.slug, '/', 5) = '' AND split_part(w.slug, '/', 4) = split_part(w.slug, '/', 3)))))";
  for (const [name, t] of [["check", chk], ["count", cnt], ["scope", scp]] as const) assert(t.includes(rule), `${name}: a person's note is class note under notes/`);
  assert(!chk.includes("w.page_class IS DISTINCT FROM 'note'"), "the check no longer skips every note-class page");
  // the fragment rule reads 570's archive as 575 does: the synthesis rows (s), the claim's synthesis_id rows (d), k / x
  const frag = tempFn(chk, "prc_frag");
  for (const s of ["a.action = 's' AND a.tbl = 'public.sources'", "a.action = 'd' AND a.tbl IN ('public.claims', 'claims') AND a.row_data ->> '_col' = 'synthesis_id'",
                   "a.action IN ('k', 'x')", "position(cn.n IN sp.n) > 0", "position(f.n IN cn.n) > 0"]) {
    assert(frag.includes(s), `prc_frag: ${s}`);
  }
  const fwd = await read("init-private-report-claims-scope.sql");
  if (fwd) {
    for (const s of ["a.action = 's' AND a.tbl = 'public.sources'", "a.action = 'd' AND a.tbl IN ('public.claims', 'claims') AND a.row_data ->> '_col' = 'synthesis_id'",
                     "a.action IN ('k', 'x')", "position(cn.n IN sp.n) > 0", "position(f.n IN cn.n) > 0"]) {
      assert(fwd.includes(s), `575: ${s}`);
    }
  }
  // the check fails a 570 re-run that undid 575 (and the scope check names it)
  assert(chk.includes("NOT (scope_applied AND NOT scope_in_place)") && chk.includes("re-run 575"));
  assert(scp.includes("THEN 'scope: OK' ELSE 'scope: FAIL'"));
});

// round 2 (R6): the wiki pass normalises each page once (the memo) and never calls 570's per-page predicate; the
// withheld pages are archived in ctid order (rw-570-perf attempt 2); the memo is filled before the locks
Deno.test("slot 575 (R6): one skeleton per text through the memo, filled before the locks; no per-page page_shows; archive in ctid order", async () => {
  const fwd = await read("init-private-report-claims-scope.sql");
  if (fwd === null) return;
  const code = fwd.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  const move = code.slice(code.indexOf("DECLARE\n    v_batch"));
  assert(!/private_report_claims_page_shows\(/.test(move), "the move never calls page_shows per page");
  assert(!/public\.private_report_claim_norm\(/.test(move), "the move normalises only through the memo (pg_temp.sc_n)");
  assert(code.indexOf("CREATE TEMP TABLE _sc_memo") < code.indexOf("LOCK TABLE public.wiki_pages"), "the memo is created before the locks");
  assert(code.indexOf("PERFORM pg_temp.sc_memo(") < code.indexOf("LOCK TABLE public.wiki_pages"), "and filled before them");
  assertEquals((move.match(/'public\.wiki_pages', 'w'[\s\S]*?ORDER BY w\.ctid;/g) ?? []).length, 2, "both page archive inserts are in ctid order");
  assert(/DROP FUNCTION pg_temp\.sc_n\(TEXT\);/.test(code), "the memo function goes with the run");
});

// round 2 (R5): the structured-note check function, its grants and its revert
Deno.test("slot 575 (R5): private_report_claims_note_refused is the guard's predicate, gated to the workbench / services, dropped by the revert", async () => {
  const fwd = await read("init-private-report-claims-scope.sql");
  const rev = await read("revert-private-report-claims-scope.sql");
  if (fwd === null || rev === null) return;
  const f = fn(fwd, "public.private_report_claims_note_refused(");
  assert(f.includes("IF NOT public.private_report_claims_reader_ok() THEN"), "gated: ob_workbench, ob_app_memory or a superuser session, never PostgREST");
  assert(f.includes("RETURN public.private_report_claims_page_shows(coalesce(p_slug, '') || ' ' || coalesce(p_title, ''), p_body);"), "the guard's machine-path predicate");
  assert(f.includes("RETURN public.private_report_claims_own_text_shows(nullif(btrim(coalesce(p_author, '')), ''),"), "a person's / structured note: the WRITER's own (as the guard with the same author)");
  assert(/GRANT EXECUTE ON FUNCTION public\.private_report_claims_note_refused\(TEXT, TEXT, TEXT, TEXT\) TO ob_workbench;/.test(fwd));
  assert(/REVOKE ALL ON FUNCTION public\.private_report_claims_note_refused\(TEXT, TEXT, TEXT, TEXT\) FROM PUBLIC;/.test(fwd));
  assert(/DROP FUNCTION IF EXISTS public\.private_report_claims_note_refused\(TEXT, TEXT, TEXT, TEXT\);/.test(rev));
});
