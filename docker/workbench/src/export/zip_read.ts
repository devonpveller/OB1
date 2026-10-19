// A minimal ZIP reader for the export's tests (rw-p6a-resolve attempt 2): the XML parts of a DOCX,
// read back to assert what the file CARRIES (raw HTML, scripts, javascript: links), not only what a
// converter shows. Stored and deflated entries; the central directory is the index. No dependency.

export async function zipEntries(zip: Uint8Array): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no end of central directory)");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    const lName = dv.getUint16(local + 26, true), lExtra = dv.getUint16(local + 28, true);
    const data = zip.subarray(local + 30 + lName + lExtra, local + 30 + lName + lExtra + csize);
    if (method === 0) out.set(name, data.slice());
    else if (method === 8) {
      const s = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      out.set(name, new Uint8Array(await new Response(s).arrayBuffer()));
    } else throw new Error(`zip method ${method} not supported (${name})`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// Every XML part of a DOCX (document, relationships, properties) as one string.
export async function docxXml(docx: Uint8Array): Promise<string> {
  const parts = await zipEntries(docx);
  return [...parts].filter(([n]) => /\.(xml|rels)$/.test(n)).map(([n, b]) => `<!-- ${n} -->\n${new TextDecoder().decode(b)}`).join("\n");
}
