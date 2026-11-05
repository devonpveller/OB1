// rw-boundary-digest round 2 (tester F6): the digest's owner comes from ONE place (owner-sub.ts), and no other file of
// the recipe carries its own owner env read or the "operator" fallback.
// Run: deno test --allow-read src/enrich/owner-sub.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { digestOwnerSub } from "./owner-sub.ts";

Deno.test("digestOwnerSub: the container's own variable, else WORKSPACE_DEFAULT_SUB, else the single-user default", () => {
  const of = (m: Record<string, string>) => digestOwnerSub((k) => m[k]);
  assertEquals(of({ DIGEST_OWNER_SUB: " sub-a " }), "sub-a");
  assertEquals(of({ PODCAST_OWNER_SUB: "sub-b" }), "sub-b");
  assertEquals(of({ PODCAST_OWNER_SUB: "  ", WORKSPACE_DEFAULT_SUB: "sub-c" }), "sub-c");
  assertEquals(of({}), "operator");
});

Deno.test("no other file of the recipe reads an owner variable or carries the operator fallback", async () => {
  const root = new URL("../../", import.meta.url);
  const offenders: string[] = [];
  const walk = async (dir: URL) => {
    for await (const e of Deno.readDir(dir)) {
      const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
      if (e.isDirectory) { if (!["node_modules", ".git"].includes(e.name)) await walk(u); continue; }
      if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts") || u.pathname.endsWith("/src/enrich/owner-sub.ts")) continue;
      const src = await Deno.readTextFile(u);
      if (/env\(\s*"(DIGEST_OWNER_SUB|PODCAST_OWNER_SUB|WORKSPACE_DEFAULT_SUB)"/.test(src) || /\|\|\s*"operator"/.test(src) ||
          /OWNER_SUB",\s*"operator"/.test(src)) offenders.push(u.pathname.split("/daily-digest/")[1]);
    }
  };
  await walk(root);
  assertEquals(offenders, []);
});
