// deno test src/contracts/cast_integration_test.ts - rwr-cast-edit-api (slot 560) over a REAL workbench and database, as
// TWO users. SKIPPED unless CAST_TEST_BASE and CONTRACT_TEST_DB_HOST are set; contract-test/run-cast-tests.ps1 runs it in
// its disposable lab (the real initdb chain incl. 560-init-cast.sql, fixtures.sql, the :wt workbench logged in as
// ob_workbench with WORKSPACE_IDENTITY_HEADER=X-Test-Sub, PostgREST + the rest Caddy). Never point it at a live stack.
//
// C1..C18 name the acceptance statements (C17, C18: rwr-voices) (test-plans/rwr-cast-edit-api.md). A and B are fresh lab subjects per run.
// Environment: CAST_TEST_BASE, CAST_TEST_KEY, CAST_TEST_SUB_HEADER (default X-Test-Sub), CAST_TEST_REST (the lab's
// PostgREST root, for C5), CAST_TEST_RECIPES (the recipes mount, for C5), CAST_TEST_MARKER_OUT (a file the run writes
// its planted markers to, so the runner can search the workbench's log for them),
// CONTRACT_TEST_DB_HOST/_PORT/_USER/_PASSWORD (superuser: plants and snapshots).
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { Pool } from "postgres";

const BASE = (Deno.env.get("CAST_TEST_BASE") ?? "").replace(/\/+$/, "");
const KEY = Deno.env.get("CAST_TEST_KEY") ?? "";
const HOST = Deno.env.get("CONTRACT_TEST_DB_HOST");
const SUB_HEADER = Deno.env.get("CAST_TEST_SUB_HEADER") ?? "X-Test-Sub";
const REST = (Deno.env.get("CAST_TEST_REST") ?? "").replace(/\/+$/, "");
const RECIPES = (Deno.env.get("CAST_TEST_RECIPES") ?? "").replace(/\/+$/, "");
const MARKER_OUT = Deno.env.get("CAST_TEST_MARKER_OUT") ?? "";
const ignore = !BASE || !HOST;
const pool = !ignore
  ? new Pool({
    hostname: HOST!, port: Number(Deno.env.get("CONTRACT_TEST_DB_PORT") ?? 5432), database: "openbrain",
    user: Deno.env.get("CONTRACT_TEST_DB_USER") ?? "postgres", password: Deno.env.get("CONTRACT_TEST_DB_PASSWORD") ?? "",
  }, 3, true)
  : null;
const t = (name: string, fn: () => Promise<void>) => Deno.test({ name, ignore, fn, sanitizeOps: false, sanitizeResources: false });

async function sql<T = Record<string, any>>(text: string, args: unknown[] = []): Promise<T[]> {
  const c = await pool!.connect();
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    c.release();
  }
}

const rnd = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
const RUN = rnd();
const A = `lab-cast-a-${RUN}`;
const B = `lab-cast-b-${RUN}`;
// planted markers: A's private material. None may ever reach B, a shared table, or the workbench's log.
const M = {
  stance: `CastStanceSecret${rnd()}`, notes: `CastNotesSecret${rnd()}`, topic: `CastTopicSecret${rnd()}`, backstory: `CastBackstorySecret${rnd()}`,
  team: `CastTeamSecret${rnd()}`, format: `CastBriefingSecret${rnd()}`, privTitle: `CastPrivateSourceSecret${rnd()}`, dupName: `CastDupNameSecret${rnd()}`,
  prompt: `CastOwnPromptSecret${rnd()}`,
};
const SHARED_SOURCE = "11111111-1111-4111-8111-111111111111";
const PRIV = crypto.randomUUID(); // A's private source (planted below)

interface Res { status: number; json: any; text: string }
async function call(method: string, path: string, body: unknown, sub: string | null): Promise<Res> {
  const headers: Record<string, string> = { "x-brain-key": KEY };
  if (sub) headers[SUB_HEADER] = sub;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`${BASE}/workbench/contract/cast${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch { /* not json */ }
  return { status: r.status, json, text };
}
const asA = (m: string, p: string, b?: unknown) => call(m, p, b, A);
const asB = (m: string, p: string, b?: unknown) => call(m, p, b, B);
const noMarkers = (label: string, text: string) => {
  for (const [k, v] of Object.entries(M)) assert(!text.includes(v), `${label}: carries A's ${k} marker`);
};
const missing = (kind: string) => `${kind}-${crypto.randomUUID()}`;
// the share step: read the preview, then PATCH {shared: true, share_digest} (the operator's rule: a share first shows what it shares)
async function share(kind: string, id: string, sub = A): Promise<Res> {
  const pv = await call("GET", `/${kind}/${id}/share-preview`, undefined, sub);
  if (pv.status !== 200) return pv;
  return await call("PATCH", `/${kind}/${id}`, { shared: true, share_digest: pv.json.share_digest }, sub);
}

// A's world, made through the routes once (C1 checks it; later cases use it)
const W: Record<string, string> = {};
async function setup() {
  if (W.ready) return;
  if (MARKER_OUT) await Deno.writeTextFile(MARKER_OUT, Object.values(M).join("\n") + "\n");
  await sql(`INSERT INTO public.inlet_private_sources
             SELECT (jsonb_populate_record(NULL::public.inlet_private_sources, to_jsonb(s) || jsonb_build_object(
                       'id', $1::uuid, 'url', 'https://mail.example/' || $2::text, 'title', $2::text, 'content', 'private body ' || $2::text,
                       'content_hash', md5($2::text), 'inlet_owner_sub', $3::text))).*
               FROM public.sources s WHERE s.id = $4::uuid`, [PRIV, M.privTitle, A, SHARED_SOURCE]);
  const v = await asA("POST", "/voices", { route: "local-tts", voice: "bm_george", speed: 1.1 });
  assertEquals(v.status, 201, v.text);
  W.voice = v.json.id;
  const p = await asA("POST", "/presenters", {
    name: "Alex Cast", voice_id: W.voice, personality: "analytical", backstory: M.backstory, role: "host", focus: "markets", stance: M.stance,
    tone: "dry", speaking_style: "short", notes: M.notes,
    grounded_in: [{ kind: "source", ref: SHARED_SOURCE }, { kind: "source", ref: PRIV }, { kind: "topic", ref: M.topic }],
  });
  assertEquals(p.status, 201, p.text);
  W.presenter = p.json.id;
  const p2 = await asA("POST", "/presenters", { name: "Blair Cast", voice_id: W.voice });
  assertEquals(p2.status, 201, p2.text);
  W.presenter2 = p2.json.id;
  const tm = await asA("POST", "/teams", { name: M.team, members: [W.presenter, W.presenter2] });
  assertEquals(tm.status, 201, tm.text);
  W.team = tm.json.id;
  const f = await asA("POST", "/formats", { name: "A format", team_id: W.team, briefing: M.format, kind: "debate", use_for: ["daily"], is_default: true });
  assertEquals(f.status, 201, f.text);
  W.format = f.json.id;
  W.ready = "1";
}

