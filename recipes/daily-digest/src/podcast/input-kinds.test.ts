// rwr-episode-from: the render request's input kinds are a REGISTRY. The renderer (render-service.ts) never names a
// kind; a new kind needs one registry entry and nothing else. No network (guardNetwork); a stub script writer.
//
// Run: deno test --allow-read --allow-write --allow-env --allow-run --allow-net=127.0.0.1 src/podcast/input-kinds.test.ts
import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { guardNetwork } from "../routine/testing.ts";
import { INPUT_KINDS, type InputKind, InputKindRegistry, scriptFromMaterial, SOURCE_KINDS } from "./input-kinds.ts";
import { RenderService } from "./render-service.ts";
import type { Team } from "./presenters.ts";

guardNetwork();

const TEAM: Team = {
  id: "t1", name: "fixture", description: "",
  presenters: [
    { id: "pa", name: "Alex", personality: "", backstory: "", language: "en-US", voice: { id: "va", route: "local-tts", voice: "bm_george", speed: 1 } },
    { id: "pb", name: "Jamie", personality: "", backstory: "", language: "en-US", voice: { id: "vb", route: "local-tts", voice: "bf_emma", speed: 1 } },
  ],
};

const MARKER = "ZQX-PRIVATE-MARKER-4417";
const SCRIPT = "HOST A: Today we talk about the thing.\nHOST B: Yes, the thing matters.";

function chatStub() {
  const calls: { system: string; user: string }[] = [];
  const fn = (system: string, user: string) => {
    calls.push({ system, user });
    return Promise.resolve(SCRIPT);
  };
  return { fn, calls };
}

const src = (kind: string, extra: Record<string, unknown> = {}) => ({
  source: { kind, id: "x1", title: "A title", text: `body ${MARKER}`, items: [{ type: kind, id: "x1", label: "A title", marker: "private" }], ...extra },
});

Deno.test("registry: the five new kinds, the legacy transcript and discussion are registered; discussion is not available", () => {
  for (const k of ["transcript", "run", "report", "document", "idea", "topic", "discussion"]) assert(INPUT_KINDS.get(k), `${k} registered`);
  assertEquals(INPUT_KINDS.get("discussion")!.available, false);
  for (const k of ["transcript", "run", "report", "document", "idea", "topic"]) assertEquals(INPUT_KINDS.get(k)!.available, true, k);
  assertEquals([...SOURCE_KINDS].sort(), ["document", "idea", "report", "run", "topic"]);
  // personal data starts private: run, report, document and idea are personal; a topic (shared knowledge) is not
  for (const k of ["run", "report", "document", "idea"]) assertEquals(INPUT_KINDS.get(k)!.personal, true, `${k} personal`);
  assertEquals(INPUT_KINDS.get("topic")!.personal, false);
});

Deno.test("scriptFromMaterial: the writer is the gateway chat function it is handed; the script becomes the team's turns", async () => {
  const chat = chatStub();
  const t = await scriptFromMaterial({ kind: "idea", title: "T", text: "some text" }, TEAM, chat.fn, "an idea of the listener's own");
  assertEquals(t.turns.map((x) => x.presenterId), ["pa", "pb"]);
  assertEquals(chat.calls.length, 1);
  assertStringIncludes(chat.calls[0].system, "an idea of the listener's own");
  assertStringIncludes(chat.calls[0].system, "HOST A is Alex");
  assertStringIncludes(chat.calls[0].user, "some text");
});

Deno.test("scriptFromMaterial: a writer that returns nothing is a refusal, never a raw dump of the material", async () => {
  const material = { kind: "idea", title: "T", text: `secret ${MARKER}` };
  await assertRejects(() => scriptFromMaterial(material, TEAM, () => Promise.resolve(null), "x"), Error, "script");
  try {
    await scriptFromMaterial(material, TEAM, () => Promise.resolve(null), "x");
  } catch (e) {
    assert(!String(e).includes(MARKER), "the error carries no material");
  }
});

