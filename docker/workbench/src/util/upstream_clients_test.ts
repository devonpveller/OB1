// deno test --allow-all src/util/upstream_clients_test.ts - rw-identity-harden2 round 2 (tester t-id-harden2 D8).
// The rule is structural, not a spelling: a workbench client of another service never hands its caller that
// service's error text. EVERY place the workbench calls a sibling service (every `fetch(` under src/, outside
// tests) is in CLIENTS below. Each is driven against a stub whose answer to anything is HTTP 500 with a marker
// in its JSON `detail` / `error` / `message`, its headers and its text; the test asserts the marker (and the
// path / credential words that ride with it) is nowhere in what the client returns or throws - message,
// cause and stack included. A guard test fails when a `fetch(` call site appears that is not in the table.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { researchActions } from "../sessions/client.ts";
import { researchClient } from "../documents/clients.ts";
import { gateClient } from "../fetch-gate/client.ts";
import { httpScorer } from "../contracts/logic/reopen.ts";
import { createResolver } from "../export/resolver.ts";
import { parseCitekey } from "../export/identifiers.ts";
import type { IdentifierKind } from "../export/identifiers.ts";
import { fxEntries } from "../export/registry_fixtures.ts";
import { visionPass } from "../export/vision.ts";
import { chatCall } from "../rooms/chat.ts";
import { embed } from "../util/embed.ts";
import { rest } from "../db/rest.ts";
import { callExtract } from "../routes/import.ts";
import { nav } from "../routes/nav.ts";
import { sources } from "../routes/sources.ts";
import { steerFailure } from "../contracts/routes/sessions.ts";

const MARK = "MARKER-5xx-detail /var/lib/service/x.sql password=hunter2";
const HIDDEN = ["MARKER-5xx", "/var/lib/service", "hunter2"];

const realFetch = globalThis.fetch;
const stubFetch = (status = 500) =>
  (globalThis.fetch = ((_u: unknown, _i?: unknown) =>
    Promise.resolve(new Response(JSON.stringify({ error: MARK, detail: MARK, message: MARK, reason: MARK }), {
      status, headers: { "content-type": "application/json", "x-detail": MARK },
    }))) as typeof fetch);

// everything a caller can see of an outcome: a returned value, or a thrown error with message, cause and stack
async function seen(f: () => unknown): Promise<string> {
  const keep = [console.error, console.warn];
  console.error = () => {};
  console.warn = () => {};
  try {
    const v = await f();
    return v instanceof Response ? `${v.status} ${[...v.headers].join(" ")} ${await v.text()}` : JSON.stringify(v) ?? "undefined";
  } catch (e) {
    const x = e as Error & { cause?: unknown };
    return `THROWN ${x?.name}: ${x?.message} ${String(x?.cause ?? "")} ${x?.stack ?? ""} ${JSON.stringify(e)}`;
  } finally {
    [console.error, console.warn] = keep;
  }
}

const KINDS: IdentifierKind[] = fxEntries("reference_identifier_kinds").map((e) => ({ key: e.key, ...e.definition }) as IdentifierKind);
const png = new Uint8Array([137, 80, 78, 71]);
const env = (m: Record<string, string>) => (k: string) => m[k];
const RS = env({ RESEARCH_URL: "http://r.stub", RESEARCH_WORKSPACE_KEY: "k" });
const WHO = { sub: "a", actor: "a", admin: false };

