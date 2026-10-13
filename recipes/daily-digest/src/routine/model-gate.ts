/**
 * Model gate (mr-routine-outage): "is the model reachable through the
 * gateway?" before a routine step does model work, and a bounded wait for it
 * to come back.
 *
 * 2026-10-13: the model was down 01:00-08:00 local, every step ran anyway and
 * degraded (pull ingested nothing, research timed out link by link), and the
 * digest went out at 08:40 only after a manual re-run. The gate turns "model
 * down" into WAIT (bounded backoff) instead of a degraded run.
 *
 * The probe NEVER GETs LiteLLM `/health` (it loads every model). It does:
 *   1. GET <gateway origin>/health/liveliness - LiteLLM's process liveness, no
 *      model work. Not answering = the gateway itself is down.
 *   2. one bounded `max_tokens: 1` chat completion for the step's own model, the
 *      same cheap probe the research engine uses (mr-research-failfast llm.ts
 *      `probe()`). LiteLLM being alive says nothing about the upstream: on
 *      10-13 LiteLLM and llm-queue were up and llama-cpp-upstream was stopped.
 * Classification mirrors research-service/llm.ts `classifyChatFailure`: a
 * 500/502/503 whose body says the upstream is unreachable is DOWN; any other
 * HTTP answer (200, 429 busy, 503 swap, a llama-swap 500 load timeout)
 * means the model path is REACHABLE - waiting would not fix those, so
 * the step proceeds and its own error handling applies. A probe the gateway
 * REJECTS (400/401/403/404) is NOT reachable-proof: it reads down.
 */

import type { Clock } from "./clock.ts";

/** Same alternatives as OB1/integrations/research-service/llm.ts DOWN_BODY. */
const DOWN_BODY =
  /name resolution|name or service not known|nodename nor servname|connection refused|connecterror|connect error|connection error|apiconnectionerror|cannot connect to host|no route to host|host is unreachable|network is unreachable|upstream_error|\[errno -[23]\]|\[errno 111\]/i;

export function isDownAnswer(status: number, body: string): boolean {
  return (status === 500 || status === 502 || status === 503) && DOWN_BODY.test(body);
}

export interface ModelProbeResult {
  state: "up" | "down";
  /** Short, content-free reason (status code / error class). */
  reason: string;
}

export interface ProbeOptions {
  /** OpenAI-style base, e.g. http://llama-cpp:8080/v1 (the LiteLLM alias). */
  chatBase: string;
  /** The model the step will use (e.g. local-small, local-large:nothink). */
  model: string;
  apiKey?: string;
  /** Per-request bound. The chat probe may trigger a cold load (2-5 min). */
  livenessTimeoutMs?: number;
  probeTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

/** One bounded probe. Never throws. */
export async function probeModel(o: ProbeOptions): Promise<ModelProbeResult> {
  const f = o.fetchFn ?? fetch;
  const base = o.chatBase.replace(/\/$/, "");
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    return { state: "down", reason: "bad gateway url" };
  }
  try {
    const r = await f(`${origin}/health/liveliness`, { signal: AbortSignal.timeout(o.livenessTimeoutMs ?? 10_000) });
    await r.body?.cancel();
    if (!r.ok) return { state: "down", reason: `gateway liveliness ${r.status}` };
  } catch (e) {
    return { state: "down", reason: `gateway unreachable (${errClass(e)})` };
  }
  try {
    const r = await f(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${o.apiKey || "no-key"}` },
      body: JSON.stringify({ model: o.model, temperature: 0, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(o.probeTimeoutMs ?? 660_000),
    });
    const body = await r.text().catch(() => "");
    if (r.ok) return { state: "up", reason: `chat ${r.status}` };
    if (isDownAnswer(r.status, body)) return { state: "down", reason: `chat ${r.status} upstream unreachable` };
    // Round 2: a probe the gateway REJECTS (400 unknown model, 401/403 key, 404)
    // proves nothing about the model - never "up". It reads down (with the
    // reason), so the step waits and the deadline digest + alert surface it.
    if (r.status >= 400 && r.status < 500 && r.status !== 429) {
      return { state: "down", reason: `chat ${r.status} probe rejected by the gateway (model name / key?)` };
    }
    return { state: "up", reason: `chat ${r.status} (reachable)` };
  } catch (e) {
    return { state: "down", reason: `chat probe failed (${errClass(e)})` };
  }
}

function errClass(e: unknown): string {
  const n = (e as Error)?.name ?? "";
  if (n === "TimeoutError") return "timeout";
  if (n === "AbortError") return "aborted";
  return n || "error";
}

export interface WaitOptions {
  probe: () => Promise<ModelProbeResult>;
  clock: Clock;
  /** Absolute epoch ms: stop waiting (and report down) at this instant. */
  until: number;
  initialMs?: number; // first backoff, default 30 s
  maxMs?: number; // backoff cap, default 5 min
  label?: string;
  signal?: AbortSignal;
  log?: (msg: string) => void;
  /** Called once when the first probe says down (persist "waiting since"). */
  onDown?: (since: number, reason: string) => void | Promise<void>;
}

export interface WaitResult {
  up: boolean;
  probes: number;
  waitedMs: number;
  downSince: number | null;
  lastReason: string;
}

/**
 * Probe; while DOWN, sleep with capped exponential backoff and probe again,
 * never past `until`. Bounded by `until` (and so by probes <= log2 + span/maxMs).
 * Returns up=false only when `until` passed with the model still down.
 */
export async function waitForModel(o: WaitOptions): Promise<WaitResult> {
  const log = o.log ?? ((m: string) => console.log(m));
  const label = o.label ?? "model-gate";
  const initial = Math.max(1, o.initialMs ?? 30_000);
  const cap = Math.max(initial, o.maxMs ?? 300_000);
  const start = o.clock.now();
  let delay = initial;
  let probes = 0;
  let downSince: number | null = null;
  let last: ModelProbeResult = { state: "down", reason: "not probed" };
  while (true) {
    if (o.signal?.aborted) throw o.signal.reason;
    last = await o.probe();
    probes++;
    if (last.state === "up") {
      if (downSince !== null) log(`[${label}] model back (${last.reason}) after ${Math.round((o.clock.now() - downSince) / 1000)}s; resuming.`);
      return { up: true, probes, waitedMs: o.clock.now() - start, downSince, lastReason: last.reason };
    }
    if (downSince === null) {
      downSince = o.clock.now();
      log(`[${label}] model DOWN (${last.reason}); waiting - no degraded run.`);
      await o.onDown?.(downSince, last.reason);
    }
    const now = o.clock.now();
    if (now >= o.until) {
      log(`[${label}] model still down at the wait bound; giving up (${last.reason}).`);
      return { up: false, probes, waitedMs: now - start, downSince, lastReason: last.reason };
    }
    await o.clock.sleep(Math.min(delay, o.until - now), o.signal);
    delay = Math.min(cap, delay * 2);
  }
}