// A RenderService over fakes: counts what it was asked to voice.
function service(registry: InputKindRegistry, rows: Record<string, Record<string, unknown>>, voiced: { title: string; turns: number }[], logs: string[]) {
  const patches: Record<string, unknown>[] = [];
  const store = {
    request: (id: string) => Promise.resolve(rows[id] ?? null),
    updateRequest: (_id: string, p: Record<string, unknown>) => {
      patches.push(p);
      return Promise.resolve();
    },
    team: () => Promise.resolve(TEAM),
  };
  const svc = new RenderService({
    // deno-lint-ignore no-explicit-any
    store: store as any, cache: {} as never, archive: {} as never,
    destination: (() => Promise.resolve({ path: "/x" })) as never, ffmpeg: { bin: "ffmpeg" }, concurrency: 1, restBase: "http://127.0.0.1:1",
    kinds: registry, chat: chatStub().fn, log: (m) => logs.push(m),
    voice: (t, _team, req) => {
      voiced.push({ title: t.title, turns: t.turns.length });
      logs.push(`voice ${req.private ? "private" : "open"}`);
      return Promise.resolve({ episodeRowId: "ep-1" } as never);
    },
  });
  return { svc, patches };
}

const UUID1 = "11111111-1111-4111-8111-111111111111";
const row = (input: unknown) => ({ id: UUID1, state: "queued", requester_sub: "user-a", team_id: "t1", title: "Chosen title", input });
const settle = () => new Promise((ok) => setTimeout(ok, 50));

Deno.test("a NEW kind needs only a registry entry: the render service renders it without any change", async () => {
  const reg = new InputKindRegistry();
  const mine: InputKind = {
    id: "habit", label: "a habit", personal: true, available: true,
    toTranscript: (input, ctx) => scriptFromMaterial({ kind: "habit", title: input.title, text: input.text }, ctx.team, ctx.chat, "a habit"),
  };
  reg.register(mine);
  const voiced: { title: string; turns: number }[] = [];
  const { svc, patches } = service(reg, { [UUID1]: row({ source: { kind: "habit", id: "h", title: "Run daily", text: "run daily", items: [] } }) }, voiced, []);
  const r = await svc.render({ request_id: UUID1 });
  assertEquals(r.status, 202);
  await settle();
  assertEquals(voiced, [{ title: "Run daily", turns: 2 }]);
  assert(patches.some((p) => p.state === "done"));
});

