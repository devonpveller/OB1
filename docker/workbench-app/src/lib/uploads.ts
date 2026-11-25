// rwr-upload-sessions: a file larger than one request takes goes up in pieces (the server: workbench
// src/uploads/sessions.ts, /workbench/contract/uploads). Start with the file's name, size and SHA-256; send each piece
// at its offset; after a dropped connection read the status and continue from its next_offset; finish with where the file
// lands (as POST /workbench/intake/add takes it). The server verifies size and SHA-256 and makes ONE add job.
// The Imports screen sends a file above SINGLE_REQUEST_LIMIT through here.
import { api, ApiError, putBytes } from "./api";

// the intake add route's own file limit (workbench src/intake/routes.ts maxFileBytes, 25 MB): a file at most this size goes
// in one request; above it, in pieces
export const SINGLE_REQUEST_LIMIT = 25 * 1024 * 1024;
export const needsPieces = (f: { size: number }) => f.size > SINGLE_REQUEST_LIMIT;

const BASE = "/workbench/contract/uploads";

export interface UploadTarget {
  refinery_id?: string;
  path?: string;
  content_type?: string;
}
export interface UploadOptions extends UploadTarget {
  onProgress?: (bytesReceived: number, size: number) => void;
  signal?: AbortSignal;
  retries?: number; // consecutive failed attempts tolerated before giving up (default 5)
  retryDelayMs?: number; // the first wait before a retry; doubles each time (default 1000)
  resumeId?: string; // an upload started earlier (this page reloaded): continue it instead of starting again
}

async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// a refusal the server explained (4xx) ends the upload; a dropped connection or a 5xx is retried from the status
const retryable = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status >= 500;

export async function uploadInPieces(file: File, opts: UploadOptions = {}): Promise<{ upload_id: string; job_id: string }> {
  const retries = opts.retries ?? 5;
  const delay0 = opts.retryDelayMs ?? 1000;
  const limits = (await api("GET", BASE)).data.limits as { piece_bytes: number };
  const piece = Math.max(1, Number(limits?.piece_bytes) || 8 * 1024 * 1024);
  let id = opts.resumeId ?? "";
  if (!id) {
    const started = await api("POST", BASE, { filename: file.name, size: file.size, sha256: await sha256Hex(file) });
    id = String(started.data.id);
  }
  const url = `${BASE}/${encodeURIComponent(id)}`;
  let failures = 0;
  let next = 0;
  let resync = true;
  while (true) {
    if (opts.signal?.aborted) throw new DOMException("the upload was stopped", "AbortError");
    try {
      if (resync) {
        const st = (await api("GET", url)).data;
        next = Number(st.next_offset);
        opts.onProgress?.(Number(st.received), file.size);
        resync = false;
      }
      if (next >= file.size) break;
      const st = (await putBytes(`${url}/pieces?offset=${next}`, file.slice(next, Math.min(file.size, next + piece)))).data;
      next = Number(st.next_offset);
      opts.onProgress?.(Number(st.received), file.size);
      failures = 0;
    } catch (e) {
      if (!retryable(e) || ++failures > retries) throw e;
      await new Promise((r) => setTimeout(r, delay0 * 2 ** (failures - 1)));
      resync = true; // what arrived is what the server says arrived
    }
  }
  const target: UploadTarget = {};
  if (opts.refinery_id) target.refinery_id = opts.refinery_id;
  if (opts.path) target.path = opts.path;
  if (opts.content_type) target.content_type = opts.content_type;
  failures = 0;
  while (true) {
    try {
      const done = await api("POST", `${url}/finish`, target);
      return { upload_id: id, job_id: String(done.data.job_id) };
    } catch (e) {
      // a finish resent after a dropped answer gets the same job back (the server is idempotent there)
      if (!retryable(e) || ++failures > retries) throw e;
      await new Promise((r) => setTimeout(r, delay0 * 2 ** (failures - 1)));
    }
  }
}
