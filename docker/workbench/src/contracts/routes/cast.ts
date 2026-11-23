// Cast editing (research-workbench redesign, rwr-cast-edit-api; slot 560): create, read, change, delete and copy
// presenters, voice links, teams and formats. Every call acts as the identity seam's subject (identityOf); no body has
// a user field and an unknown field is refused. Another user's unshared row is "no such ...", the same 404 a missing
// id gets; a shared row of someone else's is readable and read-only (403), and POST .../copy makes the caller's own.
// The rules live in repo/cast.ts. The routes are user-only (middleware/identity.ts USER_ONLY: a service has no cast).
//
// Deliberately absent: a per-presenter model route (phase J, operator-gated). The presenter speaks through its voice
// link's TTS route and the format's script route, both LiteLLM model names (schemas/cast.ts ROUTE: never a URL).
import type { Context } from "hono";
import { createRoute, z } from "../deps.ts";
import { identityOf } from "../../middleware/identity.ts";
import * as cast from "../repo/cast.ts";
import {
  CastDeleted, CastFormat, CastFormatCreate, CastFormats, CastFormatUpdate, CastPresenter, CastPresenterCreate, CastPresenters,
  CastPresenterUpdate, CastTeam, CastTeamCreate, CastTeams, CastTeamUpdate, CastSharePreview, CastVoice, CastVoiceCreate, CastVoices, CastVoiceUpdate, CASTX, CX,
} from "../schemas/cast.ts";
import { ErrorBody, limit, pathParam, queryParam } from "../schemas/common.ts";
import { parseLimit } from "../logic/scope.ts";
import { body, type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send } from "./http.ts";

const T = ["cast (rwr-cast-edit-api)"];
const P = `${PREFIX}/cast`;
const errs = {
  ...errors,
  403: { content: { "application/json": { schema: ErrorBody } }, description: "a shared row of another user's: read-only (copy it)" },
};
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

// a write whose JSON body is missing or does not parse is the caller's error: 400 before the validator (as flags.ts)
async function jsonBody(c: Context, next: () => Promise<void>) {
  if ((c.req.method === "POST" || c.req.method === "PATCH") && (c.req.header("content-type") ?? "").toLowerCase().includes("json")) {
    const text = await c.req.text();
    let ok = text.trim() !== "";
    if (ok) {
      try {
        const v = JSON.parse(text);
        ok = v !== null && typeof v === "object" && !Array.isArray(v);
      } catch {
        ok = false;
      }
    }
    // a copy takes no body: an empty one is fine there
    if (!ok && !(c.req.method === "POST" && /\/copy$/.test(c.req.path) && text.trim() === "")) {
      return c.json({ error: "invalid request: the body must be a JSON object" }, 400);
    }
  }
  await next();
}

const scopeQuery = z.object({
  limit: limit(100, 500),
  scope: queryParam("scope", "mine", "mine (default: your own) or shared (the one shared pool every account sees, yours included)"),
});

function scopeOf(c: Context): { shared: boolean; limit: number } | Response {
  const q = (c.req as unknown as { valid: (k: string) => { scope?: string; limit?: string } }).valid("query");
  if (q.scope !== undefined && q.scope !== "mine" && q.scope !== "shared") return c.json({ error: "scope is mine or shared" }, 400);
  return { shared: q.scope === "shared", limit: parseLimit(q.limit, 100, 500) };
}

const idParam = (example: string) => z.object({ id: pathParam("id", example, "the row's id") });

// one place maps every failure: a database refusal to its fixed message first (repo/cast.ts castError)
const failCast = (c: Context, e: unknown) => fail(c, cast.castError(e));

