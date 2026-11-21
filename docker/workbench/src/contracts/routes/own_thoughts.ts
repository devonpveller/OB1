// rwr-own-thoughts-search-api: "library and my thoughts" - GET /workbench/contract/own-thoughts/search finds the signed-in
// person's OWN saved thoughts, and only theirs. The picker's mineSearch adapter and Ctrl+K call it beside the shared
// contract search; the two answers are merged in the browser and this one is marked private.
//
// The rules, all of them here or in the repo's one query:
//   * whose: the identity seam's subject ONLY (seamIdentity), and only for a person acting as themselves by slot 480's rule
//     (identity/own_thoughts.ts). No parameter names a subject: sub / owner / user_id are ignored.
//   * what reads: ONE database function, owner_private_thoughts_search (slot 530, SECURITY DEFINER, ob_workbench alone), which
//     finds the subject's thoughts in both planes (personal and ops); no table is read here.
//   * a service key, an on-behalf caller, no identity: 403 (a service: the seam's USER_ONLY says it first) and no query
//     is made. An admin impersonating (or otherwise not acting as the subject) gets the empty answer of anyone.
//   * the answer for B about A's words is the answer for nothing at all: an empty list, no count, no total, no hint.
//   * never cached, never logged: Cache-Control no-store, private; this file and the repo log nothing, and a failure is
//     answered without its text (fail() logs only the error's message, which a database error does not build from a
//     parameter).
//   * never shared: GET only, nothing here feeds the wiki, digest, research, the shared search or a room, and no other
//     module imports the repo (own_thoughts_test.ts checks it). No MCP tool.
//   * no embedding call: text search only.
import type { Context } from "hono";
import { createRoute, z } from "../deps.ts";
import { seamIdentity } from "../../middleware/identity.ts";
import { type OwnThoughtsConfig, ownThoughtsConfig, ownThoughtsEligible } from "../../identity/own_thoughts.ts";
import { MAX_LIMIT, MAX_Q, MIN_Q, searchOwn } from "../repo/own_thoughts.ts";
import { OWN_THOUGHTS_EXAMPLE, OwnThoughts } from "../schemas/own_thoughts.ts";
import { limit, queryParam } from "../schemas/common.ts";
import { type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send } from "./http.ts";

const REFUSED = { error: "your own thoughts are searched for a signed-in person only" };
const HL_OPEN = "<<HL>>";
const HL_CLOSE = "<</HL>>";
const strip = (s: string) => s.split(HL_OPEN).join("").split(HL_CLOSE).join("");
const SNIPPET = 300;

// the snippet: the database's window around the first match, with the inert markers around the match. A marker a thought
// carries in its own text is removed first, so a thought cannot forge a highlight.
export function snippetOf(src: string, q: string): string {
  const text = strip(src);
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return text.slice(0, SNIPPET);
  const from = Math.max(0, at - Math.floor((SNIPPET - q.length) / 2));
  const to = Math.min(text.length, from + SNIPPET);
  const a = at - from, b = a + q.length;
  const w = text.slice(from, to);
  return `${from > 0 ? "…" : ""}${w.slice(0, a)}${HL_OPEN}${w.slice(a, b)}${HL_CLOSE}${w.slice(b)}${to < text.length ? "…" : ""}`;
}

export function registerOwnThoughts(app: ContractApp, deps: ContractDeps) {
  const cfg: OwnThoughtsConfig = (deps as { ownThoughtsCfg?: OwnThoughtsConfig }).ownThoughtsCfg ?? ownThoughtsConfig();
  op(app, createRoute({
    method: "get", path: `${PREFIX}/own-thoughts/search`, operationId: "ownThoughtsSearch", tags: ["owner-private (rwr-own-thoughts-search-api)"],
    summary: "search my own saved thoughts (text): the signed-in person's thoughts only, each marked private to you; a service or any other caller: refused",
    description: "Reads only through the identity seam's subject. Never another user's thought, never a count; a search for words only someone else's thought holds " +
      "answers exactly as a search for nothing. Not offered to a service key, an on-behalf caller or an admin who is not the owner. The shared contract search never returns a thought.",
    request: {
      query: z.object({
        q: queryParam("q", "compost", `at least ${MIN_Q} characters`),
        limit: limit(25, MAX_LIMIT),
      }),
    },
    responses: {
      200: json(OwnThoughts, OWN_THOUGHTS_EXAMPLE, "the caller's own thoughts, newest first; no count"),
      403: { content: { "application/json": { schema: z.object({ error: z.string() }) } }, description: "the caller is not a person (a service, on-behalf, no identity)" },
      ...errors,
    },
  }), async (c: Context) => {
    c.header("cache-control", "no-store, private");
    try {
      const who = seamIdentity(c);
      if (!who || !who.kind || who.kind === "service" || who.kind === "on-behalf" || who.kind === "anonymous") return c.json(REFUSED, 403);
      const raw = (c.req.query("q") ?? "").trim().slice(0, MAX_Q);
      if (raw.length < MIN_Q) return c.json({ error: `q needs at least ${MIN_Q} characters` }, 400);
      if (!ownThoughtsEligible(who, cfg)) return send(c, OwnThoughts, { private: true, query: raw, results: [] });
      const n = Math.min(MAX_LIMIT, Math.max(1, parseInt(c.req.query("limit") ?? "", 10) || 25));
      const rows = await searchOwn(deps.db, who.sub, raw, n);
      return send(c, OwnThoughts, {
        private: true, query: raw,
        results: rows.map((r) => ({
          kind: "thought", id: r.thought_id, title: strip(r.title), snippet: snippetOf(r.snippet_src, raw), state: "current", lifecycle: null, page_class: null,
          date: new Date(r.created_at).toISOString(), private: true, marker: "private to you",
        })),
      });
    } catch (e) {
      return fail(c, e);
    }
  });
}
