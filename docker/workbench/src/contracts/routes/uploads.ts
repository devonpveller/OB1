// Upload sessions (rwr-upload-sessions): /workbench/contract/uploads. A large file in pieces (src/uploads/sessions.ts),
// handed to the normal intake add path as one source once complete and verified. User-only (a service key has no
// uploads: middleware/identity.ts USER_ONLY answers 403); no MCP tool. Another person's upload answers exactly as a
// missing one: 404 "no such upload".
import { createRoute, z } from "../deps.ts";
import { ErrorBody, pathParam, queryParam } from "../schemas/common.ts";
import { Upload, UploadCancelled, UploadFinish, UploadFinished, UploadList, UploadStart, UPX } from "../schemas/uploads.ts";
import { type ContractApp, type ContractDeps, body, errors, fail, json, op, PREFIX, send } from "./http.ts";
import { identityOf } from "../../middleware/identity.ts";
import { UploadRefused } from "../../uploads/sessions.ts";
import type { Context } from "hono";

const P = `${PREFIX}/uploads`;
const errorContent = (description: string) => ({ content: { "application/json": { schema: ErrorBody } }, description });
const uploadErrors = {
  ...errors,
  413: errorContent("over a limit: the file (UPLOAD_MAX_FILE_BYTES) or one piece (UPLOAD_MAX_PIECE_BYTES)"),
  415: errorContent("not a type the intake takes (a PDF or a saved web page)"),
  416: errorContent("a piece outside the file"),
  503: errorContent("uploads are not configured on this workbench"),
};
const idParam = { params: z.object({ id: pathParam("id", UPX.upload.id, "upload id") }) };

function refused(c: Context, e: unknown) {
  if (e instanceof UploadRefused) {
    return c.json(Object.keys(e.detail).length ? { error: e.message, detail: e.detail } : { error: e.message }, e.status);
  }
  return fail(c, e);
}

export function registerUploads(app: ContractApp, deps: ContractDeps) {
  const up = () => {
    if (!deps.uploads) throw new UploadRefused(503, "uploads are not configured on this workbench");
    return deps.uploads;
  };

  op(app, createRoute({
    method: "post", path: P, operationId: "startUpload", tags: ["uploads"],
    summary: "start an upload of a large file in pieces (the caller's own)",
    description: "Declares the file's name, size and SHA-256. Refused over the per-file limit (413) or when the caller's unfinished " +
      "uploads would pass their limit (409, with how much is in use). Then PUT the pieces, GET the status to resume, POST finish.",
    request: { body: body(UploadStart, UPX.start) },
    responses: { 201: json(Upload, UPX.started, "the new upload, open"), ...uploadErrors },
  }), async (c) => {
    try {
      return send(c, Upload, await up().start(await identityOf(c), c.req.valid("json")), 201);
    } catch (e) {
      return refused(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: P, operationId: "listUploads", tags: ["uploads"],
    summary: "the caller's own uploads and limits",
    description: "Never another person's: not listed, not counted, not in unfinished_bytes.",
    responses: { 200: json(UploadList, UPX.list, "the caller's uploads"), ...uploadErrors },
  }), async (c) => {
    try {
      const u = up();
      return send(c, UploadList, { ...(await u.list(await identityOf(c))), limits: u.limits() });
    } catch (e) {
      return refused(c, e);
    }
  });

  op(app, createRoute({
    method: "get", path: `${P}/{id}`, operationId: "uploadStatus", tags: ["uploads"],
    summary: "one upload's status: bytes received and where to resume",
    request: idParam,
    responses: { 200: json(Upload, UPX.upload, "the upload"), ...uploadErrors },
  }), async (c) => {
    try {
      return send(c, Upload, await up().status(await identityOf(c), c.req.valid("param").id));
    } catch (e) {
      return refused(c, e);
    }
  });

  op(app, createRoute({
    method: "put", path: `${P}/{id}/pieces`, operationId: "putUploadPiece", tags: ["uploads"],
    summary: "one piece of the file, at its byte offset",
    description: "The body is the piece's raw bytes (application/octet-stream), at most max_piece_bytes and inside the file. A piece " +
      "that overlaps one already received is refused (409); the same offset and length again replaces it (a resend after a dropped " +
      "answer). A piece that did not arrive in full is not kept: GET the status and send it again.",
    request: {
      ...idParam,
      query: z.object({ offset: queryParam("offset", "0", "the piece's first byte in the file") }),
      body: { content: { "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) } }, required: true },
    },
    responses: { 200: json(Upload, UPX.upload, "the upload, with the piece"), ...uploadErrors },
  }), async (c) => {
    try {
      const id = c.req.valid("param").id;
      return send(c, Upload, await up().piece(await identityOf(c), id, c.req.query("offset"), c.req.header("content-length"), c.req.raw.body));
    } catch (e) {
      return refused(c, e);
    }
  });

  op(app, createRoute({
    method: "post", path: `${P}/{id}/finish`, operationId: "finishUpload", tags: ["uploads"],
    summary: "join the pieces, verify size and SHA-256, and add the file through the intake (one source)",
    description: "Missing bytes: 409 and the upload stays open. A size or SHA-256 that does not match, or a damaged piece: 422 and the " +
      "upload fails with the reason (its pieces removed). The target and type rules are POST /workbench/intake/add's. On success the " +
      "add job runs (/workbench/intake/jobs/add/{job_id}); a finish sent again answers the same job.",
    request: { ...idParam, body: body(UploadFinish, UPX.finish) },
    responses: { 202: json(UploadFinished, UPX.finished, "the add job the upload became"), ...uploadErrors },
  }), async (c) => {
    try {
      const out = await up().finish(await identityOf(c), c.req.valid("param").id, c.req.valid("json"));
      return send(c, UploadFinished, { upload: out.upload, job_id: out.job_id }, 202);
    } catch (e) {
      return refused(c, e);
    }
  });

  op(app, createRoute({
    method: "delete", path: `${P}/{id}`, operationId: "cancelUpload", tags: ["uploads"],
    summary: "cancel an unfinished upload: it and its pieces are removed",
    request: idParam,
    responses: { 200: json(UploadCancelled, UPX.cancelled, "removed"), ...uploadErrors },
  }), async (c) => {
    try {
      const id = c.req.valid("param").id;
      await up().cancel(await identityOf(c), id);
      return send(c, UploadCancelled, { id: id.toLowerCase(), cancelled: true });
    } catch (e) {
      return refused(c, e);
    }
  });
}
