/**
 * rescore-gate.ts - the ONLY door to re-scoring the claim store under the D15 model
 * (research-workbench P3a, 01-OPEN-ITEMS D15 item 6). Operator-run; nothing calls it.
 *
 *   deno run --allow-read --allow-net --allow-env rescore-gate.ts --findings <findings-sink.md> [--apply]
 *
 * The rule: the claim-confidence trigger changes model only after the operator has READ the
 * before/after view and their confirmation is RECORDED IN THE FINDINGS SINK. So this script
 *   1. reads the current view digest and model version from the database
 *      (public.credibility_before_after_digest(), public.credibility_model_version());
 *   2. looks in the findings file for the confirmation line naming exactly that digest and
 *      version (`confirmationFor` below) - no line, or a line for another digest, and it stops;
 *   3. only with --apply: records the confirmation in the database
 *      (credibility_record_confirmation, which refuses a stale digest itself) and applies it
 *      (credibility_apply_d15_trigger, which refuses without a recorded confirmation).
 * Without --apply it prints what it found and changes nothing. The database half refuses on its
 * own (OBC03), so a re-score that skips this script still cannot happen without a confirmation
 * row, and the row is only written from a line found in the sink.
 *
 * The confirmation line (one line, in the findings sink, written by or for the operator):
 *   D15-RESCORE-CONFIRMED digest=<32 hex> model="d15 weights vN paper pK" by=<who> date=<YYYY-MM-DD>
 *
 * DB_* env, ALL REQUIRED (attempt 2, tester near-miss: attempt 1 defaulted DB_HOST to the live
 * `openbrain-db` and DB_USER to `postgres`, so a mis-scoped run reached the live database):
 * DB_HOST, DB_NAME, DB_USER and DB_PASSWORD must each be set explicitly (DB_PORT defaults to
 * 5432, a port is not a target). Without them the script refuses before it opens a connection
 * (exit 64). `dbConfig` is that rule, tested in rescore-gate.test.ts.
 */

export interface Confirmation { digest: string; model: string; by: string; date: string; line: string }

const LINE_RE = /^\s*(?:[-*]\s*)?`?D15-RESCORE-CONFIRMED\s+digest=([0-9a-f]{32})\s+model="([^"]+)"\s+by=(\S+)\s+date=(\d{4}-\d{2}-\d{2})`?\s*$/;

/** Every confirmation line in a findings text. */
export function confirmations(findings: string): Confirmation[] {
  const out: Confirmation[] = [];
  for (const raw of String(findings || "").split(/\r?\n/)) {
    const m = raw.match(LINE_RE);
    if (m) out.push({ digest: m[1], model: m[2], by: m[3], date: m[4], line: raw.trim().replace(/^[-*]\s*/, "").replace(/^`|`$/g, "") });
  }
  return out;
}

/** The confirmation for exactly this digest and model version, or why there is none. */
export function confirmationFor(findings: string, digest: string, model: string): { ok: true; c: Confirmation } | { ok: false; reason: string } {
  const all = confirmations(findings);
  if (!all.length) return { ok: false, reason: "no D15-RESCORE-CONFIRMED line in the findings sink: the operator has not confirmed the before/after view" };
  const c = all.find((x) => x.digest === digest);
  if (!c) return { ok: false, reason: `the findings sink confirms ${all.map((x) => x.digest).join(", ")}, not the current view ${digest}: re-read the view` };
  if (c.model !== model) return { ok: false, reason: `the confirmation names model "${c.model}", the database is at "${model}"` };
  return { ok: true, c };
}

export interface DbConfig { hostname: string; port: number; database: string; user: string; password: string }

/** The connection the operator named - every target field explicit, or why it is refused. */
export function dbConfig(env: (k: string) => string | undefined): { ok: true; cfg: DbConfig } | { ok: false; reason: string } {
  const need = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"];
  const missing = need.filter((k) => !(env(k) ?? "").trim());
  if (missing.length) {
    return { ok: false, reason: `refused: ${missing.join(", ")} not set - the re-score gate never picks a database by default (name the one you mean)` };
  }
  const port = Number(env("DB_PORT") ?? "5432");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, reason: `refused: DB_PORT '${env("DB_PORT")}' is not a port` };
  return { ok: true, cfg: { hostname: env("DB_HOST")!.trim(), port, database: env("DB_NAME")!.trim(), user: env("DB_USER")!.trim(), password: env("DB_PASSWORD")! } };
}

if (import.meta.main) {
  const args = Deno.args;
  const at = args.indexOf("--findings");
  const findingsPath = at >= 0 ? args[at + 1] : "";
  const apply = args.includes("--apply");
  if (!findingsPath) { console.error("usage: rescore-gate.ts --findings <findings-sink.md> [--apply]"); Deno.exit(64); }
  const db = dbConfig((k) => Deno.env.get(k));
  if (!db.ok) { console.error(`REFUSED: ${db.reason}`); Deno.exit(64); }
  const { Client } = await import("postgres");
  const client = new Client(db.cfg);
  await client.connect();
  try {
    const cur = (await client.queryObject<{ digest: string; model: string }>(
      `SELECT public.credibility_before_after_digest() AS digest, public.credibility_model_version() AS model`)).rows[0];
    console.log(`current before/after view: digest=${cur.digest} model="${cur.model}"`);
    const found = confirmationFor(await Deno.readTextFile(findingsPath), cur.digest, cur.model);
    if (!found.ok) { console.error(`REFUSED: ${found.reason}`); Deno.exit(3); }
    console.log(`confirmation found: by=${found.c.by} date=${found.c.date}`);
    if (!apply) { console.log("dry run: nothing recorded, nothing re-scored (pass --apply)"); Deno.exit(0); }
    await client.queryObject(`SELECT public.credibility_record_confirmation($1, $2, $3, $4)`,
      [cur.digest, found.c.by, findingsPath, found.c.line]);
    const n = (await client.queryObject<{ n: number }>(`SELECT public.credibility_apply_d15_trigger($1) AS n`, [cur.digest])).rows[0].n;
    console.log(`applied: the trigger now uses ${cur.model}; ${n} active claim(s) re-scored`);
  } finally {
    await client.end();
  }
}
