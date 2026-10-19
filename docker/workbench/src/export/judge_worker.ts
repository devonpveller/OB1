/// <reference lib="deno.worker" />
// One credential judging (credentials.ts judgeSecret) off the export's thread (rw-p6a-resolve2 attempt 2:
// judge_pool.ts, verify.ts). The same function, the same text, the same deadline: `at` is the deadline as
// an absolute time (performance.timeOrigin + performance.now() ms of the export's thread), read here
// against this worker's own clock; null is no deadline.
import { judgeSecret } from "./credentials.ts";

self.onmessage = (e: MessageEvent) => {
  const { text, secrets, at } = e.data as { text: string; secrets: string[]; at: number | null };
  try {
    self.postMessage({ verdict: judgeSecret(text, secrets, at === null ? Infinity : at - performance.timeOrigin) });
  } catch (err) {
    self.postMessage({ error: String((err as Error)?.message ?? err) });
  }
};
