// deno test --allow-read src/contracts/openapi_no_admin_key_test.ts - rw-settings-registry-tier: the published contract artifacts
// (openapi.json, mcp-tools.json, types.ts, the kubernetes tool list) name no admin-tier settings key, nor that key's declared
// default mount. The admin keys are read from the slot that declares them (public.settings_keys rows with tier 'admin'), so a key
// added later is covered without editing this test.
import { assert } from "jsr:@std/assert@1";

const here = new URL(".", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, here));

function adminKeys(): string[] {
  const sql = read("../../../init-settings.sql") + read("../../../init-ui-state.sql") + read("../../../init-settings-tags.sql");
  const keys = [...sql.matchAll(/\(\s*'([a-z0-9_]+\.[a-z0-9_.]+)'\s*,\s*'admin'/g)].map((m) => m[1]);
  return [...new Set(keys)];
}

Deno.test("the admin-tier key list is real (it names the key the review found)", () => {
  assert(adminKeys().includes("podcast.archive_destination"), adminKeys().join(","));
});

Deno.test("no published contract artifact names an admin-tier settings key or its default mount", () => {
  const files = ["generated/openapi.json", "generated/mcp-tools.json", "generated/types.ts", "../../../../integrations/kubernetes-deployment/contract-tools.json", "schemas/examples.ts"];
  for (const f of files) {
    const text = read(f);
    for (const k of [...adminKeys(), "podcast-archive"]) assert(!text.includes(k), `${f} names '${k}'`);
  }
});
