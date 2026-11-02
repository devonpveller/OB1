// idea-tools.test.ts - the Idea Refinery MCP tools' owner check (rw-p8a4-ideas), over a recording fake client.
//   deno test idea-tools.test.ts        (no network, no database; the SQL functions themselves are proven in the
//                                        workbench's P2b lab: src/ideas/ideas_integration_test.ts I4)
// Pinned: every write is ONE call of the owner-checked SQL function, the owner is this server's configured subject
// (never a tool argument), nothing writes `ideas` / `idea_revisions` directly, and another owner's idea (the
// function's not_found) fails the tool and leaves no thought behind.
import { ideaOwner, promoteIdea, researchIdea, updateIdea, type IdeaClient } from "./idea-tools.ts";

function assert(c: unknown, m = "assertion failed"): asserts c {
  if (!c) throw new Error(m);
}
function eq(a: unknown, b: unknown, m = "") {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m} expected ${y}, got ${x}`);
}

function fake(outcome: Record<string, unknown>) {
  const log: { sql: string; args: unknown[] }[] = [];
  const client: IdeaClient = {
    queryObject: <T>(sql: string, args: unknown[] = []) => {
      log.push({ sql, args });
      if (/INSERT INTO thoughts/.test(sql)) return Promise.resolve({ rows: [{ id: 42n }] as unknown as T[] });
      return Promise.resolve({ rows: [{ o: outcome }] as unknown as T[] });
    },
    queryArray: (sql: string, args: unknown[] = []) => {
      log.push({ sql, args });
      return Promise.resolve({});
    },
  };
  return { client, log };
}

const ID = "a1000000-0000-4000-8000-0000000000a1";
const EDIT = { idea_id: ID, idea: " refined ", embedding: "[0.1]", exposure: "ops", channel: "#ideas" };
const directWrites = (log: { sql: string }[]) => log.filter((l) => /(INSERT INTO|UPDATE)\s+(public\.)?(ideas|idea_revisions)\b/.test(l.sql));

Deno.test("ideaOwner: the configured default subject, else the seam's placeholder - never a tool argument", () => {
  eq(ideaOwner(() => undefined), "operator");
  eq(ideaOwner(() => "   "), "operator");
  eq(ideaOwner((k) => (k === "WORKSPACE_DEFAULT_SUB" ? " sub-123 " : undefined)), "sub-123");
});

Deno.test("update_idea: one idea_edit() call with the server's owner, the thought in the same transaction; no direct write", async () => {
  const { client, log } = fake({ outcome: "changed", revision: 3, title: "T" });
  const r = await updateIdea(client, "owner-a", EDIT);
  assert(!r.isError && /revision 3/.test(r.text) && /room/.test(r.text), r.text);
  const calls = log.filter((l) => /idea_edit\(/.test(l.sql));
  eq(calls.length, 1, "one function call");
  eq(calls[0].args.slice(0, 4), [ID, "owner-a", "service:openbrain-mcp", "refined"], "owner, actor, text");
  eq(String(calls[0].args[6]), "42", "the thought row is passed to the revision");
  eq(log.map((l) => l.sql).filter((s) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(s)), ["BEGIN", "COMMIT"]);
  eq(directWrites(log).length, 0, "no direct write of ideas / idea_revisions");
});

Deno.test("update_idea on ANOTHER owner's idea: the function says not_found, the tool fails, the thought is rolled back", async () => {
  const { client, log } = fake({ outcome: "not_found" });
  let err = "";
  try {
    await updateIdea(client, "owner-a", EDIT);
  } catch (e) {
    err = (e as Error).message;
  }
  eq(err, `no idea with id ${ID}`);
  assert(log.some((l) => l.sql === "ROLLBACK") && !log.some((l) => l.sql === "COMMIT"), "nothing committed");
  eq(directWrites(log).length, 0);
});

Deno.test("update_idea: identical text and an archived refinery commit nothing", async () => {
  for (const [o, err] of [["unchanged", false], ["archived", true]] as const) {
    const { client, log } = fake({ outcome: o });
    const r = await updateIdea(client, "owner-a", EDIT);
    eq(!!r.isError, err, o);
    assert(!log.some((l) => l.sql === "COMMIT"), `${o}: nothing committed`);
  }
});

Deno.test("research_idea: one idea_research() call with the server's owner; another owner's idea fails; no flag write", async () => {
  const ok = fake({ outcome: "queued", job_id: "job-1" });
  const r = await researchIdea(ok.client, "owner-a", ID, "#ideas");
  assert(/job-1/.test(r.text), r.text);
  eq(ok.log.filter((l) => /idea_research\(/.test(l.sql))[0].args, [ID, "owner-a", "service:openbrain-mcp"]);
  eq(directWrites(ok.log).length, 0, "the old metadata.research_now flag write is gone");
  const no = fake({ outcome: "not_found" });
  let err = "";
  try { await researchIdea(no.client, "owner-a", ID, "#ideas"); } catch (e) { err = (e as Error).message; }
  eq(err, `no idea with id ${ID}`);
  const ar = await researchIdea(fake({ outcome: "archived" }).client, "owner-a", ID, "#ideas");
  assert(ar.isError, "an archived refinery is not researched");
});

Deno.test("promote_idea: one idea_promote() call with the server's owner and the document; refusals are tool errors", async () => {
  const ok = fake({ outcome: "promoted", document_path: "documents/x/a.md" });
  const r = await promoteIdea(ok.client, "owner-a", ID, " documents/x/a.md ");
  assert(!r.isError && /documents\/x\/a\.md/.test(r.text), r.text);
  eq(ok.log.filter((l) => /idea_promote\(/.test(l.sql))[0].args, [ID, "owner-a", "service:openbrain-mcp", "documents/x/a.md"]);
  eq(directWrites(ok.log).length, 0);
  assert((await promoteIdea(fake({ outcome: "no_document" }).client, "owner-a", ID, "documents/none.md")).isError);
  let err = "";
  try { await promoteIdea(fake({ outcome: "not_found" }).client, "owner-a", ID, "documents/x/a.md"); } catch (e) { err = (e as Error).message; }
  eq(err, `no idea with id ${ID}`);
});

Deno.test("the tools in index.ts call these functions - no idea write is left inline (source check)", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  for (const [tool, call] of [["update_idea", "updateIdea("], ["research_idea", "researchIdea("], ["promote_idea", "promoteIdea("]]) {
    const at = src.indexOf(`"${tool}",`);
    assert(at > 0, `${tool} is registered`);
    const next = src.indexOf("server.registerTool(", at);
    const body = src.slice(at, next < 0 ? undefined : next);
    assert(body.includes(call), `${tool} calls ${call}`);
    assert(!/UPDATE\s+ideas|INSERT INTO idea_revisions/.test(body), `${tool} writes ideas inline`);
  }
  // capture_idea and find_idea read and file ideas for the server's owner only
  const cap = src.slice(src.indexOf(`"capture_idea",`), src.indexOf(`"update_idea",`));
  assert(/owner_sub/.test(cap), "capture_idea files the idea under the owner and checks duplicates among the owner's ideas");
  const find = src.slice(src.indexOf(`"find_idea",`), src.indexOf(`"research_idea",`));
  assert(/owner_sub = \$/.test(find), "find_idea lists the owner's ideas only");
});
