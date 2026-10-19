// node --test recipes/_shared/llm-call.test.mjs
// D13 item 6 failure classes against a local stub endpoint: transient is
// retried N=3 (never a fourth), then the endpoint check picks the
// notification; structural is never retried.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const st = { mode: "ok", n: 3, modelsOk: true, chat: 0 };
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/v1/models") return st.modelsOk ? send(200, { data: [{ id: "m" }] }) : send(503, {});
    if (req.url === "/health/liveliness") return st.modelsOk ? send(200, "ok") : send(503, {});
    if (req.url === "/v1/chat/completions") {
      st.chat++;
      if (st.mode === "fail") return send(503, { error: "down" });
      if (st.mode === "flaky" && st.chat <= st.n) return send(503, { error: "flaky" });
      if (st.mode === "bad") return send(200, { choices: [{ message: { content: "no heading here" } }] });
      if (st.mode === "400") return send(400, { error: "bad request" });
      return send(200, { choices: [{ message: { content: "# Page\n\n## Summary\n\nok" } }] });
    }
    send(404, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const out = mkdtempSync(join(tmpdir(), "llm-call-"));
process.env.OPEN_BRAIN_URL = "http://127.0.0.1:9"; // no contract sink: the ledger file is used
process.env.LLM_RETRY_BACKOFF_MS = "1";
const { chatComplete, parseEntityReply, CompileError, _resetLlmForTests } = await import("./llm-call.mjs");
const { _resetNotifyForTests, notifyFile } = await import("./compile-notify.mjs");
test.after(() => server.close());

const call = (task = "entity-1") => chatComplete({ baseUrl: base, apiKey: "k", model: "m", task, outDir: out, messages: [], parse: parseEntityReply });
const notes = () => (existsSync(notifyFile(out)) ? readFileSync(notifyFile(out), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
const reset = (mode, extra = {}) => { Object.assign(st, { mode, n: 3, modelsOk: true, chat: 0 }, extra); _resetLlmForTests(); _resetNotifyForTests(); };

test("503 three times then success: the page lands, 4 calls, no notification", async () => {
  reset("flaky");
  const before = notes().length;
  assert.equal(await call(), "# Page\n\n## Summary\n\nok");
  assert.equal(st.chat, 4);
  assert.equal(notes().length, before);
});

test("failing throughout with /v1/models failing: exactly one 'model unavailable', transient, no 5th call", async () => {
  reset("fail", { modelsOk: false });
  const before = notes().length;
  await assert.rejects(call("entity-2"), (e) => e instanceof CompileError && e.kind === "transient");
  assert.equal(st.chat, 4, "1 call + 3 retries, never a fourth retry");
  await assert.rejects(call("entity-3"), (e) => e.kind === "transient");
  assert.equal(st.chat, 4, "after a model-unavailable verdict the run does not call again");
  const n = notes().slice(before);
  assert.equal(n.length, 1);
  assert.equal(n[0].subject, "model unavailable: m");
  assert.equal(n[0].class, "transient");
});

test("failing throughout with /v1/models healthy: 'LLM call failing for this task'", async () => {
  reset("fail", { modelsOk: true });
  const before = notes().length;
  await assert.rejects(call("entity-4"), (e) => e.kind === "transient");
  const n = notes().slice(before);
  assert.equal(n.length, 1);
  assert.equal(n[0].subject, "LLM call failing for this task: entity-4");
});

test("a reply the page parser rejects is structural and is not retried", async () => {
  reset("bad");
  await assert.rejects(call(), (e) => e instanceof CompileError && e.kind === "structural" && /page parser/.test(e.message));
  assert.equal(st.chat, 1);
});

test("a refused request (4xx) is structural, not retried", async () => {
  reset("400");
  await assert.rejects(call(), (e) => e.kind === "structural");
  assert.equal(st.chat, 1);
});

test("parseEntityReply: unwraps a fence, drops chatter before the H1, rejects frontmatter / no heading", () => {
  assert.equal(parseEntityReply("Sure!\n\n# X\n\n## S"), "# X\n\n## S");
  assert.equal(parseEntityReply("```markdown\n# X\nbody\n```"), "# X\nbody");
  assert.throws(() => parseEntityReply("---\ntitle: x\n---\n# X"), /frontmatter/);
  assert.throws(() => parseEntityReply("no heading at all"), /heading/);
});
