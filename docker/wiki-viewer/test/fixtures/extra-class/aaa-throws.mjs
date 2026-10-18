// rw-p1a-render attempt 2 (tester near-miss N4): an entry whose resolve()
// throws on every request. It must be isolated: every page still renders
// from its own class (x-wiki-render: db, never "connecting"), and the health
// probe names the broken entry.
export default {
  name: "aaa-throws",
  version: 1,
  priority: 95,
  async resolve() {
    throw new Error("fixture: resolve() always throws");
  },
  async template() {
    return {};
  },
};
