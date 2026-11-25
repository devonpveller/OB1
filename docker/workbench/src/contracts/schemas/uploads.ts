// Upload sessions (rwr-upload-sessions): a large file sent in pieces from the Imports screen. Every session is the
// identity seam's subject's; no request has a user field.
import { z } from "../deps.ts";
import { Iso } from "./common.ts";
import { FX } from "./fixtures.ts";

const Range = z.object({
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
}).openapi("UploadRange");

export const UploadStart = z.object({
  filename: z.string().min(1).max(255).openapi({ example: "field-survey.pdf", description: "the file's name: one name, no folder" }),
  size: z.number().int().positive().openapi({ example: 209715200, description: "the file's length in bytes (at most the per-file limit)" }),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).openapi({ example: "9f2c3a1b".repeat(8), description: "the file's SHA-256, 64 hexadecimal characters; the finish checks it" }),
}).openapi("UploadStart");

export const Upload = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  state: z.string().openapi({ example: "open", description: "open takes pieces; finishing is being joined; done became an add job; failed says why in reason (an open string, never a closed list here)" }),
  received: z.number().int().openapi({ description: "bytes received in full" }),
  next_offset: z.number().int().openapi({ description: "the first byte not yet received: where a resumed upload continues (= size when complete)" }),
  missing: z.array(Range).openapi({ description: "the first ranges not yet received (at most 20; missing_ranges is how many there are)" }),
  missing_ranges: z.number().int(),
  pieces: z.number().int(),
  reason: z.string().nullable().openapi({ description: "why the last finish was refused, or why the upload failed" }),
  job_id: z.string().nullable().openapi({ description: "the intake add job the upload became (kind add in /workbench/intake/jobs)" }),
  created_at: Iso,
  updated_at: Iso,
  expires_at: Iso.openapi({ description: "when an untouched upload is removed with its pieces" }),
}).openapi("Upload");

export const UploadLimitsView = z.object({
  max_file_bytes: z.number().int(),
  max_unfinished_bytes: z.number().int(),
  max_piece_bytes: z.number().int(),
  piece_bytes: z.number().int().openapi({ description: "the piece size to send" }),
  abandon_hours: z.number().int(),
}).openapi("UploadLimits");

export const UploadList = z.object({
  uploads: z.array(Upload).openapi({ description: "the caller's own uploads, newest first" }),
  unfinished_bytes: z.number().int().openapi({ description: "the declared sizes of the caller's unfinished uploads, summed (counts against max_unfinished_bytes)" }),
  limits: UploadLimitsView,
}).openapi("UploadList");

export const UploadFinish = z.object({
  refinery_id: z.string().optional().openapi({ example: FX.idea, description: "the refinery it joins (as POST /workbench/intake/add)" }),
  path: z.string().optional().openapi({ description: "or the document whose refinery it joins" }),
  content_type: z.string().optional().openapi({ example: "pdf", description: "optional: what the file is declared to be (web_article | pdf)" }),
}).openapi("UploadFinish");

export const UploadFinished = z.object({
  upload: Upload,
  job_id: z.string().uuid(),
}).openapi("UploadFinished");

export const UploadCancelled = z.object({
  id: z.string().uuid(),
  cancelled: z.boolean(),
}).openapi("UploadCancelled");

const at = FX.at;
const upload = {
  id: "5e1d0c00-0000-4000-8000-000000000001", filename: "field-survey.pdf", size: 209715200, sha256: "9f2c3a1b".repeat(8),
  state: "open" as const, received: 8388608, next_offset: 8388608, missing: [{ offset: 8388608, length: 201326592 }], missing_ranges: 1,
  pieces: 1, reason: null, job_id: null, created_at: at, updated_at: at, expires_at: "2026-10-18T12:00:00.000Z",
};
export const UPX = {
  start: { filename: "field-survey.pdf", size: 1024, sha256: "9f2c3a1b".repeat(8) },
  upload,
  started: { ...upload, size: 1024, received: 0, next_offset: 0, missing: [{ offset: 0, length: 1024 }], pieces: 0 },
  list: {
    uploads: [upload], unfinished_bytes: 209715200,
    limits: { max_file_bytes: 524288000, max_unfinished_bytes: 1073741824, max_piece_bytes: 16777216, piece_bytes: 8388608, abandon_hours: 24 },
  },
  finish: { refinery_id: FX.idea },
  finished: {
    upload: { ...upload, state: "done" as const, received: 0, next_offset: 0, missing: [], missing_ranges: 0, pieces: 0, job_id: "5e1d0c00-0000-4000-8000-0000000000a1" },
    job_id: "5e1d0c00-0000-4000-8000-0000000000a1",
  },
  cancelled: { id: upload.id, cancelled: true },
};
