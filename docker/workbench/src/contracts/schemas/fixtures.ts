// The ids the OpenAPI examples use. They are the rows contract-test/fixtures.sql seeds, so
// the Dredd run (contract-test/run-contract-tests.ps1) exercises every example against real
// data in a disposable database. Change one here and the fixture together.
export const FX = {
  at: "2026-10-17T12:00:00.000Z",
  thread: "0a000000-0000-4000-8000-0000000000a1",
  sourceActive: "11111111-1111-4111-8111-111111111111",
  sourceSuppressed: "22222222-2222-4222-8222-222222222222",
  sourceUnlinked: "33333333-3333-4333-8333-333333333333",
  sourceToSever: "44444444-4444-4444-8444-444444444444",
  sourceErased: "55555555-5555-4555-8555-555555555555",
  sourceToSuppress: "d0000000-0000-4000-8000-0000000000d1",
  sourceDocLinked: "d0000000-0000-4000-8000-0000000000d2",
  sourceLead: "d0000000-0000-4000-8000-0000000000d3",
  tombstoneAutomation: "66666666-6666-4666-8666-666666666666",
  tombstoneToLift: "66666666-6666-4666-8666-666666666667",
  erasedUrl: "https://example.org/erased",
  liftUrl: "https://example.org/lift-me",
  synthesis: "77777777-7777-4777-8777-777777777777",
  session: "88888888-8888-4888-8888-888888888888",
  job: "99999999-9999-4999-8999-999999999999",
  importJob: "99999999-9999-4999-8999-99999999999a",
  claim: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  idea: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  heldLinked: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
  heldRemovable: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
  document: "e0000000-0000-4000-8000-0000000000e1",
  documentPath: "documents/fixture-refinery.md",
  pageEntity: "content/tool/tool-fixture",
  pageLeafActive: "content/source/11111111-1111-4111-8111-111111111111",
  notification: "f0000000-0000-4000-8000-0000000000f1",
  watch: "f0000000-0000-4000-8000-0000000000f2",
  // research-workbench P2a (fixtures.sql, "P2a" block)
  refSource: "f1000000-0000-4000-8000-000000000001", // active, revision 2; revision 1 is pinned below
  refPdf: "f1000000-0000-4000-8000-000000000002", // content_type pdf
  referenceSpan: "f2000000-0000-4000-8000-000000000001", // span on refSource, pinned at 1 (out of date)
  referenceCurrent: "f2000000-0000-4000-8000-000000000002", // span on refSource, pinned at 2 (current)
  refNotePath: "notes/p2a/fixture-note.md", // a legacy note holding referenceSpan (the user document holds referenceCurrent)
} as const;
