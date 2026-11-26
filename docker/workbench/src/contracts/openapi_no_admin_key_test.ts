// deno test --allow-read src/contracts/openapi_no_admin_key_test.ts - rw-settings-registry-tier: the published contract artifacts
// (openapi.json, mcp-tools.json, types.ts, the kubernetes tool list) name no admin-tier settings key, nor that key's declared
// default mount. The admin keys are read from the slot that declares them (public.settings_keys rows with tier 'admin'), so a key
// added later is covered without editing this test.
import { assert } from "jsr:@std/assert@1";

const here = new URL(".", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, here));
// The Docker test stage holds only docker/workbench: the slots and the kubernetes tool list live outside it, so those reads (and the
// checks that need them) are skipped there and run from a checkout, in `deno test` and in the DB lab's checkout-side runs.
const readIf = (rel: string): string | null => { try { return read(rel); } catch { return null; } };
const KNOWN_ADMIN = ["podcast.archive_destination"]; // the admin key the settings registry holds (init-research-contract.sql)

function adminKeys(): string[] {
  const sql = ["init-settings.sql", "init-ui-state.sql", "init-settings-tags.sql"].map((f) => readIf(`../../../${f}`) ?? "").join("\n");
  const keys = [...sql.matchAll(/\(\s*'([a-z0-9_]+\.[a-z0-9_.]+)'\s*,\s*'admin'/g)].map((m) => m[1]);
  return [...new Set([...KNOWN_ADMIN, ...keys])];
}

Deno.test("the admin-tier key list is real (from a checkout: it holds every admin key the slots declare)", {
  ignore: readIf("../../../init-settings.sql") === null,
}, () => {
  assert(adminKeys().length >= 8, adminKeys().join(","));
});

Deno.test("no published contract artifact names an admin-tier settings key or its default mount", () => {
  const files = ["generated/openapi.json", "generated/mcp-tools.json", "generated/types.ts", "../../../../integrations/kubernetes-deployment/contract-tools.json", "schemas/examples.ts"];
  let seen = 0;
  for (const f of files) {
    const text = readIf(f);
    if (text === null) continue;
    seen++;
    for (const k of [...adminKeys(), "podcast-archive"]) assert(!text.includes(k), `${f} names '${k}'`);
  }
  assert(seen >= 3, `the generated artifacts were read (${seen})`);
});