t("C1: A writes presenters (every new field), voices, teams and formats; B cannot read, list, count or change any of them", async () => {
  await setup();
  const mine = await asA("GET", `/presenters/${W.presenter}`);
  assertEquals(mine.status, 200);
  const p = mine.json;
  assertEquals([p.role, p.focus, p.stance, p.tone, p.speaking_style, p.notes, p.system_prompt_mode], ["host", "markets", M.stance, "dry", "short", M.notes, "built"]);
  assertEquals(p.grounded_in.map((g: any) => [g.kind, g.ref, g.private]), [["source", SHARED_SOURCE, false], ["source", PRIV, true], ["topic", M.topic, false]]);
  assertEquals(p.grounded_in[1].label, M.privTitle, "the owner sees the private source's title");
  assertEquals(p.teams.map((x: any) => x.id), [W.team]);
  assertEquals(p.mine, true);
  // B: its own lists are empty and say so in their totals; the shared pool has none of A's (nothing is shared yet)
  for (const kind of ["presenters", "teams", "formats", "voices"]) {
    const r = await asB("GET", `/${kind}`);
    assertEquals(r.status, 200, r.text);
    assertEquals([r.json[kind].length, r.json.total], [0, 0], `B's ${kind}`);
    noMarkers(`B GET /${kind}`, r.text);
  }
  for (const kind of ["presenters", "teams", "formats"]) {
    const r = await asB("GET", `/${kind}?scope=shared`);
    assert(!r.text.includes(W.presenter) && !r.text.includes(W.team) && !r.text.includes(W.format), `B's shared ${kind} lists none of A's`);
    noMarkers(`B shared ${kind}`, r.text);
  }
  // by id: every read, change, delete and copy of A's row is the SAME answer as for a missing id
  const rows: [string, string][] = [["voices", W.voice], ["presenters", W.presenter], ["teams", W.team], ["formats", W.format]];
  for (const [kind, id] of rows) {
    const gone = missing(kind);
    for (const [m, suffix, body] of [["GET", "", undefined], ["PATCH", "", { name: "B was here" }], ["DELETE", "", undefined], ["POST", "/copy", undefined]] as const) {
      if (kind === "voices" && suffix === "/copy") continue;
      const real = await asB(m, `/${kind}/${id}${suffix}`, kind === "voices" && m === "PATCH" ? { speed: 2 } : body);
      const fake = await asB(m, `/${kind}/${gone}${suffix}`, kind === "voices" && m === "PATCH" ? { speed: 2 } : body);
      assertEquals(real.status, 404, `${m} ${kind}/A's id: ${real.text}`);
      assertEquals([real.status, real.text], [fake.status, fake.text], `${m} ${kind}: A's row reads exactly as a missing one`);
      noMarkers(`${m} ${kind}`, real.text);
    }
  }
  // B naming A's rows inside its own writes: the same refusal as a missing id
  const bv = await asB("POST", "/voices", { route: "local-tts", voice: "af_bella" });
  assertEquals(bv.status, 201);
  const same = async (label: string, a: Res, b: Res) => {
    assertEquals([a.status, a.text], [b.status, b.text], label);
    assertEquals(a.status, 404, label);
    noMarkers(label, a.text);
  };
  await same("B's presenter on A's voice", await asB("POST", "/presenters", { name: "x", voice_id: W.voice }), await asB("POST", "/presenters", { name: "x", voice_id: missing("voice") }));
  await same("B's grounding on A's private source", await asB("POST", "/presenters", { name: "x", voice_id: bv.json.id, grounded_in: [{ kind: "source", ref: PRIV }] }),
    await asB("POST", "/presenters", { name: "x", voice_id: bv.json.id, grounded_in: [{ kind: "source", ref: crypto.randomUUID() }] }));
  const bp = await asB("POST", "/presenters", { name: "B own", voice_id: bv.json.id });
  assertEquals(bp.status, 201);
  await same("B's team with A's presenter", await asB("POST", "/teams", { name: "bt", members: [bp.json.id, W.presenter] }),
    await asB("POST", "/teams", { name: "bt", members: [bp.json.id, missing("presenter")] }));
  await same("B's format on A's team", await asB("POST", "/formats", { name: "bf", team_id: W.team }), await asB("POST", "/formats", { name: "bf", team_id: missing("team") }));
  // nothing of A's changed
  const after = await asA("GET", `/presenters/${W.presenter}`);
  assertEquals(after.json.name, "Alex Cast");
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.podcast_presenters WHERE owner_sub = $1`, [A]))[0].n, 2);
});

t("C2: Q12 - a profile linking a private source cannot be shared until the link is removed; B reads a shared one, cannot edit it, and a use is B's own copy", async () => {
  await setup();
  // the disclosure step: the preview lists what would be shared, what blocks it, what never is
  const pv0 = await asA("GET", `/presenters/${W.presenter}/share-preview`);
  assertEquals(pv0.status, 200, pv0.text);
  assertEquals([pv0.json.shareable, pv0.json.already_shared, pv0.json.blocked_by.map((x: any) => [x.ref, x.label])], [false, false, [[PRIV, M.privTitle]]]);
  assert(pv0.json.would_share.some((x: any) => x.label === M.topic) && pv0.json.would_share[0].detail.includes("stance"), "lists the topic and the fields set");
  assertEquals(pv0.json.never_shared, ["notes", "which of your teams it sits in"]);
  assert(!JSON.stringify(pv0.json.would_share).includes(M.notes), "notes are never in what would be shared");
  // B: the preview of A's unshared row is the missing answer
  const bpv = await asB("GET", `/presenters/${W.presenter}/share-preview`);
  assertEquals([bpv.status, bpv.text], [404, JSON.stringify({ error: "no such presenter" })]);
  const refused = await asA("PATCH", `/presenters/${W.presenter}`, { shared: true, share_digest: pv0.json.share_digest });
  assertEquals(refused.status, 409, refused.text);
  assert(refused.json.error.includes(M.privTitle), "the refusal names the link (to its owner)");
  assertEquals(refused.json.detail.private_links.map((l: any) => l.ref), [PRIV]);
  assertEquals((await sql(`SELECT shared FROM public.podcast_presenters WHERE id = $1`, [W.presenter]))[0].shared, false, "nothing changed");
  // a create can never share (made private); a share without a preview, with a stale digest, or with other changes is refused
  const cr = await asA("POST", "/presenters", { name: "x", voice_id: W.voice, shared: true });
  assertEquals(cr.status, 400, cr.text);
  const fix = await asA("PATCH", `/presenters/${W.presenter}`, { grounded_in: [{ kind: "source", ref: SHARED_SOURCE }, { kind: "topic", ref: "markets" }] });
  assertEquals(fix.status, 200, fix.text);
  assertEquals((await asA("PATCH", `/presenters/${W.presenter}`, { shared: true })).status, 409, "no digest: no share");
  assertEquals((await asA("PATCH", `/presenters/${W.presenter}`, { shared: true, share_digest: pv0.json.share_digest })).status, 409, "a stale digest: no share");
  const pv1 = await asA("GET", `/presenters/${W.presenter}/share-preview`);
  assertEquals([pv1.json.shareable, pv1.json.blocked_by], [true, []]);
  assertEquals((await asA("PATCH", `/presenters/${W.presenter}`, { shared: true, share_digest: pv1.json.share_digest, stance: "x" })).status, 400, "a share is alone in its body");
  assertEquals((await sql(`SELECT shared FROM public.podcast_presenters WHERE id = $1`, [W.presenter]))[0].shared, false, "no refused share changed anything");
  const ok = await asA("PATCH", `/presenters/${W.presenter}`, { shared: true, share_digest: pv1.json.share_digest });
  assertEquals(ok.status, 200, ok.text);
  assertEquals(ok.json.shared, true);
  // B may not preview someone else's shared row (read-only)
  assertEquals((await asB("GET", `/presenters/${W.presenter}/share-preview`)).status, 403);
  const add = await asA("PATCH", `/presenters/${W.presenter}`, { grounded_in: [{ kind: "source", ref: PRIV }] });
  assertEquals(add.status, 409, "a shared presenter cannot take a private link");
  // B reads it: no notes, no teams, only the shared links; in the pool and by id
  const pool = await asB("GET", `/presenters?scope=shared`);
  const seen = pool.json.presenters.find((x: any) => x.id === W.presenter);
  assert(seen, "B sees A's shared presenter in the shared pool");
  const one = await asB("GET", `/presenters/${W.presenter}`);
  assertEquals(one.status, 200);
  for (const x of [seen, one.json]) {
    assertEquals([x.notes, x.teams, x.mine], [null, [], false]);
    assertEquals(x.grounded_in.map((g: any) => g.ref), [SHARED_SOURCE, "markets"]);
  }
  assert(!one.text.includes(M.notes) && !one.text.includes(W.team) && !one.text.includes(M.team), "no notes and no team of A's");
  // B cannot edit or delete it (read-only), and nothing changes
  for (const [m, b] of [["PATCH", { stance: "B's stance" }], ["DELETE", undefined]] as const) {
    const r = await asB(m, `/presenters/${W.presenter}`, b);
    assertEquals(r.status, 403, `${m}: ${r.text}`);
  }
  assertEquals((await sql(`SELECT stance FROM public.podcast_presenters WHERE id = $1`, [W.presenter]))[0].stance, M.stance);
  // using it makes B's own copy: B's voice too, no notes, copied_from names the original; editing it never touches A's
  const cp = await asB("POST", `/presenters/${W.presenter}/copy`);
  assertEquals(cp.status, 201, cp.text);
  assertEquals([cp.json.mine, cp.json.shared, cp.json.copied_from, cp.json.notes, cp.json.stance], [true, false, W.presenter, "", M.stance]);
  assertNotEquals(cp.json.voice.id, W.voice);
  const rows = await sql(`SELECT p.owner_sub AS po, v.owner_sub AS vo FROM public.podcast_presenters p JOIN public.podcast_voice_links v ON v.id = p.voice_link_id WHERE p.id = $1`, [cp.json.id]);
  assertEquals(rows[0], { po: B, vo: B });
  const ed = await asB("PATCH", `/presenters/${cp.json.id}`, { stance: "B's own stance" });
  assertEquals(ed.status, 200);
  assertEquals((await sql(`SELECT stance FROM public.podcast_presenters WHERE id = $1`, [W.presenter]))[0].stance, M.stance, "the original is untouched");
  // a team is shared only with every member shared; a format only with its team shared
  const tpv = await asA("GET", `/teams/${W.team}/share-preview`);
  assertEquals(tpv.json.blocked_by.map((x: any) => x.label), ["Blair Cast"], "the preview names the unshared member");
  const ts = await share("teams", W.team);
  assertEquals(ts.status, 409, ts.text);
  assert(ts.json.error.includes("Blair Cast"), "names the unshared member (to the owner)");
  assertEquals((await share("presenters", W.presenter2)).status, 200);
  const fs = await share("formats", W.format);
  assertEquals(fs.status, 409, "the format's team is not shared yet");
  assertEquals((await share("teams", W.team)).status, 200);
  assertEquals((await share("formats", W.format)).status, 200);
  // and the reverse: a member of a shared team stays shared; a shared format's team stays shared
  assertEquals((await asA("PATCH", `/presenters/${W.presenter2}`, { shared: false })).status, 409);
  assertEquals((await asA("PATCH", `/teams/${W.team}`, { shared: false })).status, 409);
  // B reads the shared format and team; their owner-only fields are empty; a use copies the whole cast
  const bf = await asB("GET", `/formats/${W.format}`);
  assertEquals([bf.status, bf.json.is_default, bf.json.mine], [200, false, false]);
  const bt = await asB("GET", `/teams/${W.team}`);
  assertEquals([bt.status, bt.json.formats], [200, []]);
  const fc = await asB("POST", `/formats/${W.format}/copy`);
  assertEquals(fc.status, 201, fc.text);
  const bteam = await asB("GET", `/teams/${fc.json.team_id}`);
  assertEquals([bteam.json.mine, bteam.json.copied_from, bteam.json.members.length], [true, W.team, 2]);
  const owners = await sql(`SELECT DISTINCT p.owner_sub AS o FROM public.podcast_team_members m JOIN public.podcast_presenters p ON p.id = m.presenter_id WHERE m.team_id = $1`, [fc.json.team_id]);
  assertEquals(owners, [{ o: B }], "the copied team's presenters are B's own copies");
  assertEquals((await asB("PATCH", `/formats/${fc.json.id}`, { briefing: "B's" })).status, 200);
  assertEquals((await sql(`SELECT briefing FROM public.podcast_formats WHERE id = $1`, [W.format]))[0].briefing, M.format);
  // unshare again for the later cases (format, team, presenters, in that order)
  for (const [k, id] of [["formats", W.format], ["teams", W.team], ["presenters", W.presenter], ["presenters", W.presenter2]]) {
    assertEquals((await asA("PATCH", `/${k}/${id}`, { shared: false })).status, 200, `${k} unshared`);
  }
  // once unshared, B's copy no longer names it, and B's reads of it are the missing answer again
  assertEquals((await asB("GET", `/presenters/${cp.json.id}`)).json.copied_from, null);
  assertEquals((await asB("GET", `/presenters/${W.presenter}`)).status, 404);
});

t("C3: a presenter in a team cannot be deleted until it is taken out; the refusal names the team only to its owner", async () => {
  await setup();
  const r = await asA("DELETE", `/presenters/${W.presenter2}`);
  assertEquals(r.status, 409, r.text);
  assert(r.json.error.includes(M.team), "names the team to the owner");
  assertEquals(r.json.detail.teams.map((x: any) => x.id), [W.team]);
  const b = await asB("DELETE", `/presenters/${W.presenter2}`);
  assertEquals([b.status, b.text], [404, JSON.stringify({ error: "no such presenter" })], "B: the missing answer, no team named");
  // take it out, then it deletes; the team keeps its order
  const out = await asA("PATCH", `/teams/${W.team}`, { members: [W.presenter] });
  assertEquals([out.status, out.json.members.map((m: any) => m.presenter_id), out.json.user_seat], [200, [W.presenter], 1]);
  const del = await asA("DELETE", `/presenters/${W.presenter2}`);
  assertEquals(del.status, 200, del.text);
  assertEquals((await asA("GET", `/presenters/${W.presenter2}`)).status, 404);
  // a voice voicing a presenter is refused, naming the presenter
  const dv = await asA("DELETE", `/voices/${W.voice}`);
  assertEquals(dv.status, 409);
  assert(dv.json.error.includes("Alex Cast"));
});

t("C4: a team is at most 26 seats in order - 25 presenters and the user's seat", async () => {
  await setup();
  const ids: string[] = [];
  for (let i = 0; i < 26; i++) {
    const p = await asA("POST", "/presenters", { name: `Seat ${String(i).padStart(2, "0")}`, voice_id: W.voice });
    assertEquals(p.status, 201);
    ids.push(p.json.id);
  }
  const full = await asA("POST", "/teams", { name: `full-${RUN}`, members: ids.slice(0, 25), user_seat: 12 });
  assertEquals(full.status, 201, full.text);
  assertEquals([full.json.seats, full.json.user_seat, full.json.members.map((m: any) => m.presenter_id)], [26, 12, ids.slice(0, 25)]);
  assertEquals(full.json.members.map((m: any) => m.position), [...Array(25).keys()]);
  const over = await asA("POST", "/teams", { name: `over-${RUN}`, members: ids });
  assertEquals(over.status, 400, "26 presenters leave no seat for the user");
  const over2 = await asA("PATCH", `/teams/${full.json.id}`, { members: ids });
  assertEquals(over2.status, 400);
  const seat = await asA("POST", "/teams", { name: `seat-${RUN}`, members: [ids[0]], user_seat: 2 });
  assertEquals(seat.status, 400, "the seat is within 0 .. members");
  const dup = await asA("POST", "/teams", { name: `dup-${RUN}`, members: [ids[0], ids[0]] });
  assertEquals(dup.status, 400);
  const dflt = await asA("POST", "/teams", { name: `default-seat-${RUN}`, members: [ids[2], ids[1], ids[0]] });
  assertEquals([dflt.json.user_seat, dflt.json.seats, dflt.json.members.map((m: any) => m.presenter_id)], [3, 4, [ids[2], ids[1], ids[0]]]);
  const re = await asA("PATCH", `/teams/${dflt.json.id}`, { members: [ids[0], ids[2]], user_seat: 0 });
  assertEquals([re.json.user_seat, re.json.members.map((m: any) => m.presenter_id)], [0, [ids[0], ids[2]]]);
  // an existing (pre-560) team reads with its seat after the last presenter
  const pre = await call("GET", "/teams/pod-fx-team", undefined, "lab-podcaster-0001");
  assertEquals([pre.status, pre.json.user_seat, pre.json.seats], [200, 2, 3]);
});

Deno.test({
  name: "C5: the render of an existing captured team is unchanged when no new field is set; set fields reach the renderer (real PostgREST)",
  ignore: ignore || !REST || !RECIPES, sanitizeOps: false, sanitizeResources: false,
  fn: async () => {
    const storeMod = await import(`file://${RECIPES}/daily-digest/src/podcast/presenter-store.ts`);
    const pres = await import(`file://${RECIPES}/daily-digest/src/podcast/presenters.ts`);
    const golden = JSON.parse(await Deno.readTextFile(`${RECIPES}/daily-digest/src/podcast/testdata/cast-golden.json`));
    const owner = `lab-cast-render-${RUN}`;
    // the store's own requests, straight to the lab's PostgREST (its /rest/v1 prefix is the rest door's, not PostgREST's)
    const store = new storeMod.PresenterStore("http://rest.invalid",
      ((u: string | URL | Request, init?: RequestInit) => fetch(String(u).replace("http://rest.invalid/rest/v1", REST), init)) as typeof fetch);
    // the solo_expert team exactly as the ON capture maps it (on-capture.test.ts fixture; golden key cast:solo_expert)
    const sfx = RUN;
    const voice = { id: `rv-${sfx}`, route: "local-tts", voice: "af_heart", speed: 1, origin: "on-capture" };
    const presenter = { id: `rp-${sfx}`, name: "Prof Kim", personality: "Prof Kim personality", backstory: "Prof Kim backstory", language: "en-US", voice, origin: "on-capture" };
    const team = { id: `rt-${sfx}`, name: `solo_expert-${sfx}`, description: "solo_expert desc", presenters: [presenter], origin: "on-capture" };
    await store.insertModel(owner, { voices: [voice], presenters: [presenter], teams: [team], formats: [] });
    const read = await store.team(owner, team.id);
    assertEquals(pres.castBlock(read), golden["cast:solo_expert"], "byte-identical to the pre-change capture");
    // the owner edits through the workbench; the renderer reads it
    const ed = await call("PATCH", `/presenters/${presenter.id}`, { stance: "contrarian", tone: "warm" }, owner);
    assertEquals(ed.status, 200, ed.text);
    const after = pres.castBlock(await store.team(owner, team.id));
    assertEquals(after, golden["cast:solo_expert"] + " Stance: contrarian Tone: warm");
    const own = await call("PATCH", `/presenters/${presenter.id}`, { system_prompt: M.prompt, system_prompt_mode: "own" }, owner);
    assertEquals(own.status, 200);
    assertEquals(pres.castBlock(await store.team(owner, team.id)).split("\n")[1], `HOST A is Prof Kim. ${M.prompt}`);
    // PostgREST answers a select of a column the database lacks with 400 42703: the store's fallback keys on exactly that
    const r = await fetch(`${REST}/podcast_presenters?select=id,no_such_column_${sfx}&limit=1`);
    const body = await r.text();
    assertEquals(r.status, 400);
    assert(body.includes("42703"), body.slice(0, 200));
  },
});

