// settings-probe.ts - rw-settings-store lab probe (run-workspace-tests.ps1 [5l]). Over the lab's REAL PostgREST
// (the OB1 rest Caddy) and workbench: the digest's AI-news window and the podcast's team are read through the
// exact functions the services call (digestWindowFor in src/app.ts, podcastTeamFor in link-enrich.ts), per run,
// for the run owner. Nothing stored = the env value; a value stored through the Settings route = what the NEXT
// run reads; another user's value never moves this owner's. Lab only - never point it at a live stack.
//   deno run --no-config --allow-net --allow-env settings-probe.ts
// Environment: PROBE_REST (http://openbrain-rest), PROBE_WB (the workbench), PROBE_KEY (its door key),
//   PROBE_OWNER / PROBE_OTHER (two subjects, sent as X-Test-Sub), PROBE_TEAM (a podcast team of PROBE_OWNER's).
// rw-rest-door-auth: PROBE_TOKEN_OWNER / PROBE_TOKEN_OTHER - each one's REST token (the digest role, sub = that
//   subject): the door reads a setting for the owner the TOKEN names. OPEN_BRAIN_REST_TOKEN: the token the
//   BrainClient / PresenterStore send (as the services read it from their env).
import { digestWindowFor, podcastTeamFor, SettingReader } from "../src/clients/settings.ts";
import { AiNewsSection } from "../src/sections/ai-news.ts";
import { BrainClient } from "../src/clients/postgrest.ts";
import { PresenterStore } from "../src/podcast/presenter-store.ts";

const env = (k: string) => (Deno.env.get(k) ?? "").trim();
const REST = env("PROBE_REST"), WB = env("PROBE_WB").replace(/\/+$/, ""), KEY = env("PROBE_KEY");
const OWNER = env("PROBE_OWNER"), OTHER = env("PROBE_OTHER"), TEAM = env("PROBE_TEAM");
const TOKEN_OWNER = env("PROBE_TOKEN_OWNER"), TOKEN_OTHER = env("PROBE_TOKEN_OTHER");
// round 2 (T3): each service reads only its own keys - the podcast's team through the PODCAST role's token
const POD_OWNER = env("PROBE_PODCAST_TOKEN_OWNER"), POD_OTHER = env("PROBE_PODCAST_TOKEN_OTHER");
let fails = 0;
const check = (ok: boolean, m: string) => {
  console.log(`${ok ? "PROBE PASS" : "PROBE FAIL"}  ${m}`);
  if (!ok) fails++;
};
const route = async (method: string, key: string, who: string, value?: unknown) => {
  const r = await fetch(`${WB}/workbench/settings/${key}`, {
    method, headers: { "x-brain-key": KEY, "content-type": "application/json", "X-Test-Sub": who },
    body: value === undefined ? undefined : JSON.stringify({ value }),
  });
  await r.body?.cancel();
  return r.status;
};

const reader = new SettingReader(REST, undefined, TOKEN_OWNER || undefined);
const readerOther = new SettingReader(REST, undefined, TOKEN_OTHER || undefined);
const podReader = new SettingReader(REST, undefined, POD_OWNER || undefined);
const podReaderOther = new SettingReader(REST, undefined, POD_OTHER || undefined);
const asked: number[] = [];
const brain = new (class extends BrainClient {
  override fetchRecentThoughts(o: { windowHours: number; limit: number; excludeTypes?: string[] }) {
    asked.push(o.windowHours);
    return super.fetchRecentThoughts(o); // the real PostgREST query, with the window the run read
  }
})({ baseUrl: REST });
// the digest's section as src/app.ts builds it (DIGEST_WINDOW_HOURS = 24 here)
const news = new AiNewsSection(brain, { windowHours: () => digestWindowFor(reader, OWNER, 24), limit: 5 });

// 1. nothing stored: today's values
await news.produce();
check(asked.at(-1) === 24, `no stored value: the digest's window is DIGEST_WINDOW_HOURS (asked ${asked.at(-1)})`);
check(await podcastTeamFor(podReader, OWNER, "env_team") === "env_team", "no stored value: the podcast's team is PODCAST_TEAM");
// 2. stored through the Settings route (as the owner), then the NEXT run
check(await route("PUT", "digest.window_hours", OWNER, 48) === 200, "the owner stores digest.window_hours = 48");
check(await route("PUT", "podcast.team", OWNER, TEAM) === 200, `the owner stores podcast.team = their team`);
check(await route("PUT", "digest.window_hours", OTHER, 6) === 200, "another user stores their own window (6)");
await news.produce();
check(asked.at(-1) === 48, `the next digest reads the stored window (asked ${asked.at(-1)})`);
const team = await podcastTeamFor(podReader, OWNER, "env_team");
check(team === TEAM, `the next episode reads the stored team (${team})`);
const resolved = await new PresenterStore(REST).team(OWNER, team);
check(resolved?.id === TEAM, "and that team resolves in the presenter model, as link-enrich then loads it");
check(await digestWindowFor(readerOther, OTHER, 24) === 6 && await podcastTeamFor(podReaderOther, OTHER, "env_team") === "env_team", "the other user reads only their own");
check(await digestWindowFor(readerOther, OWNER, 24) === 6, "naming the owner does not give the other user's token the owner's value");
check(await podcastTeamFor(reader, OWNER, "env_team") === "env_team", "the digest's token cannot read the podcast's key (its own keys only)");
// 3. back to the default
check(await route("DELETE", "digest.window_hours", OWNER) === 200 && await route("DELETE", "podcast.team", OWNER) === 200 && await route("DELETE", "digest.window_hours", OTHER) === 200, "both back to the default");
await news.produce();
check(asked.at(-1) === 24, `after DELETE the next digest reads DIGEST_WINDOW_HOURS again (asked ${asked.at(-1)})`);
check(await podcastTeamFor(podReader, OWNER, "env_team") === "env_team", "after DELETE the next episode reads PODCAST_TEAM again");
console.log(`PROBE ${fails ? "FAILED" : "OK"} (${fails} failed)`);
Deno.exit(fails ? 1 : 0);
