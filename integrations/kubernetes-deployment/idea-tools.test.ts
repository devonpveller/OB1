// idea-tools.test.ts - the Idea Refinery MCP tools' owner check (rw-p8a4-ideas), over a recording fake client.
//   deno test idea-tools.test.ts        (no network, no database; the SQL functions themselves are proven in the
//                                        workbench's P2b lab: src/ideas/ideas_integration_test.ts I4)
// Pinned: every write is ONE call of the owner-checked SQL function, the owner is this server's configured subject
// (never a tool argument), nothing writes `ideas` / `idea_revisions` directly, and another owner's idea (the
// function's not_found) fails the tool and leaves no thought behind.
import { captureIdea, promoteIdea, researchIdea, updateIdea, type IdeaClient } from "./idea-tools.ts";

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
      if (/SELECT current_revision/.test(sql)) return Promise.resolve({ rows: [{ r: 2 }] as unknown as T[] });
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
const EDIT = { idea_id: ID, idea: " refined ", embedding: "[0.1]" };
const directWrites = (log: { sql: string }[]) => log.filter((l) => /(INSERT INTO|UPDATE)\s+(public\.)?(ideas|idea_revisions)\b/.test(l.sql));

Deno.test("the owner is passed in, never read from the environment here (rw-mcp-identity: the request's subject)", async () => {
  const src = await Deno.readTextFile(new URL("./idea-tools.ts", import.meta.url));
  assert(!/Deno\.env/.test(src), "idea-tools.ts reads the environment");
  assert(!/export function ideaOwner/.test(src), "ideaOwner (the env default) is back");
});

Deno.test("update_idea: one idea_edit() call with the server's owner and NO corpus thought (ideas are user isolated); no direct write", async () => {
  const { client, log } = fake({ outcome: "changed", revision: 3, title: "T" });
  const r = await updateIdea(client, "owner-a", EDIT);
  assert(!r.isError && /revision 3/.test(r.text) && /room/.test(r.text), r.text);
  assert(!/mattermost|#ideas/i.test(r.text), "rw-idea-privacy: findings go to the room, never a shared channel");
  const calls = log.filter((l) => /idea_edit\(/.test(l.sql));
  eq(calls.length, 1, "one function call");
  eq(calls[0].args.slice(0, 4), [ID, "owner-a", "service:openbrain-mcp", "refined"], "owner, actor, text");
  assert(/\$6, NULL\)/.test(calls[0].sql), "no thought passed: the revision is private");
  eq(log.filter((l) => /thoughts/.test(l.sql)).length, 0, "nothing touches the shared thought corpus");
  eq(directWrites(log).length, 0, "no direct write of ideas / idea_revisions");
});

Deno.test("update_idea on ANOTHER owner's idea: the function says not_found and the tool fails; identical text and archived say so", async () => {
  let err = "";
  try { await updateIdea(fake({ outcome: "not_found" }).client, "owner-a", EDIT); } catch (e) { err = (e as Error).message; }
  eq(err, `no idea with id ${ID}`);
  eq(!!(await updateIdea(fake({ outcome: "unchanged" }).client, "owner-a", EDIT)).isError, false, "unchanged");
  eq(!!(await updateIdea(fake({ outcome: "archived" }).client, "owner-a", EDIT)).isError, true, "archived");
});

Deno.test("capture_idea: one idea_capture() call with the server's owner - no thought, no direct write", async () => {
  const { client, log } = fake({});
  (client as unknown as { queryObject: unknown }).queryObject = <T>(sql: string, args: unknown[] = []) => {
    log.push({ sql, args });
    return Promise.resolve({ rows: [{ id: "new-idea" }] as unknown as T[] });
  };
  eq(await captureIdea(client, "owner-a", { title: "T", idea: "an idea", domain: null, embedding: "[0.1]" }), "new-idea");
  eq(log.length, 1);
  assert(/public\.idea_capture\(/.test(log[0].sql));
  eq(log[0].args.slice(0, 4), ["owner-a", "service:openbrain-mcp", "T", "an idea"]);
});

Deno.test("research_idea: one idea_research() call with the server's owner; another owner's idea fails; no flag write", async () => {
  const ok = fake({ outcome: "queued", job_id: "job-1" });
  const r = await researchIdea(ok.client, "owner-a", ID);
  assert(/job-1/.test(r.text), r.text);
  assert(/room/.test(r.text) && !/mattermost|#ideas/i.test(r.text), r.text);
  eq(ok.log.filter((l) => /idea_research\(/.test(l.sql))[0].args, [ID, "owner-a", "service:openbrain-mcp"]);
  eq(directWrites(ok.log).length, 0, "the old metadata.research_now flag write is gone");
  const no = fake({ outcome: "not_found" });
  let err = "";
  try { await researchIdea(no.client, "owner-a", ID); } catch (e) { err = (e as Error).message; }
  eq(err, `no idea with id ${ID}`);
  const ar = await researchIdea(fake({ outcome: "archived" }).client, "owner-a", ID);
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
  assert(/owner_sub/.test(cap), "capture_idea checks duplicates among the owner's ideas");
  assert(/captureIdea\(/.test(cap), "capture_idea writes through idea_capture()");
  // operator 2026-11-02: no idea tool writes the shared thought corpus
  for (const tool of ["capture_idea", "update_idea"]) {
    const at = src.indexOf(`"${tool}",`);
    const body = src.slice(at, src.indexOf("server.registerTool(", at));
    assert(!/INSERT INTO thoughts|INSERT INTO idea_revisions|INSERT INTO ideas/.test(body), `${tool} writes a thought, revision or idea inline`);
  }
  const find = src.slice(src.indexOf(`"find_idea",`), src.indexOf(`"research_idea",`));
  assert(/owner_sub = \$/.test(find), "find_idea lists the owner's ideas only");
});

Deno.test("rw-idea-privacy: no idea tool tells the user findings go to Mattermost (they go to the idea's room)", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const tools = src.slice(src.indexOf('"capture_idea"'), src.indexOf('"promote_idea"'));
  assert(tools.length > 0 && !/Mattermost|#ideas|IDEA_CHANNEL/.test(tools.replace(/\/\/.*$/gm, "")), "an idea tool still names Mattermost");
});