t("C6: no model route on a presenter, and no URL as a route anywhere (voice links, script routes)", async () => {
  await setup();
  for (const body of [{ model_route: "local-large" }, { model: "x" }, { route: "http://evil.example/v1" }]) {
    const r = await asA("PATCH", `/presenters/${W.presenter}`, body);
    assertEquals(r.status, 400, JSON.stringify(body));
  }
  for (const route of ["http://evil.example/v1", "https://api.openai.com/v1", "a/b"]) {
    assertEquals((await asA("POST", "/voices", { route, voice: "bm_george" })).status, 400, route);
    assertEquals((await asA("PATCH", `/voices/${W.voice}`, { route })).status, 400, route);
    assertEquals((await asA("PATCH", `/formats/${W.format}`, { script_route: route })).status, 400, route);
  }
  const cols = await sql<{ c: string }>(`SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'podcast_presenters' AND column_name ILIKE '%model%'`);
  assertEquals(cols, [], "no model column on a presenter");
});

t("C7: grounded-in links to private sources are visible only to their owner (also on the owner's own copy)", async () => {
  await setup();
  const w = await asA("PATCH", `/presenters/${W.presenter}`, { grounded_in: [{ kind: "source", ref: PRIV }, { kind: "topic", ref: M.topic }] });
  assertEquals(w.status, 200, w.text);
  assertEquals(w.json.grounded_in[0], { kind: "source", ref: PRIV, label: M.privTitle, private: true });
  const mycopy = await asA("POST", `/presenters/${W.presenter}/copy`);
  assertEquals(mycopy.status, 201);
  assertEquals(mycopy.json.grounded_in.map((g: any) => [g.ref, g.private]), [[PRIV, true], [M.topic, false]], "the owner's own copy keeps the owner's link");
  // B: nowhere (by id, in lists, the shared pool, copying is refused as missing)
  for (const r of [await asB("GET", `/presenters/${W.presenter}`), await asB("GET", "/presenters?scope=shared"), await asB("GET", "/presenters"),
    await asB("POST", `/presenters/${W.presenter}/copy`)]) {
    // (B legitimately holds C2's copies of what A shared then - stance and all; what must never reach B is the private link)
    assert(!r.text.includes(PRIV) && !r.text.includes(M.privTitle), "B never sees the private link or its title");
  }
  // even if the database held a shared presenter with such a link (the check script's rule), B's read omits it
  await sql(`UPDATE public.podcast_presenters SET shared = true WHERE id = $1`, [mycopy.json.id]);
  const b = await asB("GET", `/presenters/${mycopy.json.id}`);
  assertEquals(b.status, 200);
  assertEquals(b.json.grounded_in.map((g: any) => g.ref), [M.topic]);
  assert(!b.text.includes(PRIV) && !b.text.includes(M.privTitle));
  await sql(`UPDATE public.podcast_presenters SET shared = false WHERE id = $1`, [mycopy.json.id]);
});