export function registerCast(app: ContractApp, deps: ContractDeps) {
  app.use(P, jsonBody);
  app.use(`${P}/*`, jsonBody);
  const db = deps.db;
  const reg = deps.registry;
  const notFound = (c: Context, what: keyof typeof cast.NO_SUCH) => c.json({ error: cast.NO_SUCH[what] }, 404);
  // an id that cannot be a row's is not found (the same body a missing or another user's row gets), before any query
  const guard = async (c: Context, what: keyof typeof cast.NO_SUCH, f: (id: string) => Promise<Response>) => {
    const id = (c.req as unknown as { valid: (k: string) => { id: string } }).valid("param").id;
    if (!ID_RE.test(id)) return notFound(c, what);
    try {
      return await f(id);
    } catch (e) {
      return failCast(c, e);
    }
  };

  // ── voice links ─────────────────────────────────────────────────────────────────────────────
  op(app, createRoute({
    method: "get", path: `${P}/voices`, operationId: "castVoices", tags: T,
    summary: "the caller's voice links (how each presenter sounds: a LiteLLM TTS route, a voice, a speed)",
    request: { query: z.object({ limit: limit(100, 500) }) },
    responses: { 200: json(CastVoices, CASTX.voices, "by voice"), ...errs },
  }), async (c) => {
    try {
      const who = await identityOf(c);
      return send(c, CastVoices, await cast.listVoices(db, who.sub, parseLimit(c.req.valid("query").limit, 100, 500)));
    } catch (e) {
      return failCast(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${P}/voices`, operationId: "castVoiceCreate", tags: T,
    summary: "add a voice link (route: a LiteLLM model name, never a URL)",
    request: { body: body(CastVoiceCreate, CASTX.voiceCreate) },
    responses: { 201: json(CastVoice, { ...CASTX.voice, used_by: [] }, "the voice, the caller's"), ...errs },
  }), async (c) => {
    try {
      return send(c, CastVoice, await cast.createVoice(db, (await identityOf(c)).sub, c.req.valid("json")), 201);
    } catch (e) {
      return failCast(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${P}/voices/{id}`, operationId: "castVoice", tags: T,
    summary: "one of the caller's voice links; anyone else's is not found",
    request: { params: idParam(CX.voice) },
    responses: { 200: json(CastVoice, CASTX.voice, "the voice"), ...errs },
  }), (c) => guard(c, "voice", async (id) => {
    const v = await cast.getVoice(db, (await identityOf(c)).sub, id);
    return v ? send(c, CastVoice, v) : notFound(c, "voice");
  }));

  op(app, createRoute({
    method: "patch", path: `${P}/voices/{id}`, operationId: "castVoiceUpdate", tags: T,
    summary: "change one of the caller's voice links (re-voices only the presenters it voices)",
    request: { params: idParam(CX.voice), body: body(CastVoiceUpdate, CASTX.voiceUpdate) },
    responses: { 200: json(CastVoice, { ...CASTX.voice, speed: 0.9 }, "the voice, changed"), ...errs },
  }), (c) => guard(c, "voice", async (id) => send(c, CastVoice, await cast.updateVoice(db, (await identityOf(c)).sub, id, c.req.valid("json")))));

  op(app, createRoute({
    method: "delete", path: `${P}/voices/{id}`, operationId: "castVoiceDelete", tags: T,
    summary: "delete one of the caller's voice links; refused (409, naming them) while it voices a presenter",
    request: { params: idParam(CX.voiceDel) },
    responses: { 200: json(CastDeleted, { id: CX.voiceDel, deleted: true }, "deleted"), ...errs },
  }), (c) => guard(c, "voice", async (id) => send(c, CastDeleted, await cast.deleteVoice(db, (await identityOf(c)).sub, id))));

  // ── presenters ──────────────────────────────────────────────────────────────────────────────
  op(app, createRoute({
    method: "get", path: `${P}/presenters`, operationId: "castPresenters", tags: T,
    summary: "the caller's presenters with every field (scope=mine), or the shared pool (scope=shared)",
    description: "A shared presenter of someone else's carries no notes (null), no teams and only its links to shared sources and topics.",
    request: { query: scopeQuery },
    responses: { 200: json(CastPresenters, CASTX.presenters, "by name"), ...errs },
  }), async (c) => {
    try {
      const s = scopeOf(c);
      if (s instanceof Response) return s;
      return send(c, CastPresenters, await cast.listPresenters(db, (await identityOf(c)).sub, s));
    } catch (e) {
      return failCast(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${P}/presenters`, operationId: "castPresenterCreate", tags: T,
    summary: "make a presenter of the caller's: a voice of theirs, the fields, grounded-in links (a shared source, a private source of their own, or a topic)",
    request: { body: body(CastPresenterCreate, CASTX.presenterCreate) },
    responses: {
      201: json(CastPresenter, { ...CASTX.presenter, id: "presenter-00000000-0000-4000-8000-000000000002", name: "Dredd presenter", teams: [] }, "the presenter"),
      ...errs,
    },
  }), async (c) => {
    try {
      return send(c, CastPresenter, await cast.createPresenter(db, reg, (await identityOf(c)).sub, c.req.valid("json")), 201);
    } catch (e) {
      return failCast(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${P}/presenters/{id}`, operationId: "castPresenter", tags: T,
    summary: "one presenter: the caller's own, or a shared one; anything else is not found",
    request: { params: idParam(CX.presenter) },
    responses: { 200: json(CastPresenter, CASTX.presenter, "the presenter"), ...errs },
  }), (c) => guard(c, "presenter", async (id) => {
    const p = await cast.getPresenter(db, (await identityOf(c)).sub, id);
    return p ? send(c, CastPresenter, p) : notFound(c, "presenter");
  }));

  op(app, createRoute({
    method: "patch", path: `${P}/presenters/{id}`, operationId: "castPresenterUpdate", tags: T,
    summary: "change the caller's presenter (grounded_in replaces the list; shared: true is refused while it links a private source)",
    request: { params: idParam(CX.presenter), body: body(CastPresenterUpdate, CASTX.presenterUpdate) },
    responses: { 200: json(CastPresenter, { ...CASTX.presenter, stance: "cautious", speaking_style: "asks before answering" }, "the presenter, changed"), ...errs },
  }), (c) => guard(c, "presenter", async (id) => send(c, CastPresenter, await cast.updatePresenter(db, reg, (await identityOf(c)).sub, id, c.req.valid("json")))));

  op(app, createRoute({
    method: "delete", path: `${P}/presenters/{id}`, operationId: "castPresenterDelete", tags: T,
    summary: "delete the caller's presenter; refused (409, naming the team) while it sits in a team",
    request: { params: idParam(CX.presenterDel) },
    responses: { 200: json(CastDeleted, CASTX.deleted, "deleted"), ...errs },
  }), (c) => guard(c, "presenter", async (id) => send(c, CastDeleted, await cast.deletePresenter(db, (await identityOf(c)).sub, id))));

  op(app, createRoute({
    method: "post", path: `${P}/presenters/{id}/copy`, operationId: "castPresenterCopy", tags: T,
    summary: "use a presenter: the caller's own copy (with a copy of its voice) of a shared presenter, or of their own; never its owner's notes",
    request: { params: idParam(CX.sharedPresenter) },
    responses: { 201: json(CastPresenter, CASTX.presenterCopy, "the caller's copy"), ...errs },
  }), (c) => guard(c, "presenter", async (id) => send(c, CastPresenter, await cast.copyPresenter(db, (await identityOf(c)).sub, id), 201)));

  // ── teams ───────────────────────────────────────────────────────────────────────────────────
  op(app, createRoute({
    method: "get", path: `${P}/teams`, operationId: "castTeams", tags: T,
    summary: "the caller's teams (scope=mine) or the shared pool (scope=shared): the cast in speaking order and the user's seat",
    request: { query: scopeQuery },
    responses: { 200: json(CastTeams, CASTX.teams, "by name"), ...errs },
  }), async (c) => {
    try {
      const s = scopeOf(c);
      if (s instanceof Response) return s;
      return send(c, CastTeams, await cast.listTeams(db, (await identityOf(c)).sub, s));
    } catch (e) {
      return failCast(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${P}/teams`, operationId: "castTeamCreate", tags: T,
    summary: "make a team of the caller's presenters, in order (at most 25) with the user's seat (26 seats at most)",
    request: { body: body(CastTeamCreate, CASTX.teamCreate) },
    responses: {
      201: json(CastTeam, { ...CASTX.team, id: "team-00000000-0000-4000-8000-000000000002", name: "Dredd team", user_seat: 0, formats: [] }, "the team"),
      ...errs,
    },
  }), async (c) => {
    try {
      return send(c, CastTeam, await cast.createTeam(db, (await identityOf(c)).sub, c.req.valid("json")), 201);
    } catch (e) {
      return failCast(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${P}/teams/{id}`, operationId: "castTeam", tags: T,
    summary: "one team: the caller's own, or a shared one; anything else is not found",
    request: { params: idParam(CX.team) },
    responses: { 200: json(CastTeam, CASTX.team, "the team"), ...errs },
  }), (c) => guard(c, "team", async (id) => {
    const t = await cast.getTeam(db, (await identityOf(c)).sub, id);
    return t ? send(c, CastTeam, t) : notFound(c, "team");
  }));

  op(app, createRoute({
    method: "patch", path: `${P}/teams/{id}`, operationId: "castTeamUpdate", tags: T,
    summary: "change the caller's team (members replaces the order; a shared team needs every member shared)",
    request: { params: idParam(CX.team), body: body(CastTeamUpdate, CASTX.teamUpdate) },
    responses: { 200: json(CastTeam, { ...CASTX.team, description: "changed by the contract run" }, "the team, changed"), ...errs },
  }), (c) => guard(c, "team", async (id) => send(c, CastTeam, await cast.updateTeam(db, (await identityOf(c)).sub, id, c.req.valid("json")))));

  op(app, createRoute({
    method: "delete", path: `${P}/teams/{id}`, operationId: "castTeamDelete", tags: T,
    summary: "delete the caller's team; refused (409) while it has formats, episodes or render requests",
    request: { params: idParam(CX.teamDel) },
    responses: { 200: json(CastDeleted, { id: CX.teamDel, deleted: true }, "deleted"), ...errs },
  }), (c) => guard(c, "team", async (id) => send(c, CastDeleted, await cast.deleteTeam(db, (await identityOf(c)).sub, id))));

  op(app, createRoute({
    method: "post", path: `${P}/teams/{id}/copy`, operationId: "castTeamCopy", tags: T,
    summary: "use a team: the caller's own copy, every presenter copied too, same order and seat",
    request: { params: idParam(CX.sharedTeam) },
    responses: { 201: json(CastTeam, CASTX.teamCopy, "the caller's copy"), ...errs },
  }), (c) => guard(c, "team", async (id) => send(c, CastTeam, await cast.copyTeam(db, (await identityOf(c)).sub, id), 201)));

  // ── formats ─────────────────────────────────────────────────────────────────────────────────
  op(app, createRoute({
    method: "get", path: `${P}/formats`, operationId: "castFormats", tags: T,
    summary: "the caller's formats (scope=mine) or the shared pool (scope=shared): kind, use-for, default",
    request: { query: scopeQuery },
    responses: { 200: json(CastFormats, CASTX.formats, "by name"), ...errs },
  }), async (c) => {
    try {
      const s = scopeOf(c);
      if (s instanceof Response) return s;
      return send(c, CastFormats, await cast.listFormats(db, (await identityOf(c)).sub, s));
    } catch (e) {
      return failCast(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${P}/formats`, operationId: "castFormatCreate", tags: T,
    summary: "make a format of one of the caller's teams (kind and use_for are registry keys; is_default makes it the caller's one default)",
    request: { body: body(CastFormatCreate, CASTX.formatCreate) },
    responses: {
      201: json(CastFormat, { ...CASTX.format, id: "format-00000000-0000-4000-8000-000000000002", name: "Dredd format", kind: "briefing", use_for: ["research"], is_default: false },
        "the format"),
      ...errs,
    },
  }), async (c) => {
    try {
      return send(c, CastFormat, await cast.createFormat(db, reg, (await identityOf(c)).sub, c.req.valid("json")), 201);
    } catch (e) {
      return failCast(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${P}/formats/{id}`, operationId: "castFormat", tags: T,
    summary: "one format: the caller's own, or a shared one; anything else is not found",
    request: { params: idParam(CX.format) },
    responses: { 200: json(CastFormat, CASTX.format, "the format"), ...errs },
  }), (c) => guard(c, "format", async (id) => {
    const f = await cast.getFormat(db, (await identityOf(c)).sub, id);
    return f ? send(c, CastFormat, f) : notFound(c, "format");
  }));

  op(app, createRoute({
    method: "patch", path: `${P}/formats/{id}`, operationId: "castFormatUpdate", tags: T,
    summary: "change the caller's format (a shared format needs its team shared)",
    request: { params: idParam(CX.format), body: body(CastFormatUpdate, CASTX.formatUpdate) },
    responses: { 200: json(CastFormat, { ...CASTX.format, briefing: "Changed by the contract run.", kind: "debate" }, "the format, changed"), ...errs },
  }), (c) => guard(c, "format", async (id) => send(c, CastFormat, await cast.updateFormat(db, reg, (await identityOf(c)).sub, id, c.req.valid("json")))));

  op(app, createRoute({
    method: "delete", path: `${P}/formats/{id}`, operationId: "castFormatDelete", tags: T,
    summary: "delete the caller's format",
    request: { params: idParam(CX.formatDel) },
    responses: { 200: json(CastDeleted, { id: CX.formatDel, deleted: true }, "deleted"), ...errs },
  }), (c) => guard(c, "format", async (id) => send(c, CastDeleted, await cast.deleteFormat(db, (await identityOf(c)).sub, id))));

  op(app, createRoute({
    method: "post", path: `${P}/formats/{id}/copy`, operationId: "castFormatCopy", tags: T,
    summary: "use a format: the caller's own copy (of someone else's: its team and presenters copied too); never the default until set",
    request: { params: idParam(CX.sharedFormat) },
    responses: { 201: json(CastFormat, CASTX.formatCopy, "the caller's copy"), ...errs },
  }), (c) => guard(c, "format", async (id) => send(c, CastFormat, await cast.copyFormat(db, (await identityOf(c)).sub, id), 201)));
  // ── the share step: what a share would show every account, before the owner confirms it ─────────────────────────────
  const previews: [cast.ShareKind, "presenters" | "teams" | "formats", string, string][] = [
    ["presenter", "presenters", "castPresenterSharePreview", CX.presenter],
    ["team", "teams", "castTeamSharePreview", CX.team],
    ["format", "formats", "castFormatSharePreview", CX.format],
  ];
  for (const [kind, plural, operationId, example] of previews) {
    op(app, createRoute({
      method: "get", path: `${P}/${plural}/{id}/share-preview`, operationId, tags: T,
      summary: `what sharing the caller's ${kind} would show every account, what blocks it, and the share_digest that confirms exactly this`,
      description: "The disclosure step (operator, 2026-11-22: a share first reveals what would be shared). PATCH {shared: true, share_digest} " +
        "with the digest shares it; a missing or out-of-date digest is refused (409).",
      request: { params: idParam(example) },
      responses: { 200: json(CastSharePreview, { ...CASTX.sharePreview, id: example }, "the preview"), ...errs },
    }), (c) => guard(c, kind, async (id) => send(c, CastSharePreview, await cast.sharePreview(db, (await identityOf(c)).sub, kind, id))));
  }
}
