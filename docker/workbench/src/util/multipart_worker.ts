// The worker half of multipart.ts (rw-upload-store-offthread, fix round 2). It parses a multipart body OFF the request
// thread: on deno 2.3.3 `Request.formData()` of 32 MiB holds its thread for ~0.7-1.0 s, and the request thread used to do
// it twice (the owner-scope seam, then the route) plus a text() decode: ~3 s in which nobody else was answered.
// It keeps every text field (in order, so a repeated name is not lost) and the bytes of the part named `file` only.
export type ParseRequest = { id: number; ct: string; buf: ArrayBuffer };
export type ParseReply = {
  id: number;
  entries?: [string, string][];
  file?: { name: string; type: string; buf: ArrayBuffer } | null;
  error?: string;
  inWorker?: boolean; // the thread marker the tests read: this reply was made inside a Worker
};

const WGS = (globalThis as { WorkerGlobalScope?: new () => unknown }).WorkerGlobalScope;
const inWorker = !!WGS && self instanceof (WGS as unknown as { new (): unknown });

export async function parseMultipart(ct: string, buf: ArrayBuffer): Promise<Omit<ParseReply, "id">> {
  const fd = await new Request("http://upload.invalid/", { method: "POST", headers: { "content-type": ct }, body: buf }).formData();
  const entries: [string, string][] = [];
  let file: { name: string; type: string; buf: ArrayBuffer } | null = null;
  for (const [k, v] of fd.entries()) {
    if (typeof v === "string") entries.push([k, v]);
    else if (k === "file") file = { name: v.name, type: v.type, buf: await v.arrayBuffer() };
  }
  return { entries, file };
}

if (inWorker) {
  (self as unknown as { onmessage: (ev: MessageEvent<ParseRequest>) => void }).onmessage = async (ev) => {
    const m = ev.data;
    let reply: ParseReply;
    try {
      reply = { id: m.id, ...(await parseMultipart(m.ct, m.buf)), inWorker };
    } catch (e) {
      reply = { id: m.id, error: String((e as Error)?.message ?? e).slice(0, 300), inWorker };
    }
    const move = reply.file ? [reply.file.buf] : [];
    (self as unknown as { postMessage(r: ParseReply, t: Transferable[]): void }).postMessage(reply, move);
  };
}