t("C8: two identities - B's counts, totals and errors never move with A's data", async () => {
  await setup();
  const snap = async () => {
    const out: Record<string, unknown> = {};
    for (const k of ["presenters", "teams", "formats", "voices"]) {
      const r = await asB("GET", `/${k}`);
      out[k] = [r.status, r.json.total, r.json[k].length];
    }
    for (const k of ["presenters", "teams", "formats"]) out[`shared-${k}`] = (await asB("GET", `/${k}?scope=shared`)).json.total;
    return out;
  };
  const before = await snap();
  // A adds unshared rows of every kind
  const v = await asA("POST", "/voices", { route: "local-tts", voice: "am_michael" });
  const p = await asA("POST", "/presenters", { name: "C8", voice_id: v.json.id, notes: M.notes });
  await asA("POST", "/teams", { name: `c8-${RUN}`, members: [p.json.id] });
  assertEquals(await snap(), before, "B's lists, totals and the shared pool's total are unchanged");
  // the shared pool's total counts exactly the shared rows (of everyone), and A's private rows are not among them
  const sharedN = (await sql(`SELECT count(*)::int AS n FROM public.podcast_presenters p JOIN public.podcast_voice_links v ON v.id = p.voice_link_id AND v.owner_sub = p.owner_sub WHERE p.shared`))[0].n;
  assertEquals((await asB("GET", "/presenters?scope=shared")).json.total, sharedN);
  // error bodies: the same for A's id and a missing one, on every kind (C1 covers by id; here the validation path)
  const e1 = await asB("PATCH", `/presenters/${p.json.id}`, { shared: true, share_digest: "0" });
  const e2 = await asB("PATCH", `/presenters/${missing("presenter")}`, { shared: true, share_digest: "0" });
  assertEquals([e1.status, e1.text], [e2.status, e2.text]);
  const bad = await asB("GET", `/presenters/${"x".repeat(300)}`);
  assertEquals([bad.status, bad.text], [404, JSON.stringify({ error: "no such presenter" })]);
});

