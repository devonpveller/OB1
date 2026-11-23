// Stub workbench for the Start research e2e lab: the reads the shell makes, the caller's own documents (ALPHA is
// alice's, BRAVO is bob's), the owner-scoped state / file routes (anything that is not the caller's own is the SAME
// 404 as a missing one), and the two research routes with a fake request boundary: the question that leaves is made
// from the typed words only, never from a document's text (the real boundary has its own lab; this stub only lets the
// UI be seen to send nothing but what it showed).
//   POST /__mode/<alice|bob>   who the next requests belong to
//   GET  /__log                every request seen: method, url, mode, door key present, parsed body
//   GET  /__jobs               the research jobs the stub created (the request each holds)
//   POST /__behave/<ok|refuse|fail|slow>   how preview and start answer
import http from "node:http";

const KEY = process.env.LAB_KEY || "";
const MARK = "PERSONAL-MARKER-7731";
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const DOCS = {
  alice: [
    { title: "ALPHA Upgrading the workstation CPU", path: "documents/alice/alpha-cpu.md", text: `---\ntitle: "ALPHA Upgrading the workstation CPU"\n---\nPrivate body with ${MARK} and a link https://example.org/public-board` },
    { title: "ALPHA second note", path: "documents/alice/alpha-two.md", text: `---\ntitle: "ALPHA second note"\n---\nsecond` },
    { title: "ALPHA trashed note", path: "documents/alice/.trash/alpha-gone.md", text: "x" },
  ],
  bob: [{ title: "BRAVO plan", path: "documents/bob/bravo.md", text: `---\ntitle: "BRAVO plan"\n---\nplan` }],
};
const NAME = { alice: "Alice Lab", bob: "Bob Builder" };
const SUB = { alice: "u-alice", bob: "u-bob" };
const DEPTH = { quick: { name: "quick", rounds: 1, max_fetch: 12, wall_ms: 300000 }, standard: { name: "standard", rounds: 2, max_fetch: 40, wall_ms: 600000 }, deep: { name: "deep", rounds: 3, max_fetch: 80, wall_ms: 900000 } };
let mode = "alice";
let behave = "ok";
const log = [];
const jobs = [];
const ACCOUNT = {};
http.createServer((req, res) => {
  const json = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url === "/__log") return json(log);
  if (req.url === "/__jobs") return json(jobs);
  let m = req.url.match(/^\/__mode\/(\w+)$/);
  if (m && DOCS[m[1]]) { mode = m[1]; return json({ mode }); }
  m = req.url.match(/^\/__behave\/(\w+)$/);
  if (m) { behave = m[1]; return json({ behave }); }
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    log.push({ method: req.method, url: req.url, mode, keyOk: req.headers["x-brain-key"] === KEY, body });
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    const mine = DOCS[mode];
    if (p === "/workbench/settings" && req.method === "GET") {
      return json({ admin: false, settings: ["ui.locked_document", "ui.last_document", "ui.start_screen", "library.recent"].map((k) => ({ key: k, value: ACCOUNT[mode + k] ?? null, version: 0 })) });
    }
    if (p.startsWith("/workbench/settings/")) return json({ key: p, value: null, version: 1 });
    if (p === "/workbench/workspace/whoami") return json({ subject_sub: SUB[mode], actor_sub: SUB[mode], name: NAME[mode] });
    if (p === "/workbench/auth/me") return json({ mode: "forward-auth", signed_in: true, kind: "user", subject_sub: SUB[mode], name: NAME[mode] });
    if (p === "/workbench/intake/jobs") return json({ jobs: [] });
    if (p === "/workbench/contract/cleanup/sources") return json({ sources: [], total: 0 });
    if (p === "/workbench/contract/cleanup/reopen-candidates") return json({ candidates: [] });
    // Home's reads (Esc from + Start research lands on Home): empty, so the lab sees no 404 it did not mean to cause
    if (p === "/workbench/contract/ideas") return json({ ideas: [] });
    if (p === "/workbench/contract/podcasts") return json({ podcasts: [] });
    if (p === "/workbench/contract/podcasts/requests") return json({ requests: [] });
    if (p === "/workbench/contract/sessions") return json({ sessions: [] });
    if (p === "/workbench/contract/library/recent") return json({ days: 7, sources_total: 0, claims_total: 0, sources: [] });
    if (p === "/workbench/contract/library/waiting-claims") return json({ total: 0, claims: [] });
    if (p === "/workbench/contract/documents") return json({ documents: mine.map((d) => ({ title: d.title, path: d.path, updated: ago(3600000), outbound_links: [] })) });
    if (p === "/workbench/documents/state") {
      const path = u.searchParams.get("path") ?? "";
      const d = mine.find((x) => x.path === path);
      if (!d) return json({ error: "not found" }, 404);
      return json({ path, listed: true, trashed: /\/\.trash\//.test(path), archived: false });
    }
    if (p === "/workbench/documents/file") {
      const d = mine.find((x) => x.path === u.searchParams.get("path"));
      return d ? json({ content: d.text }) : json({ error: "not found" }, 404);
    }
    if (p === "/workbench/research/preview" || p === "/workbench/research") {
      const isStart = p === "/workbench/research";
      const go = () => {
        if (behave === "fail") return json({ error: "boom" }, 500);
        if (body?.attach?.kind === "idea") return json({ error: "an idea is researched from the idea itself" }, 400);
        if (body?.attach?.kind === "document" && !mine.some((d) => d.path === body.attach.path)) return json({ error: "not found" }, 404);
        const doc = body?.attach?.kind === "document" ? mine.find((d) => d.path === body.attach.path) : null;
        const shown = behave === "refuse"
          ? { question: null, topic: null, links: [], depth: null, refusal: "no_public_evidence" }
          : { question: "clean: " + String(body.question).toLowerCase().replace(/\s+/g, " ").trim(), topic: "topic " + body.depth, links: (doc && /public-board/.test(doc.text) ? ["https://example.org/public-board"] : []).concat(/long link/.test(body.question) ? ["https://example.org/" + "a".repeat(300)] : []), depth: DEPTH[body.depth], refusal: null };
        if (!isStart) return json({ ok: behave !== "refuse", ...shown });
        if (behave === "refuse") return json({ started: false, job_id: null, ...shown });
        if (body.approved_question !== shown.question) return json({ error: "the request changed since the preview" }, 409);
        const id = "d0d0d0d0-0000-4000-8000-00000000000" + (jobs.length + 1);
        jobs.push({ id, mode, question: shown.question, depth: body.depth, attach: body.attach });
        return json({ started: true, job_id: id, ...shown }, 202);
      };
      return behave === "slow" && !isStart ? setTimeout(go, 1500) : go();
    }
    json({ error: "not found" }, 404);
  });
}).listen(9000, () => console.log("stub up"));
