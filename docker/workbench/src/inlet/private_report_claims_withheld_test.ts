// deno test src/inlet/private_report_claims_withheld_test.ts - slot 660 (init-private-report-claims-withheld.sql,
// research-workbench rw-withheld-owner-view): the migration files read as text. Inside the image the migrations are not in
// the build context and every case returns early; on a checkout they run (the lab, run-private-report-claims-withheld-lab.ps1,
// runs the SQL itself).
import { assert, assertEquals } from "jsr:@std/assert@1";

const dir = new URL("../../../", import.meta.url); // OB1/docker/
async function read(name: string): Promise<string | null> {
  try {
    return (await Deno.readTextFile(new URL(name, dir))).replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
}
async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
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
// the SQL a file runs: comment lines and trailing comments dropped (a comment may name a statement it does not run)
function code(text: string): string {
  return text.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
}
// slot 660's own files: on a checkout (the compose file is there) a missing one is a FAIL, not a skip
async function read660(name: string): Promise<string | null> {
  const t = await read(name);
  if (t === null && (await read("docker-compose.yml")) !== null) throw new Error(`${name} is missing on this checkout`);
  return t;
}
const OWN = "public.private_report_claims_own_text_shows(p_sub TEXT, p_title TEXT, p_body TEXT)";
const OF = "public.private_report_claims_withheld_of(p_sub TEXT)";

Deno.test("slot 660 is mounted once in the initdb chain, after 600 and before 990, with its live order, revert and check", async () => {
  const compose = await read("docker-compose.yml");
  if (compose === null) return;
  const mount = "./init-private-report-claims-withheld.sql:/docker-entrypoint-initdb.d/660-init-private-report-claims-withheld.sql:ro";
  assertEquals(compose.split(mount).length - 1, 1, "mounted once");
  assertEquals((compose.match(/\/docker-entrypoint-initdb\.d\/660-/g) ?? []).length, 1, "slot 660 is this file's alone");
  const i575 = compose.indexOf("575-init-private-report-claims-scope.sql"), i600 = compose.indexOf("600-init-inlet-connections-read.sql");
  const i660 = compose.indexOf(mount), i990 = compose.indexOf("990-init-rest-door-auth-final.sql");
  assert(i575 > 0 && i600 > i575 && i660 > i600 && i990 > i660, "575, 600, then 660, then 990");
  const line = compose.slice(i660, compose.indexOf("\n", i660));
  for (const s of ["live: psql -f AFTER 570", "RE-RUN IT AFTER ANY 570 RE-RUN", "revert: revert-private-report-claims-withheld.sql FIRST", "check: check-private-report-claims-withheld.sql"]) {
    assert(line.includes(s), `the mount's comment says: ${s}`);
  }
});

Deno.test("slot 575's init and revert (and 570's) are byte-unchanged (development 1c4ce946, OB1 66ddb63)", async () => {
  const want: Record<string, string> = {
    "init-private-report-claims-scope.sql": "9c38bb96ef46719516d247419320c54c57cf1ad5bc341cb1d6f1b5c1856c001c",
    "revert-private-report-claims-scope.sql": "473e7a14f84fe84121195a377898fa33c4581b3755eac66ee132ceb8d4025248",
    "init-private-report-claims.sql": "e825e87894b768646772ed0d7a899856421d5701742936e78ce05ad82ae97aff",
    "revert-private-report-claims.sql": "7e1689ad39c1ffaeeaadb67d1bb77bbf49ca54b07ec71cc2cb9d87a3f21c2865",
  };
  for (const [f, h] of Object.entries(want)) {
    const t = await read(f);
    if (t === null) return;
    assertEquals(await sha256(t), h, `${f} unchanged`);
  }
});

Deno.test("slot 660's own-sentence check reads the subject's store AND the withheld claims the subject is party to", async () => {
  const s570 = await read("init-private-report-claims.sql");
  const fwd = await read660("init-private-report-claims-withheld.sql");
  if (s570 === null || fwd === null) return;
  const own = fn(fwd, OWN);
  // the store branch is 570's, unchanged: the subject's own rows that a private report links
  assert(own.includes("FROM public.inlet_private_claims c"), "reads the subject's store");
  assert(own.includes("WHERE c.inlet_owner_sub = p_sub"), "the store rows are the subject's own");
  assert(own.includes("EXISTS (SELECT 1 FROM public.research_private_report_claims pc WHERE pc.claim_id = c.id)"), "a private report links them");
  // the new read: the withheld claims of this subject (never every withheld claim)
  assert(own.includes("FROM public.private_report_claims_withheld_of(p_sub)"), "reads the subject's withheld claims");
  assert(!/private_report_claims_archive/.test(own), "never reads the archive directly (every withheld claim would refuse anyone)");
  assert(own.includes("coalesce(btrim(p_sub), '') <> ''"), "nothing for a blank subject");
  assert(own.includes("length(public.private_report_claim_norm(o.text)) >= 24"), "24+ letters, 570's match");
  assert(own.includes("position(public.private_report_claim_norm(o.text) IN page.t) > 0"), "570's match");
  assert(own.includes("SECURITY DEFINER") && own.includes("SET search_path = public, pg_temp"), "570's security shape");
  // the helper: an x row not restored, linked to one of THIS subject's private reports, the subject a valid owner
  const of = fn(fwd, OF);
  assert(of.includes("FROM public.research_private_reports p"), "the subject's reports");
  assert(of.includes("JOIN public.research_private_report_claims pc ON pc.report_id = p.id"), "their links (570 kept them for a withheld claim)");
  assert(of.includes("JOIN public.private_report_claims_archive a ON a.action = 'x' AND a.restored_at IS NULL AND a.ref = pc.claim_id::text"), "the withheld claim, not restored");
  assert(of.includes("WHERE p.owner_sub = p_sub"), "only the subject's own reports");
  assert(of.includes("public.private_report_claim_subject_ok(p_sub)"), "a valid owner only (570's rule for who may own a private row)");
  assert(!of.includes("SECURITY DEFINER"), "the helper runs as its caller (the definer functions above); nobody else reads the archive");
  // REVOKE from PUBLIC, and the default privileges taken back
  assert(fwd.includes("REVOKE ALL ON FUNCTION public.private_report_claims_withheld_of(TEXT) FROM PUBLIC;"));
  assert(fwd.includes("REVOKE ALL ON FUNCTION public.private_report_claims_own_text_shows(TEXT, TEXT, TEXT) FROM PUBLIC;"));
  assert(!/GRANT\s/i.test(code(fwd)), "slot 660 grants nothing");
});

Deno.test("slot 660 moves no row and takes no table lock (no ACCESS EXCLUSIVE on a public table), refuses without 570", async () => {
  const fwd = await read660("init-private-report-claims-withheld.sql");
  if (fwd === null) return;
  const c = code(fwd);
  for (const rx of [/\bLOCK\s+TABLE\b/i, /\bALTER\s+TABLE\b/i, /\bCREATE\s+TRIGGER\b/i, /\bDROP\s+TRIGGER\b/i, /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i,
                    /\bINSERT\s+INTO\s+public\./i, /\bUPDATE\s+public\./i, /\bDELETE\s+FROM\s+public\./i, /\bTRUNCATE\b/i, /\bCREATE\s+(OR\s+REPLACE\s+)?VIEW\b/i]) {
    assert(!rx.test(c), `slot 660 runs no ${rx}`);
  }
  assert(c.includes("slot 570 (init-private-report-claims.sql) must be applied first"), "refuses without 570");
  assert(c.includes("BEGIN;") && c.includes("COMMIT;"), "one transaction");
});

Deno.test("slot 660's revert puts 570's own-sentence check back byte for byte and drops the helper; the check names both", async () => {
  const s570 = await read("init-private-report-claims.sql");
  const rev = await read660("revert-private-report-claims-withheld.sql");
  const chk = await read660("check-private-report-claims-withheld.sql");
  if (s570 === null || rev === null || chk === null) return;
  assertEquals(fn(rev, OWN), fn(s570, OWN), "the revert's is 570's");
  assert(rev.includes("DROP FUNCTION IF EXISTS public.private_report_claims_withheld_of(TEXT);"), "the helper goes");
  // when 570 was reverted first (its revert drops the check), the revert does not leave 570's check behind
  assert(rev.includes("tgname = 'trg_private_report_claims_wiki_guard'"), "the revert keys on 570 being installed");
  for (const s of ["withheld: slot 660 applied=", "withheld: OK", "withheld: FAIL", "private_report_claims_withheld_of(", "a 570 re-run"]) {
    assert(chk.includes(s), `the check says: ${s}`);
  }
});
