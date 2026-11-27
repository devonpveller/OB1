// Dredd hooks for the retrieval contract (rw-p0-contract).
//
// 1. Only the SUCCESS example of an operation is exercisable from its example request: the
//    documented 400/404/409/422/500 shapes cannot be produced by the same request, so those
//    transactions are skipped (the Deno integration test exercises the refusals).
// 2. The calls whose backing lands in a later phase document a typed 501 not_implemented as
//    their only response; those ARE checked ("a 404 or an unschema'd stub FAILS").
// 3. The session stream is text/event-stream, which Dredd compares byte for byte with the
//    example; the live body carries real timestamps, the recorded example normalised ones, so
//    the timestamps are normalised the same way before validation. Nothing else is touched.
const hooks = require('hooks');

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g;

// 4. P4b (rw-p4b-sessions): steer and cancel act through the research service, which the Dredd lab
//    does not run; contract-test/run-sessions-tests.ps1 exercises them against the real one.
const NEEDS_RESEARCH = /\/sessions\/\{id\}\/(steer|cancel)/;
// 5. rw-p8a2-cleanup: the cleanup view's WRITES (sever / erase / process-all / lift) act on the same fixture
//    rows as the D5 single-source examples (sever 44444444, erase 33333333), so whichever ran second would 409;
//    src/contracts/cleanup_integration_test.ts exercises them on rows of its own (run-workspace-tests.ps1 [5a2]).
//    One read is skipped too: GET /cleanup/actions/{id} is a per-user row the fixture does not seed (by id it
//    is the caller's own or 404). The other cleanup READS are checked here.
const CLEANUP_WRITE = /\/cleanup\/(sources\/\{id\}\/(sever|erase)|process-all|tombstones\/\{id\}\/lift|actions\/\{id\})/;

// 7. rwr-flags-api: a flag by id is a per-user row the fixture does not seed (the caller's own or 404); GET/PATCH /flags/{id}
//    are exercised by src/contracts/flags_integration_test.ts (run-flags-tests.ps1). Create and list are checked here.
const FLAG_BY_ID = /\/flags\/\{id\}/;

// 9. rwr-doc-toplace-api (slot 630): DELETE /documents/pending-refs/{id} and POST .../{id}/place act on a queue row by id - a
//    per-user row the fixture does not seed (the caller's own or 404). The integration test (src/contracts/toplace_integration_test.ts,
//    run-toplace-tests.ps1) exercises both; the list and the add are checked here (the add names the fixture document).
const PENDING_BY_ID = /\/documents\/pending-refs\/\{id\}/;

// 6. rw-inlet-stamp (slot 470): the podcast model's fixtures belong to a real-shaped lab subject, lab-podcaster-0001 (an
//    owner is never the literal 'operator'); its operations are called as that subject through the seam's test
//    identity header (the lab workbench runs with WORKSPACE_IDENTITY_HEADER=X-Test-Sub).
// 7. rwr-research-start-api: POST /workbench/research and /research/preview act through the research service's request
//    boundary (the Dredd lab runs none); src/contracts/research_start_test.ts (fakes) and the research service's
//    start.e2e.test.ts (the real door over a lab database) exercise them.
// round 2 (tester attempt 1): exactly these two operations - POST of the two paths, matched on the request itself,
// never a future /workbench/research/... route (run-contract-tests.ps1 counts the same two in $hookSkipped)
const RESEARCH_START_URI = /^\/workbench\/research(\/preview)?(\?|$)/;
const isResearchStart = (t) => !!(t && t.request && String(t.request.method || '').toUpperCase() === 'POST' &&
  RESEARCH_START_URI.test(String(t.request.uri || '')));

// 9. rwr-doc-gaps-api (slot 650): a gap is a per-user row on the caller's own document, and 'research these' acts through the
//    research service (the Dredd lab runs none and the fixtures own no document of the Dredd identity). Only the list GET is
//    checked here; create, by-id GET/PATCH/DELETE and research are exercised by src/contracts/gaps_integration_test.ts
//    (run-gaps-tests.ps1). run-contract-tests.ps1 counts the same five skipped operations.
const GAPS_URI = /\/workbench\/contract\/gaps(\/|\?|$)/;
const GAPS_LIST = /\/workbench\/contract\/gaps(\?[^/]*)?$/;
const isGapSkipped = (t) => !!(t && t.request && GAPS_URI.test(String(t.request.uri || '')) &&
  !(String(t.request.method || '').toUpperCase() === 'GET' && GAPS_LIST.test(String(t.request.uri || ''))));

const PODCAST_MODEL = /\/(podcasts|presenters|teams)(\/|$| )/;

