// rwr-episode-from, the parts that need no database: the kinds registry, the disclosure sentence and its fingerprint, the
// share step's rules read from the route source, and "nothing but the share step sets shared = true".
// The two-identity cases over a real database are episode_from_integration_test.ts (the lab).
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  disclosureHash, disclosureText, type DisclosureItem, item, itemsOf, KINDS, kindEntry, labelOf, LABEL_MAX, parseFrom,
} from "./logic/episode_inputs.ts";
import { RESOLVERS } from "./repo/episode_inputs.ts";
import { createRequest, NO_INPUT } from "./repo/podcasts.ts";
import type { Db } from "./db.ts";

Deno.test("the kinds: run, report, document, idea, topic and discussion; discussion is registered and not available", () => {
  assertEquals(KINDS.map((k) => k.id), ["run", "report", "document", "idea", "topic", "discussion"]);
  assertEquals(kindEntry("discussion")?.available, false);
  for (const k of KINDS) if (k.id !== "discussion") assertEquals(k.available, true, k.id);
  for (const k of ["run", "report", "document", "idea"]) assertEquals(kindEntry(k)?.personal, true, `${k} starts from personal data`);
  assertEquals(kindEntry("topic")?.personal, false);
});

Deno.test("every available kind has a resolver and no other has one (the registry and the resolvers agree)", () => {
  assertEquals(Object.keys(RESOLVERS).sort(), KINDS.filter((k) => k.available).map((k) => k.id).sort());
});

Deno.test("parseFrom: a kind of the registry and one id; anything else is a 400, a kind that is not registered included", () => {
  assertEquals(parseFrom({ kind: "idea", id: " abc " }), { kind: "idea", id: "abc" });
  for (const bad of [null, "idea", {}, { kind: "idea" }, { id: "x" }, { kind: 1, id: "x" }, { kind: "idea", id: "" }, { kind: "idea", id: "x".repeat(513) }, { kind: "habit", id: "x" }, { kind: "__proto__", id: "x" }]) {
    let threw = false;
    try {
      parseFrom(bad);
    } catch (e) {
      threw = (e as Error).constructor.name === "BadRequest";
    }
    assert(threw, `refused: ${JSON.stringify(bad)}`);
  }
});

Deno.test("the disclosure sentence is the operator's words with the list in it; an empty list says nothing private", () => {
  const items: DisclosureItem[] = [item("idea", "i1", "My idea"), item("claim", "c1", "A claim\nover two lines", "cloud")];
  assertEquals(
    disclosureText("podcast", items),
    "By sharing this podcast, you'll be sharing the following private information to the users who have access to this server: [idea: My idea; claim: A claim over two lines (cloud-derived)]",
  );
  assertEquals(
    disclosureText("podcast", []),
    "By sharing this podcast, you'll be sharing the following private information to the users who have access to this server: [nothing private]",
  );
  assertEquals(disclosureText("discussion", []).startsWith("By sharing this discussion, "), true);
});

Deno.test("labels are one short line", () => {
  assertEquals(labelOf("  a \n b\t c  "), "a b c");
  assertEquals(labelOf("x".repeat(500)).length, LABEL_MAX);
});

Deno.test("the digest covers exactly the list shown: any item, marker, label or count changing changes it; order does not", async () => {
  const a = item("idea", "i1", "My idea");
  const b = item("claim", "c1", "A claim");
  const base = await disclosureHash([a, b]);
  assertEquals(await disclosureHash([b, a]), base, "order does not matter");
  assert(base !== await disclosureHash([a]), "an item omitted");
  assert(base !== await disclosureHash([a, b, item("source", "s1", "A source")]), "an item added");
  assert(base !== await disclosureHash([a, { ...b, marker: "cloud" }]), "a marker moved");
  assert(base !== await disclosureHash([a, { ...b, label: "A claim, reworded" }]), "a label changed");
  assert(base !== await disclosureHash([a, { ...b, id: "c2" }]), "an id changed");
});

Deno.test("itemsOf reads a request's recorded items defensively: malformed entries are dropped, a non-list is none", () => {
  const good = { type: "idea", id: "i", label: "L", marker: "private" };
  assertEquals(itemsOf({ source: { items: [good, { type: 1 }, null, { ...good, marker: "public" }, "x"] } }), [good]);
  assertEquals(itemsOf({ source: { items: "nope" } }), []);
  assertEquals(itemsOf({ transcript: { title: "t", turns: [] } }), []);
  assertEquals(itemsOf(null), []);
});

// createRequest over a fake Db: what it asks, and what a refusal looks like.
function fakeDb(rules: { team: boolean }) {
  const inserted: unknown[][] = [];
  const queries: string[] = [];
  const db: Db = {
    query: (sql: string, args: unknown[] = []) => {
      queries.push(sql);
      if (/FROM public\.podcast_teams/.test(sql)) return Promise.resolve((rules.team ? [{ id: "t1" }] : []) as never);
      if (/INSERT INTO public\.podcast_render_requests/.test(sql)) {
        inserted.push(args);
        return Promise.resolve([{ id: "r1" }] as never);
      }
      return Promise.resolve([] as never); // every other lookup finds nothing: the thing is not the caller's
    },
    tx: (fn) => fn(db),
  };
  return { db, inserted, queries };
}
const WHO = { sub: "user-a", actor: "user-a" };

