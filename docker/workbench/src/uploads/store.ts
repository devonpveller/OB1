// Upload sessions' bytes on disk (rwr-upload-sessions): one directory per session under the workbench's own volume
// (UPLOAD_DIR, compose: openbrain-uploads on Docker's storage, on C:). No route serves this directory and no other
// service mounts the volume: a piece is reachable by nothing but this module.
//   <dir>/<session id>/p-<offset>      a piece received in full (renamed into place only after its last byte arrived)
//   <dir>/<session id>/t-<random>      a piece still arriving (a dropped connection leaves one; it is removed at once)
//   <dir>/<session id>/assembled       the whole file, after a finish verified its size and sha256
// A session id is a uuid checked here before it becomes a path, so no input can name another directory.
import { Sha256 } from "./sha256.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class PieceTooLarge extends Error {
  constructor(public limit: number) {
    super(`the piece is larger than ${limit} bytes`);
  }
}
export class PieceInterrupted extends Error {
  constructor() {
    super("the piece did not arrive in full");
  }
}

export interface AssembleResult {
  bytes: number;
  sha256: string;
  // the first piece whose file is not the length its row records (a damaged or truncated piece), else null
  damaged: { offset: number; expected: number; found: number } | null;
}

export function uploadStore(root: string) {
  const dirOf = (id: string) => {
    if (!UUID.test(id)) throw new Error("not a session id");
    return `${root}/${id}`;
  };
  const sizeOf = async (p: string) => {
    try {
      return (await Deno.stat(p)).size;
    } catch {
      return -1;
    }
  };
  // every file's size under a directory (the sweep's measure of what it frees)
  const bytesUnder = async (d: string): Promise<number> => {
    let n = 0;
    try {
      for await (const e of Deno.readDir(d)) {
        if (e.isFile) n += Math.max(0, await sizeOf(`${d}/${e.name}`));
        else if (e.isDirectory) n += await bytesUnder(`${d}/${e.name}`);
      }
    } catch { /* gone */ }
    return n;
  };
  return {
    root,
    // Stream a request body to a temporary file in the session's directory; at most `max` bytes are accepted. Nothing is
    // left behind on any failure (too large, the connection dropped, a write error).
    async receive(id: string, body: ReadableStream<Uint8Array> | null, max: number): Promise<{ tmp: string; length: number }> {
      const d = dirOf(id);
      await Deno.mkdir(d, { recursive: true });
      const tmp = `${d}/t-${crypto.randomUUID()}`;
      const f = await Deno.open(tmp, { write: true, createNew: true });
      let length = 0;
      let closed = false;
      try {
        if (body) {
          const reader = body.getReader();
          try {
            while (true) {
              let r: ReadableStreamReadResult<Uint8Array>;
              try {
                r = await reader.read();
              } catch {
                throw new PieceInterrupted();
              }
              if (r.done) break;
              length += r.value.byteLength;
              if (length > max) throw new PieceTooLarge(max);
              let off = 0;
              while (off < r.value.byteLength) off += await f.write(r.value.subarray(off));
            }
          } finally {
            reader.cancel().catch(() => {});
          }
        }
        f.close();
        closed = true;
        return { tmp, length };
      } catch (e) {
        if (!closed) { try { f.close(); } catch { /* closed */ } }
        await Deno.remove(tmp).catch(() => {});
        throw e;
      }
    },
    async commit(id: string, tmp: string, offset: number) {
      await Deno.rename(tmp, `${dirOf(id)}/p-${offset}`);
    },
    async discard(tmp: string) {
      await Deno.remove(tmp).catch(() => {});
    },
    // the first bytes of the file (from the piece at offset 0), for the intake's content type rule
    async head(id: string, n = 512): Promise<Uint8Array | null> {
      try {
        const f = await Deno.open(`${dirOf(id)}/p-0`, { read: true });
        try {
          const buf = new Uint8Array(n);
          let got = 0;
          while (got < n) {
            const r = await f.read(buf.subarray(got));
            if (r === null) break;
            got += r;
          }
          return buf.subarray(0, got);
        } finally {
          f.close();
        }
      } catch {
        return null;
      }
    },
    // Join the pieces in offset order into one file, hashing as it goes; the pieces are removed once the whole file is
    // written. A piece whose file is not the length its row records stops the join (damaged: the caller fails the session).
    async assemble(id: string, pieces: { offset: number; length: number }[]): Promise<AssembleResult> {
      const d = dirOf(id);
      const out = `${d}/assembled.part`;
      const hash = new Sha256();
      const w = await Deno.open(out, { write: true, create: true, truncate: true });
      let bytes = 0;
      try {
        for (const p of pieces) {
          const path = `${d}/p-${p.offset}`;
          const found = await sizeOf(path);
          if (found !== p.length) {
            w.close();
            await Deno.remove(out).catch(() => {});
            return { bytes, sha256: "", damaged: { offset: p.offset, expected: p.length, found: Math.max(0, found) } };
          }
          const r = await Deno.open(path, { read: true });
          try {
            const buf = new Uint8Array(1024 * 1024);
            while (true) {
              const n = await r.read(buf);
              if (n === null) break;
              const chunk = buf.subarray(0, n);
              hash.update(chunk);
              let off = 0;
              while (off < n) off += await w.write(chunk.subarray(off));
              bytes += n;
            }
          } finally {
            r.close();
          }
        }
        w.close();
      } catch (e) {
        try { w.close(); } catch { /* closed */ }
        await Deno.remove(out).catch(() => {});
        throw e;
      }
      await Deno.rename(out, `${d}/assembled`);
      for (const p of pieces) await Deno.remove(`${d}/p-${p.offset}`).catch(() => {});
      return { bytes, sha256: hash.hex(), damaged: null };
    },
    async readAssembled(id: string): Promise<Uint8Array | null> {
      try {
        return await Deno.readFile(`${dirOf(id)}/assembled`);
      } catch {
        return null;
      }
    },
    async dropAssembled(id: string) {
      await Deno.remove(`${dirOf(id)}/assembled.part`).catch(() => {});
      await Deno.remove(`${dirOf(id)}/assembled`).catch(() => {});
    },
    // remove a session's directory; answers the bytes it held (measured before removal)
    async remove(id: string): Promise<number> {
      const d = dirOf(id);
      const n = await bytesUnder(d);
      await Deno.remove(d, { recursive: true }).catch(() => {});
      return n;
    },
    // the session directories present (a name that is not a uuid is never the store's and is left alone)
    async sessions(): Promise<string[]> {
      const out: string[] = [];
      try {
        for await (const e of Deno.readDir(root)) if (e.isDirectory && UUID.test(e.name)) out.push(e.name);
      } catch { /* no directory yet */ }
      return out;
    },
    async usage(): Promise<number> {
      return await bytesUnder(root);
    },
  };
}
export type UploadStore = ReturnType<typeof uploadStore>;