t("C9: nothing private from this item reaches a shared surface - shared search, shared rows, the ops corpus, an error", async () => {
  await setup();
  // an error path with a marker in it (a duplicate team name): a fixed message, no value
  const d1 = await asA("POST", "/teams", { name: M.dupName, members: [W.presenter] });
  assertEquals(d1.status, 201);
  const d2 = await asA("POST", "/teams", { name: M.dupName, members: [W.presenter] });
  assertEquals(d2.status, 409);
  assertEquals(d2.json.error, "that name is already taken by one of yours");
  // the shared search and the shared reads, as A and as B
  for (const who of [A, B]) {
    for (const m of Object.values(M)) {
      for (const path of [`/workbench/contract/search?q=${encodeURIComponent(m)}`, `/workbench/search?q=${encodeURIComponent(m)}`]) {
        const r = await fetch(`${BASE}${path}`, { headers: { "x-brain-key": KEY, [SUB_HEADER]: who } });
        const text = await r.text();
        if (r.status >= 400) continue;
        let body: any = null;
        try {
          body = JSON.parse(text);
        } catch { /* not json */ }
        // a search answers its own query back (query: the marker): judge everything else it says
        if (body && typeof body === "object" && body.query === m) delete body.query;
        const rest = body === null ? text : JSON.stringify(body);
        assert(!rest.includes(m), `${path} as ${who === A ? "A" : "B"} answers ${r.status} with the marker outside its query echo`);
      }
    }
  }
  // every table outside the cast model's own: no row carries a marker (shared rows, trails, the ops corpus)
  const own = new Set(["podcast_presenters", "podcast_teams", "podcast_formats", "podcast_voice_links", "podcast_presenter_grounding", "podcast_team_members",
    "inlet_private_sources"]); // the planted private source is A's own store
  const tables = await sql<{ t: string }>(`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                            WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`);
  const hits: string[] = [];
  for (const { t: tbl } of tables) {
    if (own.has(tbl)) continue;
    for (const [k, m] of Object.entries(M)) {
      const n = (await sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.${JSON.stringify(tbl)} x WHERE x::text LIKE $1`, [`%${m}%`]))[0].n;
      if (n) hits.push(`${tbl}:${k}=${n}`);
    }
  }
  assertEquals(hits, [], "a planted marker on a shared surface");
  console.log(`C9: ${tables.length - own.size} tables searched for ${Object.keys(M).length} markers: none`);
});

t("C10: existing episodes keep their team - a team with an episode or a render request cannot be deleted; a new team renders through the existing request route", async () => {
  await setup();
  const fmt = await asA("DELETE", `/teams/${W.team}`);
  assertEquals(fmt.status, 409, "the team still has its format");
  assert(fmt.json.error.includes("A format"));
  assertEquals((await asA("DELETE", `/formats/${W.format}`)).status, 200);
  const rq = await fetch(`${BASE}/workbench/contract/podcasts/requests`, {
    method: "POST", headers: { "x-brain-key": KEY, [SUB_HEADER]: A, "content-type": "application/json" },
    body: JSON.stringify({ team_id: W.team, title: "c10", transcript: { title: "c10", turns: [{ presenterId: W.presenter, text: "Hello." }] } }),
  });
  assertEquals(rq.status, 202, await rq.text());
  const del = await asA("DELETE", `/teams/${W.team}`);
  assertEquals(del.status, 409, del.text);
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.podcast_teams WHERE id = $1`, [W.team]))[0].n, 1);
  // the P7a fixture team and its episode read exactly as before
  const pre = await fetch(`${BASE}/workbench/contract/teams`, { headers: { "x-brain-key": KEY, [SUB_HEADER]: "lab-podcaster-0001" } });
  const pj = await pre.json();
  assertEquals(pj.teams[0].presenters.map((p: any) => p.presenter_id), ["pod-fx-presenter-a", "pod-fx-presenter-b"]);
  const empty = await asA("POST", "/teams", { name: `empty-${RUN}`, members: [W.presenter] });
  assertEquals((await asA("DELETE", `/teams/${empty.json.id}`)).status, 200, "a team nothing uses deletes");
});

