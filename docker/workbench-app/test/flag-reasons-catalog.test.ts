// rwr-flag-reasons-six: the CATALOG test. The server's flag_reasons registry (what the migrations register, read from the SQL
// files that create it) and the app's list of reasons must be the same set, key for key; a reason on one side that the other
// lacks fails here. The e2e fake (the route's stand-in) is held to the same set, and the labels are the registry's words.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REASONS } from "../src/components/flag/flag-data";
import { REASONS as FAKE_REASONS } from "../e2e/flags-fake.mjs";

const DOCKER = join(__dirname, "..", "..");
// Inside the image build the migrations are not in the build context (the same as the Deno migration test): the test then
// has nothing to read and is skipped there; it runs on every checkout (npm test).
const HAVE_SQL = existsSync(join(DOCKER, "init-flags.sql"));
const sql = (f: string) => readFileSync(join(DOCKER, f), "utf8");
// every ('flag_reasons', '<key>', '<label>', ...) row an init file registers, in file order
const rows = (text: string) => [...text.matchAll(/\(\s*'flag_reasons'\s*,\s*'([a-z_]+)'\s*,\s*'([^']*)'/g)].map((m) => ({ key: m[1], label: m[2] }));
// the registry as a fresh database builds it: slot 500, then the slots that add reasons
const SLOTS = ["init-flags.sql", "init-flag-reasons-six.sql"];
const registry = HAVE_SQL ? SLOTS.flatMap((f) => rows(sql(f))) : [];

describe.skipIf(!HAVE_SQL)("the server's flag_reasons registry and the app's list are one set", () => {
  it("the registry has no key twice, and the app lists exactly its keys", () => {
    const keys = registry.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(REASONS.map((r) => r.key).sort());
  });
  it("the app's list is in the approved order and its labels are the registry's words", () => {
    expect(REASONS.map((r) => r.key)).toEqual(["wrong_claim", "low_quality", "duplicate", "outdated", "broken_link", "other"]);
    const byKey = new Map(registry.map((r) => [r.key, r.label]));
    for (const r of REASONS) expect(r.label.toLowerCase()).toBe(byKey.get(r.key));
  });
  it("the e2e fake accepts the same keys (it stands in for the route)", () => {
    expect([...FAKE_REASONS].sort()).toEqual(registry.map((r) => r.key).sort());
  });
  it("the check is live: a reason missing from either side is seen", () => {
    const keys = registry.map((r) => r.key);
    expect(keys.filter((k) => k !== "broken_link").sort()).not.toEqual(REASONS.map((r) => r.key).sort());
    expect([...keys, "spam"].sort()).not.toEqual(REASONS.map((r) => r.key).sort());
  });
  it("the revert removes exactly the keys the forward adds, and nothing of slot 500", () => {
    const added = rows(sql("init-flag-reasons-six.sql")).map((r) => r.key).sort();
    expect(added).toEqual(["broken_link", "outdated"]);
    const rev = sql("revert-flag-reasons-six.sql");
    for (const k of added) expect(rev).toContain(`'${k}'`);
    for (const k of ["wrong_claim", "low_quality", "duplicate", "other"]) expect(rev).not.toContain(`'${k}'`);
  });
});
