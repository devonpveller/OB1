// The HTTP side of the P2a disposable run (rw-p2a-refs), run INSIDE a container on the run's
// internal network by run-references-tests.ps1. Never pointed at a live workbench.
//
//   capture   <base-url> <out.json>        note-refs + export (txt, wrap=none) for every note in
//                                         $NOTES (comma-separated vault paths), raw bodies
//   compare   <pre.json> <post.json>      the post-change capture against the pre-change one:
//                                         note-refs bodies byte-equal; exit 1 on any difference
//                                         (the per-note verdicts are printed). The export is
//                                         captured but no longer compared: research-workbench P6a
//                                         (rw-p6a-resolve) replaced its rendering with citeproc
//                                         over the same holder numbers, so the text differs by
//                                         design; references_test.ts / references_integration_test.ts
//                                         compare the NUMBERS, run-export-tests.ps1 the export.
//   diffcheck <base-url> <holder-ref> <out.json>
//                                         POST diff-check {holder} $RUNS times (after one warm-up)
//                                         and record every request and response byte: the network
//                                         log. Exit 1 unless every run answers 200 with
//                                         $EXPECT results, all out of date, in under 200 ms, and
//                                         no response byte contains $SENTINEL (the chunk text).
// The key is read from $WB_KEY and sent as X-Brain-Key, as Caddy does.
const [mode, a, b, c] = Deno.args;
const key = Deno.env.get("WB_KEY") ?? "";
const headers = { "x-brain-key": key, "content-type": "application/json" };

async function get(url: string) {
  const r = await fetch(url, { headers });
  return { status: r.status, type: (r.headers.get("content-type") || "").split(";")[0], body: await r.text() };
}

// The References section of a pandoc plain-text export: from the "References" heading line on.
export function referencesSection(txt: string): string {
  const lines = txt.split("\n");
  const i = lines.findIndex((l) => l.trim() === "References");
  return i === -1 ? "" : lines.slice(i).join("\n");
}

if (mode === "capture") {
  const base = a.replace(/\/+$/, "");
  const notes = (Deno.env.get("NOTES") ?? "").split(",").filter(Boolean);
  const out = [];
  for (const path of notes) {
    const q = encodeURIComponent(path);
    out.push({
      path,
      note_refs: await get(`${base}/workbench/note-refs?path=${q}`),
      export_txt: await get(`${base}/workbench/export?path=${q}&format=txt&wrap=none`),
    });
  }
  await Deno.writeTextFile(b, JSON.stringify(out, null, 2));
  console.log(`captured ${out.length} notes into ${b}`);
} else if (mode === "compare") {
  const pre = JSON.parse(await Deno.readTextFile(a)) as any[];
  const post = JSON.parse(await Deno.readTextFile(b)) as any[];
  let bad = 0;
  if (pre.length !== post.length) {
    console.log(`FAIL note count: pre ${pre.length}, post ${post.length}`);
    bad++;
  }
  for (const p of pre) {
    const q = post.find((x) => x.path === p.path);
    if (!q) {
      console.log(`FAIL ${p.path}: missing from the post-change capture`);
      bad++;
      continue;
    }
    const refsPre = p.note_refs.status === 200 ? JSON.parse(p.note_refs.body) : null;
    const counts = refsPre ? `added ${refsPre.added.length}, cited ${refsPre.cited.length}` : `status ${p.note_refs.status}`;
    const checks: [string, boolean][] = [
      ["note-refs status", p.note_refs.status === q.note_refs.status],
      ["note-refs body", p.note_refs.body === q.note_refs.body],
    ];
    const failed = checks.filter(([, ok]) => !ok).map(([n]) => n);
    const sec = referencesSection(p.export_txt.body);
    const numbered = (sec.match(/^\[\d+\]/gm) ?? []).length;
    console.log(`${failed.length ? "FAIL" : "PASS"} ${p.path}: ${counts}; References entries ${numbered}` +
      (failed.length ? `; differs: ${failed.join(", ")}` : ""));
    if (failed.length) {
      bad++;
      console.log(`  pre  refs: ${p.note_refs.body}\n  post refs: ${q.note_refs.body}`);
      console.log(`  pre  References:\n${sec}\n  post References:\n${referencesSection(q.export_txt.body)}`);
    }
  }
  Deno.exit(bad ? 1 : 0);
} else if (mode === "diffcheck") {
  const base = a.replace(/\/+$/, "");
  const runs = Number(Deno.env.get("RUNS") ?? "5");
  const expect = Number(Deno.env.get("EXPECT") ?? "200");
  const sentinel = Deno.env.get("SENTINEL") ?? "";
  const url = `${base}/workbench/contract/diff-check`;
  const reqBody = JSON.stringify({ holder: { kind: "legacy_note", ref: b } });
  await fetch(url, { method: "POST", headers, body: reqBody }).then((r) => r.text()); // warm-up
  const log = [];
  const failures: string[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = await fetch(url, { method: "POST", headers, body: reqBody });
    const text = await r.text();
    const ms = performance.now() - t0;
    const respHeaders = Object.fromEntries(r.headers.entries());
    log.push({ request: { method: "POST", url, headers: { "content-type": "application/json", "x-brain-key": "***" }, body: reqBody },
      response: { status: r.status, headers: respHeaders, bytes: text.length, body: text }, ms });
    let results: any[] = [];
    try {
      results = JSON.parse(text).results ?? [];
    } catch { /* not json */ }
    if (r.status !== 200) failures.push(`run ${i}: status ${r.status}`);
    if (results.length !== expect) failures.push(`run ${i}: ${results.length} results, expected ${expect}`);
    if (!results.every((x) => x.out_of_date === true)) failures.push(`run ${i}: a pin is not out of date`);
    if (ms >= 200) failures.push(`run ${i}: ${ms.toFixed(1)} ms`);
    if (sentinel && text.includes(sentinel)) failures.push(`run ${i}: chunk text in the response`);
  }
  const anchors: Record<string, number> = {};
  for (const x of JSON.parse(log[log.length - 1].response.body).results ?? []) anchors[x.anchor] = (anchors[x.anchor] ?? 0) + 1;
  // exactly one request per run reached the network: the log above is every byte exchanged
  await Deno.writeTextFile(c, JSON.stringify({ runs: log.length, ms: log.map((l) => Math.round(l.ms * 10) / 10), anchors, log }, null, 2));
  console.log(`diffCheck x${runs} over ${expect} references: ms ${log.map((l) => l.ms.toFixed(1)).join(", ")}; anchors ${JSON.stringify(anchors)}`);
  for (const f of failures) console.log(`FAIL ${f}`);
  Deno.exit(failures.length ? 1 : 0);
} else {
  console.error("usage: references-client.ts capture|compare|diffcheck ...");
  Deno.exit(2);
}
