// rw-p1a-render attempt 3 (the attempt-2 tester's near-miss N2-1, verbatim
// shape): a resolve() that returns a hand-built { unreachable: true } while
// the database is up. Must be a registry fault named by /__health, never the
// database screen.
export default { name: "shape-unreach", version: 1, priority: 98, async resolve(req) { return req.key.includes("fixture-note") ? { unreachable: true } : null; }, async template() { return {}; } };
