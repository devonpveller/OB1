// deno test src/rooms/chat_test.ts - the room's scoped chat, pure (rw-p8a3-room). Runs in the image's
// build test gate. The lab half (the real database, the stub gateway named llama-cpp, two users) is
// src/rooms/rooms_integration_test.ts.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  CHAT_OFF, CHAT_UNAVAILABLE, chatCall, chatConfigFromEnv, ChatRefused, chatRequest, contextBlock, MAX_ANSWER, parseChatAnswer,
} from "./chat.ts";
import { CONTEXT_SQL, contextFor, NOTHING_IN_SCOPE, refineryOf } from "./context.ts";
import { parseQuestion, parseScope, parseSubject, RoomError } from "./repo.ts";
import type { Db } from "../contracts/db.ts";

const env = (m: Record<string, string>) => (k: string) => m[k];
const ON = { WORKBENCH_CHAT_KEY: "sk-chat-own", WORKBENCH_CHAT_MODEL: "local-chat" };

Deno.test("R5 chat config: blank key or model = OFF (shipped inert), with the fixed refusal", () => {
  for (const m of [{}, { WORKBENCH_CHAT_MODEL: "m" }, { WORKBENCH_CHAT_KEY: "k" }, { WORKBENCH_CHAT_KEY: "  ", WORKBENCH_CHAT_MODEL: "m" }]) {
    const c = chatConfigFromEnv(env(m as Record<string, string>));
    assertEquals([c.state, c.code], ["off", "chat-off"], JSON.stringify(m));
    assertEquals(c.key, undefined);
  }
});

Deno.test("R5 chat config: on = the LiteLLM alias http://llama-cpp:8080/v1 by default", () => {
  const c = chatConfigFromEnv(env(ON));
  assertEquals([c.state, c.url, c.key, c.model], ["on", "http://llama-cpp:8080/v1", "sk-chat-own", "local-chat"]);
});

Deno.test("R5 chat config: any host but the gateway alias is refused - an upstream, an IP, another service, credentials", () => {
  for (const url of ["http://llama-cpp-upstream:8080/v1", "http://172.20.0.5:8080/v1", "http://llm-gateway:4000/v1", "http://litellm:4000",
    "http://u:p@llama-cpp:8080/v1", "file:///etc/passwd", "not a url", "http://llama-cpp.evil.example/v1"]) {
    const c = chatConfigFromEnv(env({ ...ON, WORKBENCH_CHAT_URL: url }));
    assertEquals([c.state, c.code], ["refused", "chat-misrouted"], url);
  }
});

Deno.test("R5 chat config: a key shared with another consumer the workbench holds is refused", () => {
  for (const n of ["EMBEDDING_API_KEY", "EXPORT_VISION_KEY", "WORKBENCH_KEY", "WORKSPACE_DOOR_KEY", "RESEARCH_SCORER_KEY", "RESEARCH_WORKSPACE_KEY", "WORKBENCH_GATE_KEY"]) {
    const c = chatConfigFromEnv(env({ ...ON, [n]: "sk-chat-own" }));
    assertEquals([c.state, c.code], ["refused", "chat-key-shared"], n);
    assert(!JSON.stringify(c).includes("sk-chat-own"), "the refusal names variables, never values");
  }
  const s = chatConfigFromEnv(env({ ...ON, WORKSPACE_SERVICE_KEYS: "owui=x,agent=sk-chat-own" }));
  assertEquals(s.code, "chat-key-shared");
});

Deno.test("R5 chat request: POST <alias>/chat/completions, the chat's own bearer, no redirect, the context in the system turn", () => {
  const cfg = chatConfigFromEnv(env(ON));
  const { url, init } = chatRequest(cfg, [{ role: "user", content: "earlier" }, { role: "assistant", content: "answer" }], "why?",
    [{ source_id: "s1", chunk: 0, held: false, title: "Title", text: "passage" }]);
  assertEquals(url, "http://llama-cpp:8080/v1/chat/completions");
  assertEquals(init.redirect, "manual");
  assertEquals((init.headers as Record<string, string>).authorization, "Bearer sk-chat-own");
  const b = JSON.parse(String(init.body));
  assertEquals(b.model, "local-chat");
  assertEquals(b.messages.map((m: { role: string }) => m.role), ["system", "user", "assistant", "user"]);
  assert(b.messages[0].content.includes("[1] Title\npassage"));
  assertEquals(b.messages[3].content, "why?");
});

Deno.test("R2 an empty context says so: no passage text reaches the model", () => {
  const t = contextBlock([]);
  assert(t.includes("none"), t);
  const { init } = chatRequest(chatConfigFromEnv(env(ON)), [], "q", []);
  assert(!JSON.parse(String(init.body)).messages[0].content.includes("\n[1] "), "no numbered passage");
});

Deno.test("R5 chat OFF: the fixed refusal, and no request is made", async () => {
  let calls = 0;
  const f = () => { calls++; return Promise.resolve(new Response("{}")); };
  const e = await assertRejects(() => chatCall(chatConfigFromEnv(env({})), [], "q", [], f), ChatRefused);
  assertEquals([e.status, e.code, e.message], [503, "chat-off", CHAT_OFF]);
  const r = await assertRejects(() => chatCall(chatConfigFromEnv(env({ ...ON, WORKBENCH_CHAT_URL: "http://llama-cpp-upstream:8080/v1" })), [], "q", [], f), ChatRefused);
  assertEquals([r.status, r.code], [503, "chat-misrouted"]);
  assertEquals(calls, 0);
});

