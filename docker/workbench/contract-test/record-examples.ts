// Record the OpenAPI examples from a workbench served over contract-test/fixtures.sql
// (rw-p0-contract). Writes src/contracts/schemas/examples.ts; then run `deno task contract:gen`.
//
//   run-contract-tests.ps1 -RecordExamples      (starts the disposable stack and calls this)
//   deno run --allow-net --allow-write=<file> record-examples.ts <base-url> <key> <out-file>
//
// The order matters: reads first, then the writes (each against its own fixture row), so every
// example is the response the fixture really produces. Timestamps are normalised and the two
// generated ids are pinned, so a re-record over the same fixture is byte-stable.
const [base, key, outFile] = Deno.args;
if (!base || !key || !outFile) {
  console.error("usage: record-examples.ts <base-url> <key> <out-file>");
  Deno.exit(2);
}
const B = `${base.replace(/\/+$/, "")}/workbench/contract`;
const F = {
  a: "11111111-1111-4111-8111-111111111111", s: "22222222-2222-4222-8222-222222222222",
  idea: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", job: "99999999-9999-4999-8999-999999999999",
  tb: "66666666-6666-4666-8666-666666666666",
  // P2a
  refSrc: "f1000000-0000-4000-8000-000000000001", refSpan: "f2000000-0000-4000-8000-000000000001",
  note: "notes/p2a/fixture-note.md",
};
type Req = [string, string, string, unknown?];
const reads: Req[] = [
  ["reference", "GET", `/references/${F.a}?version=2`], ["referenceSuppressed", "GET", `/references/${F.s}`],
  ["chunkContext", "GET", `/chunks/${F.a}:1/context?window=1`],
  // P2a: one reference record (out of date, its quote found again) and one bare pin (P0's form)
  ["diffCheck", "POST", `/diff-check`, { references: [{ reference_id: F.refSpan }, { source_id: F.a, revision: 1, chunk_idx: 1 }] }],
  ["referenceRecord", "GET", `/references/${F.refSpan}`],
  ["holderReferences", "GET", `/holders/legacy_note/references?ref=${encodeURIComponent(F.note)}`],
  ["quality", "GET", `/sources/${F.a}/quality`], ["neighbours", "GET", `/neighbours?id=content/tool/tool-fixture&depth=1`],
  ["claims", "GET", `/claims?source_id=${F.a}`],
  ["search", "GET", `/search?q=contract&kinds=page,claim,source&refinery_id=${F.idea}`],
  ["timeline", "GET", `/timeline?limit=3`], ["trail", "GET", `/trail?source_id=${F.s}`],
  ["session", "GET", `/sessions/${F.job}`], ["jobs", "GET", `/jobs?limit=2`],
  ["dependence", "GET", `/sources/${F.s}/dependence`], ["tombstone", "GET", `/tombstones/${F.tb}`],
  ["ideas", "GET", `/ideas`], ["idea", "GET", `/ideas/${F.idea}`], ["documents", "GET", `/documents`],
  ["notifications", "GET", `/notifications`], ["settings", "GET", `/settings`], ["registries", "GET", `/registries`],
  ["registry", "GET", `/registries/notification_classes`],
  // before the PUT below, as Dredd runs it: the default (the named mount)
  ["setting", "GET", `/settings/podcast.archive_destination`],
  // P7a
  ["podcasts", "GET", `/podcasts`], ["presenters", "GET", `/presenters`], ["teams", "GET", `/teams`],
  ["podcastRequests", "GET", `/podcasts/requests`],
];
const writes: Req[] = [
  ["suppress", "POST", `/sources/d0000000-0000-4000-8000-0000000000d1/suppress`, { reason: "superseded by a better source", by: "dredd" }],
  ["sever", "POST", `/sources/44444444-4444-4444-8444-444444444444/sever`, { kind: "chunk", ref: "0", by: "dredd" }],
  ["erase", "POST", `/sources/33333333-3333-4333-8333-333333333333/erase`, { reason_type: "deliberate", note: "removed in the contract test", eraser: { kind: "user", user: "dredd" } }],
  ["lifted", "POST", `/tombstones/66666666-6666-4666-8666-666666666667/lift`, { by: "dredd", note: "reconsidered" }],
  ["admission", "POST", `/admission`, { url: "https://example.org/erased", path: "intake", session_id: "dredd-session", candidate: { title: "Erased fixture source", content: "Returned text." } }],
  ["hidden", "POST", `/ideas/${F.idea}/hidden`, { node_kind: "source", node_ref: F.a, hidden: true }],
  ["userSourceAdded", "POST", `/ideas/${F.idea}/user-sources`, { title: "A user-provided note on retrieval", content: "User provided text. Second sentence.", url: "https://example.org/user-added" }],
  ["userSourceRemoved", "DELETE", `/ideas/${F.idea}/user-sources/cccccccc-cccc-4ccc-8ccc-ccccccccccc2`],
  ["settingWritten", "PUT", `/settings/podcast.archive_destination`, { value: { path: "/mounts/podcast-archive-alt" }, by: "dredd" }],
  ["steer", "POST", `/sessions/${F.job}/steer`, { step_id: "s1", text: "narrow to erasure" }],
  // P7a: a render request by the fixture team (PODCAST_RENDER_URL blank in the lab: it stays queued)
  ["podcastRequest", "POST", `/podcasts/requests`, {
    team_id: "pod-fx-team", title: "A recorded request",
    transcript: { title: "A recorded request", turns: [{ presenterId: "pod-fx-presenter-a", text: "Good morning." }, { presenterId: "pod-fx-presenter-b", text: "Morning!" }] },
  }],
  // P2a: place a reference held by the fixture user document
  ["referenceCreated", "POST", `/references`, {
    source_id: F.refSrc, provenance: "user", scope: "span",
    selectors: { quote: { exact: "Opening line of the reference fixture.", prefix: "", suffix: " The quoted span about pinned an" }, position: { start: 0, end: 38 } },
    holder: { kind: "user_document", ref: "documents/fixture-refinery.md", origin: "cited" }, by: "dredd",
  }],
];
const TS = /^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:\d{2})$/;
function norm(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
  if (typeof v === "string" && TS.test(v)) return "2026-10-17T12:00:00.000Z";
  if (typeof v === "number" && !Number.isInteger(v)) return Math.round(v * 1000) / 1000;
  return v;
}
const ex: Record<string, any> = {};
const reqs: Record<string, unknown> = {};
for (const [name, method, path, body] of [...reads, ...writes]) {
  const r = await fetch(B + path, {
    method, headers: { "content-type": "application/json", "x-brain-key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (r.status >= 400 && r.status !== 501) throw new Error(`${name}: HTTP ${r.status} ${await r.text()}`);
  ex[name] = norm(await r.json());
  if (body !== undefined) reqs[name] = body;
}
const stream = (await (await fetch(`${B}/sessions/${F.job}/stream`, { headers: { "x-brain-key": key } })).text())
  .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, "2026-10-17T12:00:00.000Z");
ex.erase.tombstone.id = "66666666-6666-4666-8666-666666666668";
ex.userSourceAdded.source.source_id = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
ex.referenceCreated.record.id = "f2000000-0000-4000-8000-0000000000c1";
ex.podcastRequest.id = "e8000000-0000-4000-8000-0000000000c1";
if (ex.referenceCreated.held) ex.referenceCreated.held.reference_id = "f2000000-0000-4000-8000-0000000000c1";
for (const [k, f] of [["timeline", "events"], ["trail", "entries"], ["jobs", "jobs"], ["notifications", "notifications"], ["registries", "registries"], ["ideas", "ideas"]]) {
  ex[k][f] = ex[k][f].slice(0, 3);
}
delete ex.steer;
const lines = [
  "// Response and request examples for the OpenAPI document. RECORDED from the contract",
  "// served over contract-test/fixtures.sql by contract-test/record-examples.ts (timestamps",
  "// normalised; two generated ids pinned), so every example is a real response shape over the",
  "// same rows Dredd runs against. The conformance test validates each example against its schema.",
  "// Re-record (run-contract-tests.ps1 -RecordExamples) instead of hand-editing one key.",
  "// deno-lint-ignore-file",
  "",
  "export const EX = {",
  ...Object.entries(ex).map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`),
  `  stream: ${JSON.stringify(stream)},`,
  `  suppressRequest: ${JSON.stringify(reqs.suppress)},`,
  `  severRequest: ${JSON.stringify(reqs.sever)},`,
  `  eraseRequest: ${JSON.stringify(reqs.erase)},`,
  `  liftRequest: ${JSON.stringify(reqs.lifted)},`,
  `  admissionRequest: ${JSON.stringify(reqs.admission)},`,
  `  hiddenRequest: ${JSON.stringify(reqs.hidden)},`,
  `  userSourceAddRequest: ${JSON.stringify(reqs.userSourceAdded)},`,
  `  settingWrite: ${JSON.stringify(reqs.settingWritten)},`,
  `  steerRequest: ${JSON.stringify(reqs.steer)},`,
  `  diffCheckRequest: ${JSON.stringify(reqs.diffCheck)},`,
  `  referenceCreateRequest: ${JSON.stringify(reqs.referenceCreated)},`,
  `  podcastRequestBody: ${JSON.stringify(reqs.podcastRequest)},`,
  "  notImplemented: (operation: string, landsIn: string) => ({",
  "    status: \"not_implemented\", operation, lands_in: landsIn,",
  "    message: `${operation} is part of the contract; its backing lands in ${landsIn}`,",
  "  }),",
  "};",
  "",
];
await Deno.writeTextFile(outFile, lines.join("\n"));
console.log(`recorded ${Object.keys(ex).length} examples into ${outFile}`);
