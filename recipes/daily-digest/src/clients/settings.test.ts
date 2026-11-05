// rw-settings-store: the digest's and the podcast's reads of the run owner's settings. Nothing stored (or no
// store) = the env value, exactly as before; a stored value is what the NEXT run reads (read per run).
// rw-rest-door-auth: the read is rpc/rest_setting_get(p_key); the owner is the one the caller's TOKEN names (the
// database reads the verified claim), so no owner travels in the request body.
import { digestWindowFor, podcastTeamFor, SettingReader } from "./settings.ts";
import { AiNewsSection } from "../sections/ai-news.ts";
import { BrainClient } from "./postgrest.ts";

const eq = (a: unknown, b: unknown, m: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};

// a fake PostgREST: rpc/rest_setting_get answers from `store` (owner|key) for the owner the bearer token names
// (tok-<owner>); no token = 401, as the door; `down` = the function is not there (404)
function fake(store: Record<string, unknown>, down = false) {
  const calls: { owner: string; key: string; body: Record<string, unknown> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/rest/v1/rpc/rest_setting_get")) {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const m = /^Bearer tok-(.+)$/.exec(auth);
      if (!m) return new Response(JSON.stringify({ code: "PGRST302" }), { status: 401 });
      const b = JSON.parse(String(init?.body));
      calls.push({ owner: m[1], key: b.p_key, body: b });
      if (down) return new Response(JSON.stringify({ code: "PGRST202", message: "Could not find the function" }), { status: 404 });
      return Response.json(store[`${m[1]}|${b.p_key}`] ?? null);
    }
    return Response.json([]);
  }) as typeof fetch;
  return { f, calls };
}

Deno.test("no stored value, or no function yet, or no token: the env value (today's behaviour)", async () => {
  const none = fake({});
  eq(await digestWindowFor(new SettingReader("http://rest", none.f, "tok-operator"), "operator", 24), 24, "window");
  eq(await podcastTeamFor(new SettingReader("http://rest", none.f, "tok-operator"), "operator", "tech_experts"), "tech_experts", "team");
  eq(await podcastTeamFor(new SettingReader("http://rest", none.f, "tok-operator"), "operator", ""), "", "no team, no audio");
  const down = fake({}, true);
  eq(await digestWindowFor(new SettingReader("http://rest", down.f, "tok-operator"), "operator", 24), 24, "window, store down");
  eq(await podcastTeamFor(new SettingReader("http://rest", down.f, "tok-operator"), "operator", "tech_experts"), "tech_experts", "team, store down");
  const store = { "operator|digest.window_hours": 48 };
  eq(await digestWindowFor(new SettingReader("http://rest", fake(store).f, ""), "operator", 24), 24, "no token: refused at the door, env value");
});

Deno.test("a stored value is the token owner's, and what the next run reads", async () => {
  const store: Record<string, unknown> = { "alice|digest.window_hours": 48, "alice|podcast.team": "alice_team", "bob|digest.window_hours": 6 };
  const { f, calls } = fake(store);
  const ra = new SettingReader("http://rest", f, "tok-alice"), rb = new SettingReader("http://rest", f, "tok-bob");
  eq(await digestWindowFor(ra, "alice", 24), 48, "alice's window");
  eq(await digestWindowFor(rb, "bob", 24), 6, "bob's window");
  eq(await podcastTeamFor(rb, "bob", "tech_experts"), "tech_experts", "bob stored no team");
  eq(await podcastTeamFor(ra, "alice", "tech_experts"), "alice_team", "alice's team");
  eq(await digestWindowFor(ra, "bob", 24), 48, "naming another owner does not change whose value is read");
  eq(calls.every((c) => Object.keys(c.body).join() === "p_key"), true, "no owner travels in the request");
  store["alice|digest.window_hours"] = 72; // changed between runs
  eq(await digestWindowFor(ra, "alice", 24), 72, "the next run reads the new value");
  eq(await digestWindowFor(ra, "", 24), 24, "a run with no owner reads nothing");
});

Deno.test("the AI-news section reads its window on every produce() (the digest's next run)", async () => {
  const store: Record<string, unknown> = {};
  const { f } = fake(store);
  const r = new SettingReader("http://rest", f, "tok-operator");
  const asked: number[] = [];
  const brain = new (class extends BrainClient {
    override fetchRecentThoughts(o: { windowHours: number; limit: number }) {
      asked.push(o.windowHours);
      return Promise.resolve([]);
    }
  })({ baseUrl: "http://rest" });
  const s = new AiNewsSection(brain, { windowHours: () => digestWindowFor(r, "operator", 24), limit: 10 });
  await s.produce();
  store["operator|digest.window_hours"] = 36;
  await s.produce();
  delete store["operator|digest.window_hours"];
  await s.produce();
  eq(asked, [24, 36, 24], "env, stored, back to env");
});