Deno.test("R5 chat ON: a 500, a timeout or no text is the fixed chat-unavailable; the gateway's text never reaches the caller", async () => {
  const cfg = { ...chatConfigFromEnv(env(ON)), timeoutMs: 50 };
  const keep = [console.error, console.warn];
  console.error = () => {};
  console.warn = () => {};
  try {
    for (const f of [
      () => Promise.resolve(new Response(JSON.stringify({ error: "MARKER upstream /var/x" }), { status: 500 })),
      () => Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }))),
      () => Promise.resolve(new Response("not json MARKER")),
      (_u: string, i: RequestInit) => new Promise<Response>((_ok, no) => i.signal?.addEventListener("abort", () => no(new DOMException("t", "AbortError")))),
    ]) {
      const e = await assertRejects(() => chatCall(cfg, [], "q", [], f as never), ChatRefused);
      assertEquals([e.status, e.code, e.message], [502, "chat-unavailable", CHAT_UNAVAILABLE]);
      assert(!e.message.includes("MARKER"));
    }
  } finally {
    [console.error, console.warn] = keep;
  }
});

Deno.test("R5 chat ON: the answer is the model's text, control characters stripped and cut", async () => {
  const cfg = chatConfigFromEnv(env(ON));
  const out = await chatCall(cfg, [], "q", [], () => Promise.resolve(Response.json({ choices: [{ message: { content: " hi\u0007 there " } }] })));
  assertEquals(out, "hi there");
  assertEquals(parseChatAnswer({ choices: [{ message: { content: "x".repeat(MAX_ANSWER + 50) } }] })?.length, MAX_ANSWER);
});

const throwingDb: Db = {
  query: () => Promise.reject(new Error("the database was read")),
  tx: () => Promise.reject(new Error("the database was written")),
};

Deno.test("R2 an enabled-but-EMPTY source filter is no context: neither the embedder nor the database is asked", async () => {
  assert(NOTHING_IN_SCOPE({ enabled: true, sources: [] }));
  assert(!NOTHING_IN_SCOPE({ enabled: false, sources: [] }), "scope off is the whole knowledge database");
  const out = await contextFor(throwingDb, () => Promise.reject(new Error("embedded")), "q", { enabled: true, sources: [] }, "a1000000-0000-4000-8000-000000000001");
  assertEquals(out, []);
});

Deno.test("R4 the refinery's hidden set applies to an idea's room only; it hides sources, keeps the rest", () => {
  assertEquals(refineryOf({ subject_kind: "idea", subject_id: "i" }), "i");
  assertEquals(refineryOf({ subject_kind: "session", subject_id: "s" }), null);
  assert(/refinery_hidden x\s+WHERE x\.refinery_id = \$4::uuid AND x\.node_kind = 'source'/.test(CONTEXT_SQL), CONTEXT_SQL);
  assert(CONTEXT_SQL.includes("s.retraction_committed_at IS NULL"), "a suppressed source lends no context");
  assert(CONTEXT_SQL.includes("NOT $2::boolean OR c.source_id = ANY($3::uuid[])"), "scope off reads the whole knowledge database");
});

Deno.test("room input: subject, scope and question are validated", () => {
  assertEquals(parseSubject({ subject_kind: "idea", subject_id: "A1000000-0000-4000-8000-000000000001" }).id, "a1000000-0000-4000-8000-000000000001");
  for (const b of [{}, { subject_kind: "page", subject_id: "a1000000-0000-4000-8000-000000000001" }, { subject_kind: "idea", subject_id: "x" }]) {
    let e: unknown;
    try { parseSubject(b); } catch (x) { e = x; }
    assert(e instanceof RoomError && e.status === 400, JSON.stringify(b));
  }
  assertEquals(parseScope({ enabled: true, sources: [] }), { enabled: true, sources: [] });
  assertEquals(parseScope({ enabled: false }), { enabled: false, sources: [] });
  for (const b of [{}, { enabled: "yes" }, { enabled: true, sources: ["x"] }, { enabled: true, sources: "a" }]) {
    let e: unknown;
    try { parseScope(b as Record<string, unknown>); } catch (x) { e = x; }
    assert(e instanceof RoomError && e.status === 400, JSON.stringify(b));
  }
  assertEquals(parseQuestion({ text: "  why?  " }), "why?");
  let e: unknown;
  try { parseQuestion({ text: "   " }); } catch (x) { e = x; }
  assert(e instanceof RoomError);
});

Deno.test("R3 the room never reads from or posts to Mattermost: no room module names it as a call", async () => {
  for (const f of ["chat.ts", "context.ts", "repo.ts", "../routes/rooms.ts"]) {
    const src = (await Deno.readTextFile(new URL(f, import.meta.url))).split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join("\n");
    assert(!/mattermost|MM_|\/api\/v4\//i.test(src), `${f} carries a Mattermost call`);
  }
});