Deno.test("createRequest: a transcript or a from, never both and never neither", async () => {
  const { db } = fakeDb({ team: true });
  await assertRejects(() => createRequest(db, WHO, { team_id: "t1", title: "T" }), Error, "either");
  await assertRejects(
    () => createRequest(db, WHO, { team_id: "t1", title: "T", transcript: { title: "t", turns: [] }, from: { kind: "idea", id: "x" } }),
    Error, "either",
  );
});

Deno.test("createRequest: another user's thing, a missing one and an id that cannot exist read as one refusal with one sentence", async () => {
  const { db, inserted } = fakeDb({ team: true });
  const messages = new Set<string>();
  for (const from of [
    { kind: "idea", id: crypto.randomUUID() }, { kind: "idea", id: "not-a-uuid" }, { kind: "run", id: crypto.randomUUID() },
    { kind: "report", id: crypto.randomUUID() }, { kind: "document", id: "documents/other/x.md" }, { kind: "topic", id: "content/none" },
  ]) {
    try {
      await createRequest(db, WHO, { team_id: "t1", title: "T", from }, { readOwnDocument: () => Promise.resolve(null) });
      throw new Error("resolved");
    } catch (e) {
      assertEquals((e as Error).constructor.name, "NotFound", JSON.stringify(from));
      messages.add((e as Error).message);
    }
  }
  assertEquals([...messages], [NO_INPUT], "one sentence for every kind");
  assertEquals(inserted.length, 0, "nothing is written when the input is not the caller's");
});

Deno.test("createRequest: discussion is registered, not usable: one answer whatever the id, and nothing is looked up", async () => {
  const { db, queries } = fakeDb({ team: true });
  const seen = new Set<string>();
  for (const id of [crypto.randomUUID(), "x", "y".repeat(100)]) {
    try {
      await createRequest(db, WHO, { team_id: "t1", title: "T", from: { kind: "discussion", id } });
    } catch (e) {
      assertEquals((e as Error).constructor.name, "Conflict");
      seen.add((e as Error).message);
    }
  }
  assertEquals(seen.size, 1);
  assert(!queries.some((q) => /ideas|research_jobs|wiki_pages/.test(q)), "no lookup for a kind that is not available");
});

Deno.test("createRequest: another user's team is refused before the input is looked at", async () => {
  const { db, queries } = fakeDb({ team: false });
  await assertRejects(() => createRequest(db, WHO, { team_id: "t9", title: "T", from: { kind: "idea", id: crypto.randomUUID() } }), Error, "no such team");
  assert(!queries.some((q) => /public\.ideas/.test(q)));
});

// ---- the share step, read from the sources ----
const here = new URL(".", import.meta.url);
async function read(rel: string) {
  return await Deno.readTextFile(new URL(rel, here));
}

Deno.test("nothing but the share step sets a podcast episode shared (workbench source and the podcast service)", async () => {
  const hits: string[] = [];
  async function walk(dir: URL, rx: RegExp) {
    for await (const e of Deno.readDir(dir)) {
      const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
      if (e.isDirectory) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        await walk(u, rx);
      } else if (/\.(ts|mjs|js)$/.test(e.name) && !/_test\.ts$|\.test\.ts$/.test(e.name)) {
        const text = await Deno.readTextFile(u);
        if (!/podcast_episodes|recordEpisode|voiceAndArchive/.test(text)) continue; // only files that write an episode
        text.split(/\r?\n/).forEach((l, i) => { if (rx.test(l) && !/^\s*\/\//.test(l)) hits.push(`${u.pathname.split("/").slice(-3).join("/")}:${i + 1}`); });
      }
    }
  }
  // a write that makes an episode shared: SET shared = true / shared: true on an episode record
  const rx = /(?<![{\w])shared\s*[:=]\s*(true|\$\d)/i;
  await walk(new URL("../", here), rx); // docker/workbench/src
  try {
    await walk(new URL("../../../../recipes/daily-digest/src/podcast/", here), rx);
  } catch { /* the recipes are not in this tree (the image build): the workbench half still ran */ }
  const own = hits.filter((h) => !h.startsWith("contracts/repo/podcasts.ts"));
  assertEquals(own, [], "only repo/podcasts.ts (setShared) writes shared = true");
});

Deno.test("the PATCH route shares only with the preview's digest; sharing is not a field of the create body", async () => {
  const schema = await read("./schemas/podcasts.ts");
  const body = schema.slice(schema.indexOf("export const RenderRequestBody"), schema.indexOf("export const RenderRequest ="));
  assert(!/shared|share_digest/.test(body), "the request body cannot ask for a shared episode");
  const repo = await read("./repo/podcasts.ts");
  const fn = repo.slice(repo.indexOf("export async function setShared"));
  assert(/digest !== await disclosureHash\(items\)/.test(fn), "the digest is compared with the list recomputed now");
  assert(fn.indexOf("disclosureHash") < fn.indexOf("SET shared = true"), "the check comes before the write");
  assert(/ownEpisode\(t, sub, id\)/.test(fn), "only the owner's own episode");
});
