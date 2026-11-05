// deno test --allow-read ext-owner.test.ts - rw-mcp-identity round 2 (tester F2): openbrain-ext's rows became multi-user,
// so no write may take another owner's id and no read may join another owner's row. Source checks over
// docker/extensions-server/index.ts (the lab's T9 drives the same through the real server with foreign ids).
import { assert } from "jsr:@std/assert@1";

const src = (await Deno.readTextFile(new URL("../../docker/extensions-server/index.ts", import.meta.url))).replace(/\r\n/g, "\n");

Deno.test("every JOIN in openbrain-ext is owner-scoped (the joined row's user_id equals the row's)", () => {
  const joins = [...src.matchAll(/\bJOIN\s+(\w+)\s+(\w+)\s+ON\s+([^\n`]+)/g)];
  assert(joins.length >= 9, `expected the nine joins, found ${joins.length}`);
  for (const m of joins) assert(new RegExp(`\\b${m[2]}\\.user_id\\s*=`).test(m[3]), `not owner-scoped: JOIN ${m[1]} ${m[2]} ON ${m[3]}`);
});

Deno.test("every id-bearing insert checks the id names the caller's own row first (assertOwned)", () => {
  const inserts = [...src.matchAll(/insertRow\("(\w+)", \{([\s\S]*?)\n\s*\}/g)];
  let checked = 0;
  for (const m of inserts) {
    const ids = [...m[2].matchAll(/\b(\w+_id):\s*(?:a|m)\.\w+/g)].map((x) => x[1]).filter((k) => k !== "user_id");
    if (!ids.length) continue;
    const before = src.slice(Math.max(0, m.index! - 500), m.index!);
    for (const id of ids) {
      const arg = id; // the argument shares the column's name
      assert(new RegExp(`assertOwned\\("\\w+", (?:a|m)\\.${arg}\\b`).test(before), `insert into ${m[1]} takes ${id} without assertOwned`);
      checked++;
    }
  }
  assert(checked >= 10, `expected at least 10 id-bearing inserts, checked ${checked}`);
});

Deno.test("no single-row read by id in openbrain-ext forgets the owner", () => {
  const byId = [...src.matchAll(/FROM (\w+) WHERE id = \$1([^`]*)`/g)];
  for (const m of byId) assert(/user_id/.test(m[2]), `FROM ${m[1]} WHERE id = $1 without user_id`);
});
