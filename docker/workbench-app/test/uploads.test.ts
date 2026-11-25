// rwr-upload-sessions: the app's large-file client (src/lib/uploads.ts) against a fake upload-session server behind the one
// fetch door. A dropped connection mid-way resumes from the status; a server refusal stops with the server's reason; a
// small file is not sent in pieces.
import { describe, expect, it } from "vitest";
import { clearRequestLog, requestLog, setFetcher } from "../src/lib/api";
import { needsPieces, SINGLE_REQUEST_LIMIT, uploadInPieces } from "../src/lib/uploads";

const ID = "5e1d0c00-0000-4000-8000-000000000001";

function fakeSessions(opts: { pieceBytes: number; dropAt?: number[]; finishError?: { status: number; error: string } }) {
  clearRequestLog();
  const got = new Map<number, number>();
  let size = 0, sha = "", finishes = 0;
  const drops = new Set(opts.dropAt ?? []);
  const view = () => {
    let next = 0;
    while (got.has(next)) next += got.get(next)!;
    return { id: ID, size, sha256: sha, state: "open", received: [...got.values()].reduce((a, b) => a + b, 0), next_offset: Math.min(next, size), missing: [], missing_ranges: 0, pieces: got.size, reason: null, job_id: null };
  };
  const puts: number[] = [];
  setFetcher(async (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (method === "POST" && url === "/workbench/contract/uploads") {
      const b = JSON.parse(String(init!.body));
      size = b.size; sha = b.sha256;
      return json({ ...view(), filename: b.filename }, 201);
    }
    if (method === "GET" && url === "/workbench/contract/uploads") {
      return json({ uploads: [], unfinished_bytes: 0, limits: { max_file_bytes: 1 << 30, max_unfinished_bytes: 1 << 30, max_piece_bytes: opts.pieceBytes * 2, piece_bytes: opts.pieceBytes, abandon_hours: 24 } });
    }
    if (method === "GET" && url === `/workbench/contract/uploads/${ID}`) return json(view());
    const m = url.match(/^\/workbench\/contract\/uploads\/[0-9a-f-]+\/pieces\?offset=(\d+)$/);
    if (method === "PUT" && m) {
      const off = Number(m[1]);
      puts.push(off);
      expect((init!.headers as Record<string, string>)["content-type"]).toBe("application/octet-stream");
      const len = (init!.body as Blob).size;
      if (drops.has(off)) {
        drops.delete(off);
        throw new TypeError("network error: the connection dropped");
      }
      got.set(off, len);
      return json(view());
    }
    if (method === "POST" && url === `/workbench/contract/uploads/${ID}/finish`) {
      finishes++;
      if (opts.finishError) return json({ error: opts.finishError.error }, opts.finishError.status);
      return json({ upload: { ...view(), state: "done", job_id: "j1" }, job_id: "5e1d0c00-0000-4000-8000-0000000000a1" }, 202);
    }
    return json({ error: `no fake for ${method} ${url}` }, 404);
  });
  return { puts, got, finishes: () => finishes, sha: () => sha };
}

const fileOf = (n: number, name = "big.pdf") => new File([new Uint8Array(n).map((_, i) => i % 251)], name, { type: "application/pdf" });

describe("uploadInPieces", () => {
  it("sends the file in pieces, resumes from the status after a dropped connection, finishes once", async () => {
    const srv = fakeSessions({ pieceBytes: 1000, dropAt: [3000] });
    const f = fileOf(5500);
    const progress: number[] = [];
    const out = await uploadInPieces(f, { refinery_id: "r1", onProgress: (n) => progress.push(n), retryDelayMs: 0 });
    expect(out.job_id).toBe("5e1d0c00-0000-4000-8000-0000000000a1");
    expect(srv.finishes()).toBe(1);
    // 3000 was sent twice (dropped, then resumed from the status), every other piece once
    expect(srv.puts).toEqual([0, 1000, 2000, 3000, 3000, 4000, 5000]);
    expect([...srv.got.keys()].sort((a, b) => a - b)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    expect(srv.got.get(5000)).toBe(500);
    // the declared sha256 is the file's
    const want = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await f.arrayBuffer()))).map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(srv.sha()).toBe(want);
    expect(progress[progress.length - 1]).toBe(5500);
    // every request went through the one door
    expect(requestLog().every((r) => r.url.startsWith("/workbench/contract/uploads"))).toBe(true);
  });

  it("a refused finish stops with the server's reason", async () => {
    fakeSessions({ pieceBytes: 1000, finishError: { status: 422, error: "the joined file's sha256 is x, not the y declared" } });
    await expect(uploadInPieces(fileOf(1500), { refinery_id: "r1", retryDelayMs: 0 })).rejects.toThrow(/sha256 is x/);
  });

  it("gives up after the retries run out", async () => {
    fakeSessions({ pieceBytes: 1000, dropAt: [0] });
    setFetcher(async () => { throw new TypeError("offline"); });
    await expect(uploadInPieces(fileOf(1500), { refinery_id: "r1", retryDelayMs: 0, retries: 2 })).rejects.toThrow();
  });

  it("only a file over the single-request limit goes in pieces", () => {
    expect(SINGLE_REQUEST_LIMIT).toBe(25 * 1024 * 1024);
    expect(needsPieces({ size: SINGLE_REQUEST_LIMIT })).toBe(false);
    expect(needsPieces({ size: SINGLE_REQUEST_LIMIT + 1 })).toBe(true);
  });
});
