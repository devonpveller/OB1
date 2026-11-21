// deno test src/contracts/flags_test.ts - flag for cleanup (rwr-flags-api), no database: the repository's writes,
// the registry-limited reason, the contract document, and the migration files.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createContractApp, openApiDocument } from "./app.ts";
import { RegistryReader, UnregisteredValue } from "./registry.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import type { Db } from "./db.ts";
import { createFlag, updateFlag } from "./repo/flags.ts";
import type { Identity } from "../middleware/identity.ts";

const WHO: Identity = { sub: "user-a", actor: "user-a", name: "A", key: "user-a" };
const SRC = "11111111-1111-4111-8111-111111111111";

// a recording Db: every statement is kept so the test can assert what a flag touches
function recorder(rows: Record<string, unknown[]> = {}) {
  const log: string[] = [];
  const db: Db = {
    query: <T>(sql: string) => {
      log.push(sql.replace(/\s+/g, " ").trim());
      if (/FROM public\.contract_registry_view|contract_registry_view/.test(sql)) return Promise.resolve(rows.registry as T[] ?? []);
      if (/SELECT EXISTS/.test(sql)) return Promise.resolve([{ ok: true }] as T[]);
      if (/INSERT INTO public\.user_flags/.test(sql)) {
        return Promise.resolve([{
          id: "f1a90000-0000-4000-8000-000000000001", item_kind: "source", item_id: SRC, reason: "low_quality", note: "n",
          from_kind: "source", from_ref: SRC, state: "open", created_at: "t", updated_at: "t", owner_sub: "user-a",
        }] as T[]);
      }
      return Promise.resolve([] as T[]);
    },
    tx: (fn) => fn(db),
  };
  return { db, log };
}

const entry = (registry: string, key: string) => ({ registry, key, version: 1, label: key, definition: {}, retired_at: null, superseded_by: null });
const REG = [
  ...["wrong_claim", "low_quality", "duplicate", "other"].map((k) => entry("flag_reasons", k)),
  ...["source", "claim", "reference"].map((k) => entry("flag_item_kinds", k)),
  ...["document", "source"].map((k) => entry("flag_from_kinds", k)),
  ...["open", "withdrawn"].map((k) => entry("flag_states", k)),
];
function reader(db: Db) {
  const r = new RegistryReader(db);
  // deno-lint-ignore no-explicit-any
  (r as any).all = () => Promise.resolve(REG);
  return r;
}

Deno.test("a flag writes only its own row: nothing is written to the flagged item's table", async () => {
  const { db, log } = recorder();
  const f = await createFlag(db, reader(db), WHO, { item_kind: "source", item_id: SRC, reason: "low_quality", note: "n", from: { kind: "source", ref: SRC } });
  assertEquals(f.flagged_by, null);
  const writes = log.filter((l) => /^(INSERT|UPDATE|DELETE)/i.test(l));
  assertEquals(writes.length, 1);
  assert(/^INSERT INTO public\.user_flags/.test(writes[0]), writes[0]);
  assert(log.every((l) => !/sources|claims|reference_records/.test(l) || /^SELECT EXISTS/.test(l)), "the item's table is only ever read");
});

Deno.test("a reason outside the four is refused before anything is written", async () => {
  const { db, log } = recorder();
  await assertRejects(
    () => createFlag(db, reader(db), WHO, { item_kind: "source", item_id: SRC, reason: "spam", from: { kind: "source", ref: SRC } }),
    UnregisteredValue,
  );
  assertEquals(log.filter((l) => /^(INSERT|UPDATE)/i.test(l)).length, 0);
  await assertRejects(() => updateFlag(db, reader(db), WHO, "f1a90000-0000-4000-8000-000000000001", { reason: "spam" }), UnregisteredValue);
});

Deno.test("an update is scoped to the owner in SQL (owner_sub = the seam's subject)", async () => {
  const { db, log } = recorder();
  await updateFlag(db, reader(db), WHO, "f1a90000-0000-4000-8000-000000000001", { note: "x" });
  const u = log.find((l) => /^UPDATE public\.user_flags/.test(l))!;
  assert(/WHERE id = \$1 AND owner_sub = \$2/.test(u), u);
});

Deno.test("the contract document carries the four flag routes, the reason is a registry, and no flag operation is an MCP tool", () => {
  const noDb: Db = { query: () => Promise.reject(new Error("no db")), tx: () => Promise.reject(new Error("no db")) };
  const app = createContractApp({
    db: noDb, registry: new RegistryReader(noDb), scorer: unavailableScorer, embed: () => Promise.reject(new Error("x")),
    chunk: () => [], mountsRoot: "/m", streamPollMs: 1000, log: () => {},
  });
  // deno-lint-ignore no-explicit-any
  const doc = openApiDocument(app) as any;
  const base = doc.paths["/workbench/contract/flags"];
  assert(base.post && base.get);
  const one = doc.paths["/workbench/contract/flags/{id}"];
  assert(one.get && one.patch);
  for (const op of [base.post, base.get, one.get, one.patch]) assert(!op["x-mcp-tool"], "a flag is never exposed on the shared MCP surface");
  assertEquals(doc.components.schemas.FlagCreate.properties.reason["x-registry"], "flag_reasons");
  assert(!("enum" in doc.components.schemas.FlagCreate.properties.reason));
  assertEquals(doc.components.schemas.FlagCreate.additionalProperties, false);
  assert(!("owner_sub" in doc.components.schemas.FlagCreate.properties), "no user field on the request");
});

Deno.test("migration files: slot 500 is mounted, the revert undoes what the forward adds", async () => {
  let compose: string, fwd: string, rev: string;
  try {
    const d = new URL("../../../", import.meta.url);
    compose = await Deno.readTextFile(new URL("docker-compose.yml", d));
    fwd = await Deno.readTextFile(new URL("init-flags.sql", d));
    rev = await Deno.readTextFile(new URL("revert-flags.sql", d));
  } catch {
    return; // inside the image the migrations are not in the build context
  }
  assert(compose.includes("./init-flags.sql:/docker-entrypoint-initdb.d/500-init-flags.sql:ro"));
  assertEquals((compose.match(/\/docker-entrypoint-initdb\.d\/500-/g) ?? []).length, 1);
  assert(/revert: revert-flags\.sql/.test(compose) && /fresh-volume/.test(compose) && /live: psql -f/.test(compose));
  assert(/CREATE TABLE IF NOT EXISTS public\.user_flags/.test(fwd) && /DROP TABLE IF EXISTS public\.user_flags/.test(rev));
  for (const r of ["flag_reasons", "flag_item_kinds", "flag_from_kinds", "flag_states"]) {
    assert(fwd.includes(`('${r}',`), `${r} declared`);
    assert(rev.includes(`'${r}'`), `${r} removed by the revert`);
  }
  // the four reasons, exactly
  const reasons = [...fwd.matchAll(/\('flag_reasons', '([a-z_]+)'/g)].map((m) => m[1]).sort();
  assertEquals(reasons, ["duplicate", "low_quality", "other", "wrong_claim"]);
  // the forward touches no shared knowledge table
  assert(!/(ALTER|CREATE (OR REPLACE )?TRIGGER|UPDATE) .*public\.(sources|claims|reference_records)/i.test(fwd));
});
