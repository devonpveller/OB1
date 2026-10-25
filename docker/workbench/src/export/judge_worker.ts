/// <reference lib="deno.worker" />
// One credential judging (credentials.ts judgeSecret) off the export's thread (rw-p6a-resolve2 attempt 2:
// judge_pool.ts, verify.ts). The same function, the same text, the same deadline: `at` is the deadline as
// an absolute time (performance.timeOrigin + performance.now() ms of the export's thread), read here
// against this worker's own clock; null is no deadline.
// rw-p6a-followups round 2: also the MD output's re-parse (markdown.ts markdownOffence, ~300 ms per MB), so
// concurrent MD exports no longer stack their parses on the export's thread; markdown.ts is loaded only by a
// worker that is given one.
import { judgeSecret } from "./credentials.ts";

self.onmessage = async (e: MessageEvent) => {
  const { op, text, secrets, at } = e.data as { op?: "offence"; text: string; secrets: string[]; at: number | null };
  try {
    if (op === "offence") {
      const { markdownOffence } = await import("./markdown.ts");
      self.postMessage({ offence: markdownOffence(text) });
      return;
    }
    self.postMessage({ verdict: judgeSecret(text, secrets, at === null ? Infinity : at - performance.timeOrigin) });
  } catch (err) {
    self.postMessage({ error: String((err as Error)?.message ?? err) });
  }
};
