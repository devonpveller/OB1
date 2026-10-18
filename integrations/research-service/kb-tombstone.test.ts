// deno test kb-tombstone.test.ts - D5 item 4 (research-workbench P0): a research query hit whose
// URL is tombstoned is dropped before staging or citation; every other hit passes unchanged.
import { assertEquals } from "jsr:@std/assert@1";
import { dropTombstoned } from "./kb.ts";

function client(tombstoned: Set<string>, calls: unknown[][]) {
  return {
    queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }> {
      calls.push([sql.replace(/\s+/g, " ").trim(), ...(args ?? [])]);
      const url = String(args?.[0] ?? "");
      return Promise.resolve({ rows: [{ id: tombstoned.has(url) ? "tomb-1" : null }] as unknown as T[] });
    },
  };
}

Deno.test("a tombstoned query hit is dropped and recorded; the rest pass in order", async () => {
  const calls: unknown[][] = [];
  const pages = [{ url: "https://a.example/1" }, { url: "https://bad.example/x" }, { url: "" }, { url: "https://c.example/2" }];
  const kept = await dropTombstoned(client(new Set(["https://bad.example/x"]), calls) as never, pages, "sess-1");
  assertEquals(kept.map((p) => p.url), ["https://a.example/1", "", "https://c.example/2"]);
  // one gate call per page with a URL, each carrying the session id
  assertEquals(calls.length, 3);
  for (const c of calls) {
    assertEquals(String(c[0]).includes("contract_record_query_hit"), true);
    assertEquals(c[2], "sess-1");
  }
});

Deno.test("with no tombstones nothing is dropped (the stub databases of the other tests answer no rows)", async () => {
  const empty = { queryObject: () => Promise.resolve({ rows: [] }) };
  const pages = [{ url: "https://a.example/1" }, { url: "https://b.example/2" }];
  assertEquals(await dropTombstoned(empty as never, pages, null), pages);
});
