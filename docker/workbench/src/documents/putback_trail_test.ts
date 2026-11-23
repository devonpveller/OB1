// deno test -A src/documents/putback_trail_test.ts - rwr-trail-grants-exact F2: the trail line of a document put back
// (restore) is written AFTER the move and its listing update have committed. A failing trail write is logged with
// its own cause and changes nothing else: the listing row (its id, refinery link, reference holders) follows the file.
// The database stand-in has a REAL transaction (a snapshot put back when the callback throws), unlike lifecycle_test.ts's.
import { assert, assertEquals } from "jsr:@std/assert@1";

const vault = await Deno.makeTempDir({ prefix: "putback-vault-" });
const prevGitDir = Deno.env.get("WIKI_GIT_DIR");
Deno.env.set("WIKI_GIT_DIR", vault);
const sh = async (...a: string[]) => {
  const r = await new Deno.Command("git", { args: ["-C", vault, ...a], stdout: "piped", stderr: "piped" }).output();
  if (!r.success) throw new Error(new TextDecoder().decode(r.stderr));
};
await sh("init", "-q");
await sh("config", "user.email", "t@lab.local");
await sh("config", "user.name", "lab");
const docs = await import("./repo.ts");

interface L { id: string; path: string; title: string; updated_at: Date; owner_sub: string }
let listings = new Map<string, L>();
let trail: Record<string, unknown>[] = [];
let failTrail = false;
let failListing = false;
// deno-lint-ignore no-explicit-any
const mk = (inTx: boolean): any => ({
  query: (sql: string, a: unknown[] = []) => {
    if (/SELECT .*FROM public\.user_document_listings WHERE path = \$1/s.test(sql)) {
      const l = listings.get(a[0] as string);
      return Promise.resolve(l ? [{ ...l, refinery_id: null }] : []);
    }
    if (/UPDATE public\.reference_holders/.test(sql)) return Promise.resolve([]);
    if (/UPDATE public\.user_document_listings SET path = \$2/.test(sql)) {
      if (failListing) return Promise.reject(new Error("listing update failed (test)"));
      const l = listings.get(a[0] as string);
      if (l) {
        listings.delete(l.path);
        listings.set(a[1] as string, { ...l, path: a[1] as string });
      }
      return Promise.resolve([]);
    }
    if (/INSERT INTO public\.user_document_trail/.test(sql)) {
      if (failTrail) return Promise.reject(new Error('new row violates check constraint "user_document_trail_kind_check" (test)'));
      const [owner_sub, actor_sub, kind, document_id, path, trashed_at] = a;
      trail.push({ owner_sub, actor_sub, kind, document_id, path, trashed_at });
      return Promise.resolve([{ id: String(trail.length) }]);
    }
    return Promise.resolve([]);
  },
  tx: async (fn: (t: unknown) => Promise<unknown>) => {
    if (inTx) return await fn(mk(true));
    const snapL = new Map(listings);
    const snapT = [...trail];
    try {
      return await fn(mk(true));
    } catch (e) {
      listings = snapL;
      trail = snapT;
      throw e;
    }
  },
});
const deps = { db: mk(false), reg: {} as never };
const A: import("../middleware/identity.ts").Identity = { sub: "alice", actor: "alice", name: "alice", key: "alice", kind: "user", admin: false, impersonating: null };

let n = 0;
async function plantTrashed() {
  const rel = `documents/alice/notes/p${++n}.md`;
  const tr = `documents/alice/.trash/notes/p${n}.md`;
  await Deno.mkdir(`${vault}/documents/alice/.trash/notes`, { recursive: true });
  await Deno.writeTextFile(`${vault}/${tr}`, "# P\n\nbody\n");
  await sh("add", "--", tr);
  await sh("commit", "-q", "-m", `plant ${tr}`);
  const id = crypto.randomUUID();
  listings.set(tr, { id, path: tr, title: "P", updated_at: new Date(), owner_sub: "alice" });
  return { rel, tr, id };
}
const exists = (p: string) => Deno.stat(`${vault}/${p}`).then(() => true, () => false);
// the console.error lines of one call
async function logged<T>(fn: () => Promise<T>): Promise<{ out: T; logs: string[] }> {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    return { out: await fn(), logs };
  } finally {
    console.error = orig;
  }
}

Deno.test("F2: a failing trail write after the move leaves the listing row with the file, writes no line, and names the trail", async () => {
  const { rel, tr, id } = await plantTrashed();
  trail = [];
  failTrail = true;
  const { out, logs } = await logged(() => docs.restoreDocument(deps, tr, A));
  failTrail = false;
  assertEquals(out, { restored: rel });
  assert(await exists(rel) && !(await exists(tr)), "the file is at its live path");
  assertEquals(listings.get(rel)?.id, id, "the listing row followed the file (same id)");
  assert(!listings.has(tr), "no listing row left at the trash path");
  assertEquals(trail.length, 0, "no line");
  assert(logs.some((l) => /trail line/.test(l) && /kind_check/.test(l)), `the log names the trail write: ${logs.join(" | ")}`);
  assert(!logs.some((l) => /listing move/.test(l)), `the log does not blame the listing move: ${logs.join(" | ")}`);
});

Deno.test("F2: a failing listing update does not stop the line: the move happened, so the line is written", async () => {
  const { rel, tr } = await plantTrashed();
  trail = [];
  failListing = true;
  const { out, logs } = await logged(() => docs.restoreDocument(deps, tr, A));
  failListing = false;
  assertEquals(out, { restored: rel });
  assert(listings.has(tr), "the listing row stays for the reconcile pass");
  assertEquals(trail.length, 1);
  assertEquals([trail[0].kind, trail[0].path, trail[0].owner_sub], ["restored", rel, "alice"]);
  assert(logs.some((l) => /listing move/.test(l)), logs.join(" | "));
});

Deno.test("a restore writes exactly one line, after the listing update, with the listing owner and the document id", async () => {
  const { rel, tr, id } = await plantTrashed();
  trail = [];
  await docs.restoreDocument(deps, tr, A);
  assert(listings.has(rel));
  assertEquals(trail.length, 1);
  assertEquals([trail[0].kind, trail[0].owner_sub, trail[0].document_id, trail[0].path, trail[0].trashed_at], ["restored", "alice", id, rel, null]);
});

Deno.test("a refused move (name taken) writes no line and moves nothing", async () => {
  const { rel, tr } = await plantTrashed();
  trail = [];
  await Deno.mkdir(`${vault}/documents/alice/notes`, { recursive: true });
  await Deno.writeTextFile(`${vault}/${rel}`, "squatter");
  let status = 0;
  try {
    await docs.restoreDocument(deps, tr, A);
  } catch (e) {
    status = (e as { status?: number }).status ?? 0;
  }
  assertEquals(status, 409);
  assertEquals(trail.length, 0);
  assert(await exists(tr) && listings.has(tr));
});

addEventListener("unload", () => {
  if (prevGitDir === undefined) Deno.env.delete("WIKI_GIT_DIR");
  else Deno.env.set("WIKI_GIT_DIR", prevGitDir);
});
