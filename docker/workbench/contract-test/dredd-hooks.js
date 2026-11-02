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

hooks.beforeEach((transaction, done) => {
  const code = String(transaction.expected && transaction.expected.statusCode);
  transaction.skip = !(/^2\d\d$/.test(code) || code === '501') || NEEDS_RESEARCH.test(String(transaction.name || '')) || CLEANUP_WRITE.test(String(transaction.name || ''));
  done();
});

hooks.beforeEachValidation((transaction, done) => {
  const type = (transaction.real && transaction.real.headers && transaction.real.headers['content-type']) || '';
  if (type.indexOf('text/event-stream') === 0 && typeof transaction.real.body === 'string') {
    transaction.real.body = transaction.real.body.replace(ISO, '2026-10-17T12:00:00.000Z');
  }
  done();
});
