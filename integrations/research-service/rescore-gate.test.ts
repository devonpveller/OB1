/**
 * The re-score gate's findings-sink half (research-workbench P3a acceptance: "the trigger is
 * re-scored only after the operator's confirmation is recorded in the findings sink (D15); a
 * re-score without that record FAILS"). The database half (OBC03) is in credibility.e2e.test.ts.
 * Run: deno test --allow-read rescore-gate.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { confirmationFor, confirmations, dbConfig } from "./rescore-gate.ts";

const D = "0123456789abcdef0123456789abcdef";
const M = "d15 weights v1 paper p1";
const line = `D15-RESCORE-CONFIRMED digest=${D} model="${M}" by=operator date=2026-10-20`;

Deno.test("no confirmation line in the findings sink: refused", () => {
  const r = confirmationFor("# Findings\n\nThe before/after view is in journal/evidence.\n", D, M);
  assert(!r.ok);
  assert(/has not confirmed/.test(r.reason));
});

Deno.test("a confirmation of ANOTHER view (stale digest) or another model version: refused", () => {
  const stale = confirmationFor(line.replace(D, "f".repeat(32)), D, M);
  assert(!stale.ok && /re-read the view/.test(stale.reason));
  const other = confirmationFor(line, D, "d15 weights v2 paper p1");
  assert(!other.ok && /the database is at/.test(other.reason));
});

Deno.test("the exact confirmation is found, verbatim, in a list item or code span", () => {
  for (const text of [line, `- ${line}`, `\`${line}\``]) {
    const r = confirmationFor(`# Findings\n\n${text}\n`, D, M);
    assert(r.ok, text);
    if (r.ok) { assertEquals(r.c.by, "operator"); assertEquals(r.c.line, line); }
  }
  assertEquals(confirmations(`${line}\n${line.replace("operator", "op2")}`).length, 2);
});

Deno.test("a near-miss line is not a confirmation (no fuzzy match)", () => {
  assertEquals(confirmations(`D15 rescore confirmed digest=${D}`).length, 0);
  assertEquals(confirmations(line.replace("date=2026-10-20", "")).length, 0);
});

// attempt 2 (tester near-miss): attempt 1 defaulted DB_HOST to the live `openbrain-db` and DB_USER
// to `postgres`, so a run without its env reached the live database.
Deno.test("the gate never picks a database by default: DB_HOST, DB_NAME, DB_USER and DB_PASSWORD are each required", () => {
  const full: Record<string, string> = { DB_HOST: "rwp3a-dba-x", DB_NAME: "openbrain", DB_USER: "postgres", DB_PASSWORD: "pw" };
  const ok = dbConfig((k) => full[k]);
  assert(ok.ok);
  if (ok.ok) assertEquals(ok.cfg, { hostname: "rwp3a-dba-x", port: 5432, database: "openbrain", user: "postgres", password: "pw" });
  const none = dbConfig(() => undefined);
  assert(!none.ok && /DB_HOST, DB_NAME, DB_USER, DB_PASSWORD not set/.test(none.reason), JSON.stringify(none));
  for (const k of Object.keys(full)) {
    const r = dbConfig((x) => (x === k ? "  " : full[x]));
    assert(!r.ok && r.reason.includes(k), `${k} blank was accepted`);
  }
  assert(!dbConfig((k) => ({ ...full, DB_PORT: "54x" } as Record<string, string>)[k]).ok, "a bad port");
});

Deno.test({
  name: "the script REFUSES before connecting when its DB env is missing (exit 64, no connection attempt)",
  ignore: (await Deno.permissions.query({ name: "run" })).state !== "granted",
  async fn() {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-read", "--allow-net", "--allow-env", new URL("./rescore-gate.ts", import.meta.url).href, "--findings", "nothing.md"],
      clearEnv: true, env: { DENO_DIR: Deno.env.get("DENO_DIR") ?? "", PATH: Deno.env.get("PATH") ?? "", SystemRoot: Deno.env.get("SystemRoot") ?? "",
        USERPROFILE: Deno.env.get("USERPROFILE") ?? "", HOME: Deno.env.get("HOME") ?? "", LOCALAPPDATA: Deno.env.get("LOCALAPPDATA") ?? "" },
      stdout: "piped", stderr: "piped",
    }).output();
    const err = new TextDecoder().decode(out.stderr);
    assertEquals(out.code, 64, err);
    assert(/REFUSED: refused: DB_HOST/.test(err), err);
    assert(!/openbrain-db|failed to lookup|Connection refused|ConnectionRefused/i.test(err), `it tried to connect: ${err}`);
  },
});