t("C11: formats - kind and use-for are registry keys; one default per owner", async () => {
  await setup();
  const f1 = await asA("POST", "/formats", { name: `f1-${RUN}`, team_id: W.team, is_default: true, kind: "interview", use_for: ["research", "document"] });
  assertEquals(f1.status, 201, f1.text);
  const f2 = await asA("POST", "/formats", { name: `f2-${RUN}`, team_id: W.team, is_default: true });
  assertEquals([f2.json.is_default, f2.json.kind, f2.json.use_for], [true, "conversation", []]);
  assertEquals((await asA("GET", `/formats/${f1.json.id}`)).json.is_default, false, "the earlier default is cleared");
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.podcast_formats WHERE owner_sub = $1 AND is_default`, [A]))[0].n, 1);
  assertEquals((await asA("POST", "/formats", { name: `f3-${RUN}`, team_id: W.team, kind: "monologue" })).status, 422);
  assertEquals((await asA("POST", "/formats", { name: `f3-${RUN}`, team_id: W.team, use_for: ["nightly"] })).status, 422);
  assertEquals((await asA("PATCH", `/presenters/${W.presenter}`, { system_prompt_mode: "auto" })).status, 422);
  assertEquals((await asA("PATCH", `/presenters/${W.presenter}`, { grounded_in: [{ kind: "url", ref: "x" }] })).status, 422);
  // the existing (pre-560) fixture format reads with the defaults
  const pre = await call("GET", "/formats", undefined, "lab-podcaster-0001");
  assertEquals(pre.json.formats.map((f: any) => [f.id, f.kind, f.use_for, f.is_default]), [["pod-fx-format", "conversation", [], false]]);
});

t("C12: voice links - a change re-voices the presenters it voices", async () => {
  await setup();
  const v = await asA("PATCH", `/voices/${W.voice}`, { voice: "bf_emma", speed: 0.9 });
  assertEquals([v.status, v.json.voice, v.json.speed], [200, "bf_emma", 0.9]);
  assert(v.json.used_by.some((u: any) => u.id === W.presenter));
  assertEquals((await asA("GET", `/presenters/${W.presenter}`)).json.voice.voice, "bf_emma");
});

// ── C13-C16: the share rules hold under concurrent requests of the owner (found by the tester, attempt 1) ──────────────────
// A shared team never holds an unshared presenter; a shared format never an unshared team. Each is checked by one request
// against a row another request changes: repo/cast.ts "LOCK ORDER" serialises them. Statuses of a race are only ever 200 or
// 409 (never a 500: no deadlock), and the invariant holds in the database after every one.
const sharedPresenter = async (name: string) => {
  const p = await asA("POST", "/presenters", { name, voice_id: W.voice, stance: M.stance });
  assertEquals(p.status, 201, p.text);
  assertEquals((await share("presenters", p.json.id)).status, 200);
  return p.json.id as string;
};
const sharedTeam = async (name: string, members: string[]) => {
  const tm = await asA("POST", "/teams", { name, members });
  assertEquals(tm.status, 201, tm.text);
  assertEquals((await share("teams", tm.json.id)).status, 200);
  return tm.json.id as string;
};
const teamHoldsUnshared = async (teamId: string) => (await sql(
  `SELECT count(*)::int AS n FROM public.podcast_team_members m JOIN public.podcast_teams t ON t.id = m.team_id
     JOIN public.podcast_presenters p ON p.id = m.presenter_id WHERE t.id = $1 AND t.shared AND NOT p.shared`, [teamId]))[0].n;
const formatOnUnsharedTeam = async (formatId: string) => (await sql(
  `SELECT count(*)::int AS n FROM public.podcast_formats f JOIN public.podcast_teams t ON t.id = f.team_id WHERE f.id = $1 AND f.shared AND NOT t.shared`, [formatId]))[0].n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

t("C13: a shared team never ends up holding an unshared presenter (add-to-shared-team vs unshare, fixed ordering and 30 natural races)", async () => {
  await setup();
  // (a) the add has read the presenter and waits at its member rewrite (a test-held lock on the team's member rows) while the unshare runs
  {
    const p1 = await sharedPresenter(`c13-one-${RUN}`);
    const p3 = await sharedPresenter(`c13-three-${RUN}`);
    const tm = await sharedTeam(`c13-team-${RUN}`, [p1]);
    const c = await pool!.connect();
    let add: Promise<Res>, unshare: Promise<Res>;
    try {
      await c.queryArray("BEGIN");
      await c.queryArray("SELECT 1 FROM public.podcast_team_members WHERE team_id = $1 FOR UPDATE", [tm]);
      add = asA("PATCH", `/teams/${tm}`, { members: [p1, p3] });
      await sleep(1500);
      unshare = asA("PATCH", `/presenters/${p3}`, { shared: false });
      await sleep(1500);
    } finally {
      await c.queryArray("COMMIT");
      c.release();
    }
    const [a, u] = [await add!, await unshare!];
    assertEquals(await teamHoldsUnshared(tm), 0, `add ${a.status}, unshare ${u.status}: a shared team holds an unshared presenter`);
    assertEquals([a.status, u.status].sort(), [200, 409], `exactly one of the two wins: add ${a.status} ${a.text} / unshare ${u.status} ${u.text}`);
    // what B copies carries nothing of an unshared presenter: every presenter of B's copy was shared at the source
    const bc = await asB("POST", `/teams/${tm}/copy`);
    assertEquals(bc.status, 201, bc.text);
    const srcShared = (await sql(`SELECT count(*)::int AS n FROM public.podcast_team_members m JOIN public.podcast_presenters p ON p.id = m.presenter_id WHERE m.team_id = $1 AND p.shared`, [tm]))[0].n;
    const copied = (await sql(`SELECT count(*)::int AS n FROM public.podcast_team_members WHERE team_id = $1`, [bc.json.id]))[0].n;
    assertEquals(copied, srcShared, "B's copy has exactly the shared presenters of the team");
  }
  // (b) the other order: the unshare has committed between the add's request and its member check (the add waits on the row, then re-reads)
  {
    const p1 = await sharedPresenter(`c13b-one-${RUN}`);
    const p3 = await sharedPresenter(`c13b-three-${RUN}`);
    const tm = await sharedTeam(`c13b-team-${RUN}`, [p1]);
    const c = await pool!.connect();
    let add: Promise<Res>;
    try {
      await c.queryArray("BEGIN");
      await c.queryArray("UPDATE public.podcast_presenters SET shared = false WHERE id = $1", [p3]);
      add = asA("PATCH", `/teams/${tm}`, { members: [p1, p3] });
      await sleep(1500);
    } finally {
      await c.queryArray("COMMIT");
      c.release();
    }
    const a = await add!;
    assertEquals(a.status, 409, `the add after a committed unshare is refused: ${a.text}`);
    assertEquals(await teamHoldsUnshared(tm), 0);
  }
  // (c) natural: the same two requests fired together, 30 times: 200/409 only, the invariant after every one
  const wins = [0, 0];
  for (let i = 0; i < 30; i++) {
    const p1 = await sharedPresenter(`c13n-${i}a-${RUN}`);
    const p3 = await sharedPresenter(`c13n-${i}b-${RUN}`);
    const tm = await sharedTeam(`c13n-${RUN}-${i}`, [p1]);
    const [x, y] = await Promise.all([asA("PATCH", `/teams/${tm}`, { members: [p1, p3] }), asA("PATCH", `/presenters/${p3}`, { shared: false })]);
    assert([200, 409].includes(x.status) && [200, 409].includes(y.status), `race ${i}: ${x.status} ${y.status} ${x.text} ${y.text}`);
    assertEquals(await teamHoldsUnshared(tm), 0, `race ${i}: add ${x.status}, unshare ${y.status}: a shared team holds an unshared presenter`);
    if (x.status === 200) wins[0]++;
    if (y.status === 200) wins[1]++;
  }
  console.log(`C13 natural: add won ${wins[0]}, unshare won ${wins[1]} of 30`);
});

t("C14: a shared format never ends up on an unshared team (share-the-format vs unshare-its-team, fixed ordering and 30 natural races)", async () => {
  await setup();
  const mkFormat = async (tag: string) => {
    const p = await sharedPresenter(`c14-${tag}-p-${RUN}`);
    const tm = await sharedTeam(`c14-${tag}-t-${RUN}`, [p]);
    const f = await asA("POST", "/formats", { name: `c14-${tag}-f-${RUN}`, team_id: tm });
    assertEquals(f.status, 201, f.text);
    const pv = await asA("GET", `/formats/${f.json.id}/share-preview`);
    assertEquals(pv.status, 200, pv.text);
    return { tm, f: f.json.id as string, digest: pv.json.share_digest as string };
  };
  // (a) the team's unshare has committed between the share request and its team check (the share waits on the team row, then re-reads)
  {
    const x = await mkFormat("fixed");
    const c = await pool!.connect();
    let sh: Promise<Res>;
    try {
      await c.queryArray("BEGIN");
      await c.queryArray("UPDATE public.podcast_teams SET shared = false WHERE id = $1", [x.tm]);
      sh = asA("PATCH", `/formats/${x.f}`, { shared: true, share_digest: x.digest });
      await sleep(1500);
    } finally {
      await c.queryArray("COMMIT");
      c.release();
    }
    const r = await sh!;
    assertEquals(r.status, 409, `sharing a format whose team was just unshared is refused: ${r.text}`);
    assertEquals(await formatOnUnsharedTeam(x.f), 0);
  }
  // (b) natural, 30 times
  for (let i = 0; i < 30; i++) {
    const x = await mkFormat(`n${i}`);
    const [a, b] = await Promise.all([asA("PATCH", `/formats/${x.f}`, { shared: true, share_digest: x.digest }), asA("PATCH", `/teams/${x.tm}`, { shared: false })]);
    assert([200, 409].includes(a.status) && [200, 409].includes(b.status), `race ${i}: ${a.status} ${b.status} ${a.text} ${b.text}`);
    assertEquals(await formatOnUnsharedTeam(x.f), 0, `race ${i}: share ${a.status}, unshare team ${b.status}: a shared format sits on an unshared team`);
  }
});

t("C15: an unshared presenter cannot join an already-shared team; a shared format cannot move to an unshared team; a copy of a team brings only shared presenters", async () => {
  await setup();
  const p1 = await sharedPresenter(`c15-one-${RUN}`);
  const priv = await asA("POST", "/presenters", { name: `c15-private-${RUN}`, voice_id: W.voice, stance: M.stance });
  assertEquals(priv.status, 201, priv.text);
  const tm = await sharedTeam(`c15-team-${RUN}`, [p1]);
  const add = await asA("PATCH", `/teams/${tm}`, { members: [p1, priv.json.id] });
  assertEquals(add.status, 409, add.text);
  assert(add.text.includes(`c15-private-${RUN}`), "the refusal names the unshared presenter to its owner");
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.podcast_team_members WHERE team_id = $1`, [tm]))[0].n, 1, "the team is unchanged");
  assertEquals(await teamHoldsUnshared(tm), 0);
  // a shared format moved onto an unshared team
  const f = await asA("POST", "/formats", { name: `c15-f-${RUN}`, team_id: tm });
  assertEquals((await share("formats", f.json.id)).status, 200);
  const priv1 = await asA("POST", "/teams", { name: `c15-private-team-${RUN}`, members: [p1] });
  assertEquals(priv1.status, 201, priv1.text);
  const mv = await asA("PATCH", `/formats/${f.json.id}`, { team_id: priv1.json.id });
  assertEquals(mv.status, 409, mv.text);
  assertEquals(await formatOnUnsharedTeam(f.json.id), 0);
  // defence in depth: were a shared team to hold an unshared presenter (planted here by the superuser), another user's copy still
  // brings only the shared ones (nothing of the unshared presenter reaches B)
  await sql(`INSERT INTO public.podcast_team_members (team_id, position, presenter_id) VALUES ($1, 1, $2)`, [tm, priv.json.id]);
  try {
    const bc = await asB("POST", `/teams/${tm}/copy`);
    assertEquals(bc.status, 201, bc.text);
    const rows = await sql<{ name: string }>(
      `SELECT p.name FROM public.podcast_team_members m JOIN public.podcast_presenters p ON p.id = m.presenter_id WHERE m.team_id = $1 ORDER BY m.position`, [bc.json.id]);
    assertEquals(rows.map((r) => r.name), [`c15-one-${RUN}`], "B's copy has the shared presenter only");
    assert(!bc.text.includes(`c15-private-${RUN}`), "B never sees the unshared presenter's name");
    assertEquals(bc.json.seats, 2, "the copy's seats follow its members (one presenter and the user)");
  } finally {
    await sql(`DELETE FROM public.podcast_team_members WHERE team_id = $1 AND presenter_id = $2`, [tm, priv.json.id]);
  }
});