// 8. rwr-cast-edit-api (slot 560): the cast routes' fixtures (schemas/cast.ts CX) belong to their own lab subject,
//    lab-caster-0001 (lab-caster-0002 owns the shared pool's rows the copy examples use); every /cast/ operation is
//    called as lab-caster-0001. Every one of them is checked (none is skipped): the DELETE examples remove *-del rows.
const CAST = /\/workbench\/contract\/cast\//;
// rwr-voices: the voice sample (POST /cast/voices/{id}/sample) answers a WAV that openbrain-podcast voices. Only a lab that runs the podcast
// stand-in (run-cast-tests.ps1: contract-test/stub-podcast.ts, DREDD_SAMPLE=1) checks it; every other lab has no podcast service, the route
// answers its documented 503 there, and the hooks skip it (run-contract-tests.ps1 counts that one operation in $hookSkipped).
const isSampleSkipped = (t) => process.env.DREDD_SAMPLE !== '1' && /\/cast\/voices\/\{id\}\/sample/.test(String((t && t.name) || ''));

// 7. rw-owner-private-view (slot 480): the owner's private views answer the signed-in owner only (or the configured
//    default identity while sign-in is off). The Dredd workbench has neither (no WORKSPACE_DEFAULT_SUB), so the three
//    list / search ops are checked on their (empty) 200 shape here, and the two by-id reads - an owner's row or the
//    unknown-id 404 - are skipped, like the per-user cleanup action above. run-workspace-tests.ps1 [5s]
//    (src/inlet/owner_private_view_integration_test.ts) exercises them as the owner, as other users and per identity mode.
const PRIVATE_BY_ID = /\/private\/(claims|jobs)\/\{id\}/;

// 8. rwr-idea-archive-api: archive / reopen act on an idea of the caller's own; the fixture idea bbbbbbbb-...-bbb4 is owned
//    by the lab subject lab-ideas-0001 (fixtures.sql), so these two are called as that subject; they run in document
//    order (archive, then reopen), which leaves the idea as it was.
const IDEA_REST = /\/ideas\/\{id\}\/(archive|reopen)/;

// 9. rw-settings-registry-tier: the OpenAPI examples for GET and PUT /settings/{key} show a user-tier key (the document is public and the
//    registry hides admin-tier entries from a person who is not an admin); the Dredd lab's settings registry holds only the fixture
//    key, so these two transactions are pointed back at it, and the PUT carries a destination that key accepts.
const SETTING_SHOWN = '/settings/refinery.dormancy_days';
const SETTING_FIXTURE = '/settings/podcast.archive_destination';

hooks.beforeEach((transaction, done) => {
  if (transaction.request && String(transaction.request.uri || '').endsWith(SETTING_SHOWN)) {
    transaction.fullPath = String(transaction.fullPath || '').replace(SETTING_SHOWN, SETTING_FIXTURE);
    transaction.request.uri = String(transaction.request.uri).replace(SETTING_SHOWN, SETTING_FIXTURE);
    if (String(transaction.request.method || '').toUpperCase() === 'PUT') {
      transaction.request.body = JSON.stringify({ value: { path: '/mounts/podcast-archive/alt' }, by: 'dredd' });
    }
  }
  if (IDEA_REST.test(String(transaction.name || '')) && transaction.request && transaction.request.headers) {
    transaction.request.headers['X-Test-Sub'] = 'lab-ideas-0001';
  }
  if (PODCAST_MODEL.test(String(transaction.name || '')) && transaction.request && transaction.request.headers) {
    transaction.request.headers['X-Test-Sub'] = 'lab-podcaster-0001';
  }
  if (CAST.test(String(transaction.name || '')) && transaction.request && transaction.request.headers) {
    transaction.request.headers['X-Test-Sub'] = 'lab-caster-0001';
  }
  const code = String(transaction.expected && transaction.expected.statusCode);
  transaction.skip = !(/^2\d\d$/.test(code) || code === '501') || NEEDS_RESEARCH.test(String(transaction.name || '')) || CLEANUP_WRITE.test(String(transaction.name || '')) || FLAG_BY_ID.test(String(transaction.name || '')) || PENDING_BY_ID.test(String(transaction.name || '')) || PRIVATE_BY_ID.test(String(transaction.name || '')) || isResearchStart(transaction) || isGapSkipped(transaction) || isSampleSkipped(transaction);
  done();
});

hooks.beforeEachValidation((transaction, done) => {
  const type = (transaction.real && transaction.real.headers && transaction.real.headers['content-type']) || '';
  if (type.indexOf('text/event-stream') === 0 && typeof transaction.real.body === 'string') {
    transaction.real.body = transaction.real.body.replace(ISO, '2026-10-17T12:00:00.000Z');
  }
  done();
});
