// The note's parse, cleaning and write-back (render.ts prepareDocument) in a WORKER, so its time is
// bounded (rw-p6a-resolve attempt 3). The parser is linear on ordinary text but not on every shape:
// a paragraph of thousands of unmatched emphasis or strikethrough delimiters costs it quadratic time,
// and a synchronous parse in the workbench's own thread would stall every request meanwhile. The
// limits before the parser (markdown.ts checkSourceLimits) refuse the known shapes by name; this
// worker is the backstop for any other: past its time it is terminated and the export refused 422
// `too-complex` ("the parser's time").
import { prepareDocument } from "./prepare.ts";

self.onmessage = (e: MessageEvent) => {
  const [md, refs, format, limits] = e.data;
  try {
    self.postMessage({ ok: true, prepared: prepareDocument(md, refs, format, limits) });
  } catch (err) {
    const x = err as Error & { limit?: string; value?: number; max?: number };
    self.postMessage({ ok: false, name: x?.constructor?.name ?? "Error", message: String(x?.message ?? err), limit: x.limit, value: x.value, max: x.max });
  }
};