t("C16: two requests setting a default format at the same moment: the loser is told so, not 'name already taken'", async () => {
  await setup();
  const rs = await Promise.all([...Array(8).keys()].map((i) => asA("POST", "/formats", { name: `c16-${RUN}-${i}`, team_id: W.team, is_default: true })));
  for (const r of rs) assert(r.status === 201 || r.status === 409, `${r.status} ${r.text}`);
  for (const r of rs.filter((x) => x.status === 409)) {
    assert(!/name is already taken/.test(r.text), `a default-format clash is not a name clash: ${r.text}`);
    assert(/default format/.test(r.text), r.text);
  }
  assertEquals((await sql(`SELECT count(*)::int AS n FROM public.podcast_formats WHERE owner_sub = $1 AND is_default`, [A]))[0].n, 1);
});

// rwr-voices. The screen's own write sequences, then the render reading what they stored (C17), and the voice sample route (C18).
// CAST_TEST_PODCAST is the lab's openbrain-podcast stand-in: it runs the REAL recipes sample handler with a recording speech
// function, and there is NO speech host anywhere on the lab network; GET /__calls is its record of what it was told to voice.
const STUB_PODCAST = (Deno.env.get("CAST_TEST_PODCAST") ?? "").replace(/\/+$/, "");
async function podcastCalls(): Promise<{ route: string; voice: string; speed: number; text: string }[]> {
  return await (await fetch(`${STUB_PODCAST}/__calls`)).json();
}

