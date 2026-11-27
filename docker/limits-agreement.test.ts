// deno test --allow-read OB1/docker/limits-agreement.test.ts - rwr-settings-defaults: the admin research limits are written in four places that
// must agree: the compose file (what openbrain-research and the curator really run on when nothing is stored), slot 400's registry defaults plus
// slot 730's overrides (what the Settings page shows as "in force", what the user ceiling is, what the preset "Standard" writes), slot 730's fixed
// ranges, and the SPEC of the two services' limits.ts (which ignore a stored value outside its range). Drift between any two turns this red.
// It lives beside the compose file, outside every image build context, and runs on the host (the lab runner calls it).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { SPEC as RESEARCH } from "../integrations/research-service/limits.ts";
import { SPEC as CURATOR } from "../integrations/research-curator/limits.ts";

const here = new URL(".", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, here)).replace(/\r\n/g, "\n");
const compose = read("docker-compose.yml");
const s400 = read("init-settings.sql");
const s730 = read("init-settings-defaults.sql");
const harness = read("../integrations/research-service/harness.ts");

const LIMIT_KEYS = [
  "research.max_fetch", "research.max_fetch_timeouts", "research.max_rounds", "research.relevant_target", "research.max_wall_ms", "research.search_k",
  "research.confidence_floor", "research.reuse_max_distance", "research.kb_sources_k",
  "curator.shortlist_k", "curator.new_thread_min_confidence", "curator.merge_floor_distance", "curator.conflict_distance",
];

// a service block of the compose file: from "  name:" to the next two-space key
function block(name: string): string {
  const i = compose.search(new RegExp(`^  ${name}:\\s*$`, "m"));
  assert(i >= 0, `service ${name} in the compose file`);
  const rest = compose.slice(i + 1);
  const j = rest.search(/\n  [a-z][a-z0-9_-]*:\s*\n/);
  return j < 0 ? rest : rest.slice(0, j);
}
const composeDefault = (svc: string, env: string): string | null =>
  new RegExp(`^\\s+${env}:\\s*\\$\\{[A-Z0-9_]+:-([^}]*)\\}`, "m").exec(block(svc))?.[1] ?? null;

// slot 400: key -> { default, env }
const reg400 = new Map<string, { def: number; env: string }>();
for (const m of s400.matchAll(/\('((?:research|curator)\.[a-z_]+)', 'admin',[\s\S]*?\n\s+'([0-9.]+)', '([A-Z_]+)',/g)) reg400.set(m[1], { def: Number(m[2]), env: m[3] });

// slot 730: the default overrides, the ranges, the presets
const overrides = new Map<string, number>();
const dflt = /AS d \(key, v\)/.exec(s730) ? s730.slice(s730.indexOf("UPDATE public.settings_keys k SET default_value")) : "";
for (const m of dflt.slice(0, dflt.indexOf(";")).matchAll(/\('([a-z_.]+)', '([0-9.]+)'\)/g)) overrides.set(m[1], Number(m[2]));
const ranges = new Map<string, [number, number]>();
for (const m of s730.matchAll(/\('((?:research|curator)\.[a-z_]+)',\s+'\{"min":([0-9.]+),"max":([0-9.]+)\}'\)/g)) ranges.set(m[1], [Number(m[2]), Number(m[3])]);
const presets: { grp: string; preset: string; key: string; v: number }[] = [];
for (const m of s730.matchAll(/\('([a-z_]+)', '([a-z_]+)',\s+'((?:research|curator)\.[a-z_]+)', '([0-9.]+)'\)/g)) presets.push({ grp: m[1], preset: m[2], key: m[3], v: Number(m[4]) });

const effective = (key: string) => overrides.get(key) ?? reg400.get(key)!.def;
const svcOf = (key: string) => (key.startsWith("curator.") ? "openbrain-curator" : "openbrain-research");

Deno.test("the parsers found every key (a silent empty parse would pass everything below)", () => {
  assertEquals([...reg400.keys()].sort(), [...LIMIT_KEYS].sort());
  assertEquals([...ranges.keys()].sort(), [...LIMIT_KEYS].sort());
  assertEquals(presets.length, 7 * 3 + 2 * 3 + 4 * 3);
  assertEquals([...overrides.keys()].sort(), ["research.max_fetch", "research.max_fetch_timeouts", "research.max_wall_ms"]);
});

Deno.test("what the page calls in force with nothing stored (registry default, slot 730's override) is what the service runs on (the compose default)", () => {
  for (const key of LIMIT_KEYS) {
    const env = reg400.get(key)!.env;
    const fromCompose = composeDefault(svcOf(key), env);
    const code = new RegExp(`env\\("${env}", "([0-9.]+)"\\)`).exec(harness)?.[1] ?? null; // a key the compose file does not set runs on harness.ts's default
    const runs = Number(fromCompose ?? code);
    assert(Number.isFinite(runs), `${key}: neither the compose file nor harness.ts says what ${env} defaults to`);
    assertEquals(effective(key), runs, `${key}: the registry says ${effective(key)}, the deployed service runs on ${runs} (${env})`);
  }
});

Deno.test("slot 730's ranges equal both services' SPEC, and contain the deployed default and every preset value", () => {
  const spec = new Map<string, [number, number]>();
  for (const s of [...Object.values(RESEARCH), ...Object.values(CURATOR)]) spec.set(s.key, [s.min, s.max]);
  for (const key of LIMIT_KEYS) {
    assertEquals(ranges.get(key), spec.get(key), `${key}: SQL range vs limits.ts SPEC`);
    const [lo, hi] = ranges.get(key)!;
    assert(effective(key) >= lo && effective(key) <= hi, `${key}: the deployed default ${effective(key)} is outside ${lo}..${hi}`);
  }
  for (const p of presets) {
    const [lo, hi] = ranges.get(p.key)!;
    assert(p.v >= lo && p.v <= hi, `${p.grp}/${p.preset}/${p.key}=${p.v} is outside ${lo}..${hi}`);
  }
});

Deno.test("the preset called Standard writes exactly the deployed defaults, so choosing it changes nothing and no preset cuts today's runs by name", () => {
  for (const p of presets.filter((x) => x.preset === "standard")) assertEquals(p.v, effective(p.key), `${p.grp}/standard/${p.key}`);
  assertEquals(presets.filter((x) => x.preset === "standard").length, LIMIT_KEYS.length);
  // and the compose default is reachable as a user ceiling: ask_over_fetch's validation maximum is not below it
  assert(Number(/research\.ask_over_fetch[\s\S]*?"max":(\d+)/.exec(s730)?.[1]) >= effective("research.max_fetch"));
});

Deno.test("the keys no code reads yet say so in read_by and help (the page shows that note), and the two applied keys do not", () => {
  const row = (key: string) => new RegExp(`\\('${key.replace(/\./g, "\\.")}', 'user',[\\s\\S]*?'settings', '(?:only_you|on_server)'\\)`).exec(s730)?.[0] ?? "";
  for (const key of ["library.how_far_out", "library.recent_size", "library.clear_on_signout", "library.hidden_suggestions", "podcast.default_format", "podcast.episode_minutes"]) {
    const r = row(key);
    assert(/kept now, applied when (the Library|the new-episode form) opens\)/.test(r), `${key}: read_by`);
    assert(/Kept now; applied when (the Library|the new-episode form) opens\./.test(r), `${key}: help`);
  }
  for (const key of ["research.default_depth", "research.ask_over_fetch"]) assert(!/kept now/i.test(row(key)), `${key} is applied today`);
});