// file (relative to src/) -> how many `fetch(` call sites it holds, and the drivers that exercise them
export const CLIENTS: Record<string, { sites: number; drive: { name: string; run: () => unknown }[] }> = {
  "sessions/client.ts": {
    sites: 1, drive: [
      { name: "research steer, then the route's answer", run: async () => steerFailure(await researchActions(RS)!.steer("j", { step_id: "s", text: "t" }, WHO)) },
      { name: "research steer (raw)", run: () => researchActions(RS)!.steer("j", { step_id: "s", text: "t" }, WHO) },
      { name: "research cancel", run: () => researchActions(RS)!.cancel("j", null, WHO) },
    ],
  },
  "documents/clients.ts": { sites: 1, drive: [{ name: "research enqueue", run: () => researchClient(RS)!({ query: "q" }) }] },
  "fetch-gate/client.ts": {
    sites: 1, drive: [{ name: "search gate /v1/fetch", run: () => gateClient(env({ WORKBENCH_GATE_URL: "http://g.stub", WORKBENCH_GATE_KEY: "k" }))("https://e.org/a") }],
  },
  "export/resolver.ts": {
    sites: 1, drive: [{
      name: "OpenAlex + Crossref resolver", run: () => {
        const r = createResolver({ openalexKey: "k", mailto: "m@e.invalid", proxyUrl: "http://p.stub", openalexBase: "http://a.stub", crossrefBase: "http://c.stub", timeoutMs: 2000 },
          { fetch: (u, i) => fetch(u, i), buildClient: () => ({ close() {} }) as unknown as Deno.HttpClient, log: () => {} });
        const id = parseCitekey(KINDS, "doi:10.5555/x.1");
        return r.resolve(id, KINDS.find((k) => k.key === id.kind)!);
      },
    }],
  },
  "export/vision.ts": {
    sites: 1, drive: [{
      name: "export vision pass", run: () => visionPass({ state: "on", url: "http://llama-cpp:8080/v1", key: "k", model: "m", timeoutMs: 2000 } as never, [{ page: 1, png }]),
    }],
  },
  "rooms/chat.ts": {
    sites: 1, drive: [{
      name: "room scoped chat", run: () => chatCall({ state: "on", url: "http://llama-cpp:8080/v1", key: "k", model: "m", timeoutMs: 2000 }, [], "q", []),
    }],
  },
  "util/embed.ts": { sites: 1, drive: [{ name: "embedding endpoint", run: () => embed("hello") }] },
  "db/rest.ts": {
    sites: 2, drive: [{ name: "PostgREST read", run: () => rest.get("things", "select=*") }, { name: "PostgREST health", run: () => rest.restHealthy() }],
  },
  "routes/import.ts": { sites: 1, drive: [{ name: "extractor (import)", run: () => callExtract(new Uint8Array([1]), "a.pdf") }] },
  "routes/sources.ts": {
    sites: 1, drive: [{
      name: "extractor (replace-from-upload)", run: () => {
        const fd = new FormData();
        fd.append("file", new File([new Uint8Array([1])], "a.pdf"));
        return sources.request("/s1/replace-from-upload", { method: "POST", body: fd });
      },
    }],
  },
  "routes/nav.ts": { sites: 1, drive: [{ name: "viewer nav forwarder", run: () => nav.request("/?folder=x") }] },
  // fire-and-forget: the render service's answer is `r.body?.cancel()`, never read (asserted on the source below)
  "contracts/routes/podcasts.ts": { sites: 1, drive: [] },
};

for (const [file, c] of Object.entries(CLIENTS)) {
  for (const d of c.drive) {
    Deno.test(`D8 client table: ${file} - ${d.name}: a 500 whose body carries a marker leaves no marker in what the client returns or throws`, async () => {
      stubFetch(500);
      try {
        const out = await seen(d.run);
        for (const h of HIDDEN) assert(!out.includes(h), `${file} (${d.name}) hands its caller the upstream text (${h}): ${out.slice(0, 400)}`);
        assert(out.length > 0);
      } finally {
        globalThis.fetch = realFetch;
      }
    });
  }
}

Deno.test("D8 client table: the D15 scorer (injected fetch) and the podcast hand-off", async () => {
  const out = await seen(() =>
    httpScorer("http://s.stub", "k", (_u, _i) => Promise.resolve(new Response(JSON.stringify({ error: "score_failed", detail: MARK }), { status: 500 })))
      .score({ url: "u", title: "t", content: "c", content_type: "web" })
  );
  for (const h of HIDDEN) assert(!out.includes(h), out);
  const src = await Deno.readTextFile(new URL("../contracts/routes/podcasts.ts", import.meta.url));
  const call = /fetch\(url,[\s\S]*?\.catch\(/.exec(src)?.[0] ?? "";
  assert(/\.then\(\(r\) => r\.body\?\.cancel\(\)\)/.test(call), "podcast hand-off: the answer is read somewhere");
});

Deno.test("D8 guard: every `fetch(` call site under src/ is in the client table (a new one fails here until it is added and driven)", async () => {
  const root = new URL("../", import.meta.url);
  const found = new Map<string, number>();
  const walk = async (dir: URL) => {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) await walk(new URL(`${e.name}/`, dir));
      else if (e.name.endsWith(".ts") && !e.name.endsWith("_test.ts") && !/(fixtures|test_proxy|_oracle)\.ts$/.test(e.name)) {
        const u = new URL(e.name, dir);
        const n = (await Deno.readTextFile(u)).split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "")).filter((l) => /(?<![.\w])fetch\(/.test(l)).length;
        if (n) found.set(u.href.slice(root.href.length), n);
      }
    }
  };
  await walk(root);
  const known = Object.fromEntries(Object.entries(CLIENTS).filter(([, c]) => c.sites > 0).map(([f, c]) => [f, c.sites]));
  assertEquals(Object.fromEntries([...found].sort()), Object.fromEntries(Object.entries(known).sort()),
    "a fetch( call site is not in the client table (or the table lists one that is gone)");
});