Deno.test({
  name: "C17: save then render uses the edited values - the screen's sequences (own voice link edited in place; shared link split; presenter fields) are what the renderer's store reads next (real PostgREST)",
  ignore: ignore || !REST || !RECIPES, sanitizeOps: false, sanitizeResources: false,
  fn: async () => {
    const storeMod = await import(`file://${RECIPES}/daily-digest/src/podcast/presenter-store.ts`);
    const pres = await import(`file://${RECIPES}/daily-digest/src/podcast/presenters.ts`);
    const owner = `lab-cast-voices-${RUN}`;
    const store = new storeMod.PresenterStore("http://rest.invalid",
      ((u: string | URL | Request, init?: RequestInit) => fetch(String(u).replace("http://rest.invalid/rest/v1", REST), init)) as typeof fetch);
    const as = (m: string, pth: string, b?: unknown) => call(m, pth, b, owner);
    const v1 = (await as("POST", "/voices", { route: "local-tts", voice: "af_heart", speed: 1 })).json;
    const v2 = (await as("POST", "/voices", { route: "local-tts", voice: "bm_george", speed: 1 })).json;
    const pa = (await as("POST", "/presenters", { name: "Voices A", voice_id: v1.id, tone: "dry" })).json;
    const pb = (await as("POST", "/presenters", { name: "Voices B", voice_id: v1.id })).json;
    const pc = (await as("POST", "/presenters", { name: "Voices C", voice_id: v2.id })).json;
    const tm = (await as("POST", "/teams", { name: `voices-team-${RUN}`, members: [pa.id, pb.id, pc.id], user_seat: 1 })).json;
    const read = async () => await store.team(owner, tm.id);
    const before = await read();
    const castBefore = pres.castBlock(before);
    const voiceOf = (t: any, id: string) => t.presenters.find((p: any) => p.id === id).voice;
    assertEquals(voiceOf(before, pa.id), { id: v1.id, route: "local-tts", voice: "af_heart", speed: 1 });
    // (1) a voice link only one presenter uses: edited in place
    const e1 = await as("PATCH", `/voices/${v2.id}`, { voice: "bf_emma", speed: 1.25 });
    assertEquals(e1.status, 200, e1.text);
    assertEquals(voiceOf(await read(), pc.id), { id: v2.id, route: "local-tts", voice: "bf_emma", speed: 1.25 });
    // (2) a link two presenters share: the screen makes a link of its own for the one being changed (the other keeps its voice)
    const nv = await as("POST", "/voices", { route: "local-tts", voice: "am_michael", speed: 0.9 });
    assertEquals(nv.status, 201, nv.text);
    const e2 = await as("PATCH", `/presenters/${pb.id}`, { voice_id: nv.json.id, tone: "warm and unhurried" });
    assertEquals(e2.status, 200, e2.text);
    const after = await read();
    assertEquals(voiceOf(after, pb.id), { id: nv.json.id, route: "local-tts", voice: "am_michael", speed: 0.9 });
    assertEquals(voiceOf(after, pa.id), voiceOf(before, pa.id), "the presenter that kept the shared link keeps its voice");
    // (3) the cast the script prompt carries changed exactly where the edit was
    const castAfter = pres.castBlock(after);
    assertNotEquals(castAfter, castBefore);
    assert(castAfter.includes("Tone: warm and unhurried") && castAfter.includes("Tone: dry"), castAfter);
    // (4) the screen's delete order: the presenter out of its team, the presenter, then its own voice link
    const left = await as("PATCH", `/teams/${tm.id}`, { members: [pa.id, pc.id] });
    assertEquals(left.status, 200, left.text);
    assertEquals((await as("DELETE", `/presenters/${pb.id}`)).status, 200);
    assertEquals((await as("DELETE", `/voices/${nv.json.id}`)).status, 200);
    assertEquals((await read()).presenters.map((p: any) => p.id), [pa.id, pc.id]);
    // a voice link still voicing a presenter is refused (the screen never deletes a link another presenter uses)
    assertEquals((await as("DELETE", `/voices/${v1.id}`)).status, 409);
  },
});

Deno.test({
  name: "C18: the voice sample - own voice link only (B's, a missing and a malformed id are one 404 and nothing is voiced), a fixed sentence, a WAV, voiced by the podcast service alone",
  ignore: ignore || !STUB_PODCAST, sanitizeOps: false, sanitizeResources: false,
  fn: async () => {
    await setup();
    const callsBefore = (await podcastCalls()).length;
    const raw = async (sub: string | null, id: string, body?: unknown) => {
      const headers: Record<string, string> = { "x-brain-key": KEY };
      if (sub) headers[SUB_HEADER] = sub;
      if (body !== undefined) headers["content-type"] = "application/json";
      return await fetch(`${BASE}/workbench/contract/cast/voices/${id}/sample`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    };
    const ok = await raw(A, W.voice);
    assertEquals(ok.status, 200);
    assertEquals(ok.headers.get("content-type"), "audio/wav");
    assertEquals(ok.headers.get("cache-control"), "no-store");
    const wav = new Uint8Array(await ok.arrayBuffer());
    assertEquals(new TextDecoder().decode(wav.slice(0, 4)) + new TextDecoder().decode(wav.slice(8, 12)), "RIFFWAVE");
    assert(wav.length > 44);
    const calls = await podcastCalls();
    assertEquals(calls.length, callsBefore + 1, "exactly one voicing, by the podcast service");
    const last = calls[calls.length - 1];
    assertEquals([last.route, last.voice, last.speed], ["local-tts", "bm_george", 1.1], "the route, voice and speed of A's voice link, as stored");
    assert(last.text.length > 0 && last.text.length < 200, "one short fixed sentence");
    // B asks for A's voice link, a missing id and a malformed id: the same 404, and the podcast service is not asked
    const bodies: string[] = [];
    for (const id of [W.voice, missing("voice"), "..%2Fx"]) {
      const r = await raw(B, id);
      assertEquals(r.status, 404, id);
      bodies.push(await r.text());
    }
    assertEquals(new Set(bodies).size, 1, "one answer for all three");
    noMarkers("the refusal", bodies[0]);
    assertEquals((await podcastCalls()).length, callsBefore + 1, "nothing was voiced for B");
    // the sample takes no body: a text of the caller's is never spoken
    const withBody = await raw(A, W.voice, { text: "say something else" });
    await withBody.arrayBuffer();
    const calls2 = await podcastCalls();
    assertNotEquals(calls2[calls2.length - 1].text, "say something else");
    // a service key has no cast, so no sample (and nothing is voiced)
    const n = (await podcastCalls()).length;
    const svc = await raw(null, W.voice);
    await svc.arrayBuffer();
    assert(svc.status >= 400, `a service key has no cast: ${svc.status}`);
    assertEquals((await podcastCalls()).length, n);
  },
});

t("closes the pool", async () => {
  await pool?.end();
});
