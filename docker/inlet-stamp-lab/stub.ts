// stub.ts - rw-inlet-stamp's lab stand-ins (plan 08 PD2), one Deno server on the lab's --internal network under the
// aliases gmail-stub, llama-cpp and llama-cpp-embed (the LiteLLM gateway's alias names: the writers' inference goes to
// the alias, as in production; no real model, no real Gmail, nothing leaves the network).
//   * Gmail API (/gmail/v1/users/me/...): TWO seeded mailboxes, chosen by the bearer token the pull sends
//     (lab-token-a = owner A's connection `gmail`, lab-token-b = owner B's connection `gmail-b`). Each mail carries its
//     mailbox's marker (STAMP_MARK_A / STAMP_MARK_B) in the subject and body. Two mails per mailbox: one fresh (INBOX), one
//     ten days old under the short-term label (the prune's).
//   * /v1/embeddings: a deterministic 1024-dim unit vector per text; /v1/chat/completions: a fixed JSON metadata answer.
//   * GET /_log: what was asked (paths only, never a body); GET /_gmailcount: how many Gmail API requests so far.
const PORT = Number(Deno.env.get("PORT") ?? "8080");
const MARK = { a: Deno.env.get("STAMP_MARK_A") ?? "stampmarka", b: Deno.env.get("STAMP_MARK_B") ?? "stampmarkb" };
const log: string[] = [];

const b64url = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const DAY = 86_400_000;
type Box = "a" | "b";
function mails(box: Box) {
  const m = MARK[box];
  return [
    { id: `${box}msg0001`, threadId: `${box}thr0001`, labels: ["INBOX"], age: 0, subject: `Weekly notes ${m}` },
    { id: `${box}msg0002`, threadId: `${box}thr0002`, labels: ["INBOX", "Label_9"], age: 10 * DAY, subject: `Holding pen ${m}` },
  ].map((x) => ({
    id: x.id,
    threadId: x.threadId,
    labelIds: x.labels,
    internalDate: String(Date.now() - x.age),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: `Lab Friend ${box.toUpperCase()} <friend-${box}@example.org>` },
        { name: "To", value: `owner-${box}@example.org` },
        { name: "Subject", value: x.subject },
      ],
      body: {
        data: b64url(`Hello there, this is a lab letter for mailbox ${box}. It carries the marker ${m} and enough words to be ingested as a real email body by the pull.`),
        size: 120,
      },
    },
  }));
}
const boxOf = (req: Request): Box | null => {
  const a = req.headers.get("authorization") ?? "";
  return a === "Bearer lab-token-a" ? "a" : a === "Bearer lab-token-b" ? "b" : null;
};
// a deterministic unit vector per input text (so a dedup by similarity finds only the same text)
function vec(text: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  const v = new Array(1024);
  let n = 0;
  for (let i = 0; i < 1024; i++) { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; v[i] = (h / 4294967296) - 0.5; n += v[i] * v[i]; }
  n = Math.sqrt(n);
  return v.map((x) => x / n);
}

Deno.serve({ port: PORT, hostname: "0.0.0.0" }, async (req) => {
  const u = new URL(req.url);
  const p = u.pathname;
  log.push(`${req.method} ${req.headers.get("host")?.split(":")[0]} ${p}`);
  if (p === "/_log") return Response.json({ log });
  if (p === "/_gmailcount") return new Response(String(log.filter((l) => l.includes(" /gmail/")).length));
  if (p === "/health" || p === "/health/liveliness") return new Response("ok");
  if (p.startsWith("/gmail/v1/users/me/")) {
    const box = boxOf(req);
    if (!box) return Response.json({ error: { code: 401, message: "lab stub: unknown token" } }, { status: 401 });
    const rest = p.slice("/gmail/v1/users/me".length);
    if (rest === "/labels") {
      return Response.json({ labels: [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "Label_9", name: "brain/keep-short-term", type: "user" },
      ] });
    }
    if (rest === "/messages") {
      return Response.json({ messages: mails(box).map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: 2 });
    }
    const m = /^\/messages\/([a-z0-9]+)$/.exec(rest);
    if (m) {
      const msg = mails(box).find((x) => x.id === m[1]);
      return msg ? Response.json(msg) : Response.json({ error: { code: 404 } }, { status: 404 });
    }
    return Response.json({ error: { code: 404 } }, { status: 404 });
  }
  if (req.method === "POST" && p === "/v1/embeddings") {
    const b = await req.json().catch(() => ({}));
    const input = Array.isArray(b.input) ? String(b.input[0] ?? "") : String(b.input ?? "");
    return Response.json({ data: [{ embedding: vec(input), index: 0 }], model: "local-embed" });
  }
  if (req.method === "POST" && p === "/v1/chat/completions") {
    await req.body?.cancel();
    const content = JSON.stringify({ type: "observation", topics: ["lab"], people: [], action_items: [], dates_mentioned: [] });
    return Response.json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  }
  return new Response("lab stub: not found", { status: 404 });
});
