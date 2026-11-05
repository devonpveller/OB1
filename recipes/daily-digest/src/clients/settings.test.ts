// rw-settings-store: the digest's and the podcast's reads of the run owner's settings. Nothing stored (or no
// store) = the env value, exactly as before; a stored value is what the NEXT run reads (read per run).
import { digestWindowFor, podcastTeamFor, SettingReader } from "./settings.ts";
import { AiNewsSection } from "../sections/ai-news.ts";
import { BrainClient } from "./postgrest.ts";

const eq = (a: unknown, b: unknown, m: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};

// a fake PostgREST: rpc/setting_get answers from `store` (owner|key); `down` = the function is not there (404)
function fake(store: Record<string, unknown>, down = false) {
  const calls: { owner: string; key: string }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/rest/v1/rpc/setting_get")) {
      const b = JSON.parse(String(init?.body));
      calls.push({ owner: b.p_owner, key: b.p_key });
      if (down) return new Response(JSON.stringify({ code: "PGRST202", message: "Could not find the function" }), { status: 404 });
      return Response.json(store[`${b.p_owner}|${b.p_key}`] ?? null);
    }
    return Response.json([]);
  }) as typeof fetch;
  return { f, calls };
}

Deno.test("no stored value, or no setting_get yet: the env value (today's behaviour)", async () => {
  const none = fake({});
  eq(await digestWindowFor(new SettingReader("http://rest", none.f), "operator", 24), 24, "window");
  eq(await podcastTeamFor(new SettingReader("http://rest", none.f), "operator", "tech_experts"), "tech_experts", "team");
  eq(await podcastTeamFor(new SettingReader("http://rest", none.f), "operator", ""), "", "no team, no audio");
  const down = fake({}, true);
  eq(await digestWindowFor(new SettingReader("http://rest", down.f), "operator", 24), 24, "window, store down");
  eq(await podcastTeamFor(new SettingReader("http://rest", down.f), "operator", "tech_experts"), "tech_experts", "team, store down");
});

Deno.test("a stored value is the owner's, and what the next run reads", async () => {
  const store: Record<string, unknown> = { "alice|digest.window_hours": 48, "alice|podcast.team": "alice_team", "bob|digest.window_hours": 6 };
  const { f, calls } = fake(store);
  const r = new SettingReader("http://rest", f);
  eq(await digestWindowFor(r, "alice", 24), 48, "alice's window");
  eq(await digestWindowFor(r, "bob", 24), 6, "bob's window");
  eq(await podcastTeamFor(r, "bob", "tech_experts"), "tech_experts", "bob stored no team");
  eq(await podcastTeamFor(r, "alice", "tech_experts"), "alice_team", "alice's team");
  eq(calls.every((c) => c.owner === "alice" || c.owner === "bob"), true, "only the run owner is asked");
  store["alice|digest.window_hours"] = 72; // changed between runs
  eq(await digestWindowFor(r, "alice", 24), 72, "the next run reads the new value");
});

Deno.test("the AI-news section reads its window on every produce() (the digest's next run)", async () => {
  const store: Record<string, unknown> = {};
  const { f } = fake(store);
  const r = new SettingReader("http://rest", f);
  const asked: number[] = [];
  const brain = new (class extends BrainClient {
    override fetchRecentThoughts(o: { windowHours: number; limit: number }) {
      asked.push(o.windowHours);
      return Promise.resolve([]);
    }
  })({ baseUrl: "http://rest", owner: () => Promise.resolve("sub-a") });
  const s = new AiNewsSection(brain, { windowHours: () => digestWindowFor(r, "operator", 24), limit: 10 });
  await s.produce();
  store["operator|digest.window_hours"] = 36;
  await s.produce();
  delete store["operator|digest.window_hours"];
  await s.produce();
  eq(asked, [24, 36, 24], "env, stored, back to env");
});