Deno.test("the render service source has no per-kind branch (the registry is the only place a kind is named)", async () => {
  const text = await Deno.readTextFile(new URL("./render-service.ts", import.meta.url));
  for (const k of ["idea", "document", "report", "topic", "discussion", "run"]) {
    assert(!new RegExp(`['"\`]${k}['"\`]`).test(text), `render-service.ts names the kind "${k}"`);
  }
  assert(!/switch\s*\(\s*[\w.]*kind/i.test(text) && !/kind\s*===/.test(text), "no switch or equality test on a kind");
});

Deno.test("an unregistered kind, and the discussion kind, are refused (the request fails; nothing is voiced)", async () => {
  for (const kind of ["nonsense", "discussion"]) {
    const voiced: { title: string; turns: number }[] = [];
    const { svc, patches } = service(INPUT_KINDS, { [UUID1]: row(src(kind)) }, voiced, []);
    await svc.render({ request_id: UUID1 });
    await settle();
    assertEquals(voiced.length, 0, kind);
    assert(patches.some((p) => p.state === "failed"), `${kind} fails`);
  }
});

Deno.test("each source kind renders from a fixture; a personal one is voiced as private and its text is in no log line or row patch", async () => {
  for (const kind of SOURCE_KINDS) {
    const voiced: { title: string; turns: number }[] = [];
    const logs: string[] = [];
    const { svc, patches } = service(INPUT_KINDS, { [UUID1]: row(src(kind)) }, voiced, logs);
    const r = await svc.render({ request_id: UUID1 });
    assertEquals(r.status, 202, kind);
    await settle();
    assertEquals(voiced.length, 1, `${kind} voiced`);
    assertEquals(voiced[0].turns, 2);
    assert(patches.some((p) => p.state === "done" && p.episode_id === "ep-1"), `${kind} done`);
    const all = logs.join("\n") + JSON.stringify(patches);
    assert(!all.includes(MARKER), `${kind}: the material text is in no log line or row patch`);
    if (INPUT_KINDS.get(kind)!.personal) assertStringIncludes(logs.join("\n"), "voice private");
  }
});

Deno.test("a failure on a personal kind records a class, not text", async () => {
  const reg = new InputKindRegistry();
  reg.register({ id: "idea", label: "idea", personal: true, available: true, toTranscript: () => Promise.reject(new Error(`boom ${MARKER}`)) });
  const logs: string[] = [];
  const { svc, patches } = service(reg, { [UUID1]: row(src("idea")) }, [], logs);
  await svc.render({ request_id: UUID1 });
  await settle();
  const failed = patches.find((p) => p.state === "failed")!;
  assert(failed, "failed");
  assert(!JSON.stringify(failed).includes(MARKER) && !logs.join("\n").includes(MARKER), "no marker in the row or the log");
});

Deno.test("a legacy room transcript request still renders exactly as before (kind transcript)", async () => {
  const voiced: { title: string; turns: number }[] = [];
  const { svc } = service(INPUT_KINDS, { [UUID1]: row({ transcript: { title: "Room", turns: [{ presenterId: "pa", text: "hello" }] } }) }, voiced, []);
  await svc.render({ request_id: UUID1 });
  await settle();
  assertEquals(voiced, [{ title: "Room", turns: 1 }]);
});

Deno.test("the gateway chat for material never logs an upstream error body (it can echo the private prompt)", async () => {
  const { makeScriptChat } = await import("./script-renderer.ts");
  const srv = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const sent = await req.text();
    return new Response(`context error: ${sent}`, { status: 400 }); // an upstream that echoes its input
  });
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.join(" ")); };
  try {
    for (const withhold of [true, false]) {
      warned.length = 0;
      const chat = makeScriptChat({
        chatApiBase: `http://127.0.0.1:${srv.addr.port}/v1`, chatModel: "local-large", apiKey: "sk-test", attempts: 1, retryDelayMs: 0,
        withholdBody: withhold,
      });
      assertEquals(await chat("sys", `user text ${MARKER}`), null);
      assertEquals(warned.join("\n").includes(MARKER), !withhold, withhold ? "withheld: no marker in the log" : "default keeps its old log (control)");
    }
  } finally {
    console.warn = realWarn;
    await srv.shutdown();
  }
});

Deno.test("voiceAndArchive: a private episode's title is in no log line (the line is written before ffmpeg runs)", async () => {
  const { voiceAndArchive } = await import("./episode-audio.ts");
  const { SegmentCache } = await import("./segment-cache.ts");
  const dir = await Deno.makeTempDir({ prefix: "epf-log-" });
  try {
    for (const priv of [true, false]) {
      const logs: string[] = [];
      try {
        await voiceAndArchive({ title: `Title ${MARKER}`, turns: [{ presenterId: "pa", text: "hello there" }] }, TEAM,
          { ownerSub: "user-a", shared: false, slug: "episode", private: priv },
          {
            cache: new SegmentCache(dir, () => Promise.resolve(new Uint8Array(4800))), concurrency: 1, ffmpeg: { bin: "ffmpeg-not-here" },
            archive: { destination: () => Promise.resolve({ path: dir, value: {}, version: 1, via: "t" }) } as never, store: null, log: (m) => logs.push(m),
          });
      } catch { /* no ffmpeg here: the line under test is written before it is asked for */ }
      assert(logs.length >= 1, "the render line was logged");
      assertEquals(logs.join("\n").includes(MARKER), !priv, priv ? "private: no title in the log" : "control: an ordinary episode logs its title as it always did");
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
