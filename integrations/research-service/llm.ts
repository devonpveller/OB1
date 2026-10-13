/**
 * llm.ts — the research engine's chat seam, with an upstream-DOWN fast path
 * (mr-research-failfast, 2026-10-13).
 *
 * Why this exists. On 2026-10-13 the model container was stopped for ~7 h. Every
 * chat() call treated the gateway's 502 ("llm-queue: [Errno -3] Temporary failure
 * in name resolution") as backpressure and retried for the full 25-minute
 * CHAT_RETRY_BUDGET_MS. An article job makes three calls, so each job took ~77
 * minutes to fail, serially, while its caller had long given up.
 *
 * Two different conditions were sharing one budget:
 *
 *   OVERLOAD  429 / 503 / 504, or a 502 that does not name an unreachable upstream:
 *             the queue is saturated or the model is swapping. The request WILL
 *             be served if we come back - keep riding it out for the long budget.
 *   DOWN      the gateway answered, but says the model upstream cannot be reached
 *             (name resolution, connection refused, upstream_error), or the
 *             gateway itself cannot be reached. Waiting 25 minutes per call does
 *             not make it come back - a short budget (CHAT_DOWN_BUDGET_MS), then
 *             a process-wide DOWN latch so every later call fails at once.
 *
 * The latch (ModelHealth) is the "model down" signal for the job layer: a job
 * whose call hit it is PAUSED (requeued), the dispatcher stops claiming, and a
 * single probe re-checks the model on an interval; the first success clears it.
 *
 * Everything time-shaped (fetch, sleep, now) is injectable so tests drive the
 * REAL retry loop against a real stub HTTP gateway on a virtual clock.
 */

export type FailureClass = "down" | "overload" | "fatal";

/** Bodies that mean "the model upstream is unreachable", not "busy". Matched on
 *  500/502/503 only. The first alternative is the exact 2026-10-13 body:
 *  `litellm.BadGatewayError: ... OpenAIException - llm-queue: [Errno -3]
 *  Temporary failure in name resolution`. llm-queue's own envelope says
 *  `"type": "upstream_error"`. */
const DOWN_BODY =
  /name resolution|name or service not known|nodename nor servname|connection refused|connecterror|connect error|connection error|apiconnectionerror|cannot connect to host|no route to host|host is unreachable|network is unreachable|upstream_error|\[errno -[23]\]|\[errno 111\]/i;

export function classifyChatFailure(status: number, body: string): FailureClass {
  if ((status === 500 || status === 502 || status === 503) && DOWN_BODY.test(body)) return "down";
  if (status === 429 || status === 502 || status === 503 || status === 504) return "overload";
  return "fatal";
}

/** Thrown when the model is DOWN (short budget exhausted, latch already set, or
 *  a failFast caller saw a down answer). `code` is the machine-readable signal. */
export class ModelDownError extends Error {
  readonly code = "model_down";
  constructor(readonly reason: string, readonly latched: boolean) {
    super(`model_down: ${reason}`);
    this.name = "ModelDownError";
  }
}

export function isModelDownError(e: unknown): e is ModelDownError {
  return e instanceof ModelDownError || (e as { code?: string })?.code === "model_down";
}

export interface ModelHealthSnapshot {
  state: "up" | "down";
  since: string | null;
  reason: string | null;
  last_check: string | null;
}

/** Process-wide model-down latch. One instance per process. */
export class ModelHealth {
  #downSince: number | null = null;
  #reason = "";
  #lastCheck: number | null = null;
  constructor(private readonly log: (line: string) => void = console.log) {}

  get isDown(): boolean { return this.#downSince !== null; }
  get downSince(): number | null { return this.#downSince; }
  get reason(): string { return this.#reason; }

  markDown(reason: string, now: number): void {
    if (this.#downSince === null) {
      this.#downSince = now;
      this.log(`[model] DOWN: ${reason} - pausing research until a probe succeeds`);
    }
    this.#reason = reason;
    this.#lastCheck = now;
  }

  markUp(now: number): void {
    if (this.#downSince !== null) {
      this.log(`[model] UP again after ${Math.round((now - this.#downSince) / 1000)}s down`);
    }
    this.#downSince = null;
    this.#reason = "";
    this.#lastCheck = now;
  }

  noteCheck(now: number): void { this.#lastCheck = now; }

  snapshot(): ModelHealthSnapshot {
    return {
      state: this.isDown ? "down" : "up",
      since: this.#downSince === null ? null : new Date(this.#downSince).toISOString(),
      reason: this.isDown ? this.#reason : null,
      last_check: this.#lastCheck === null ? null : new Date(this.#lastCheck).toISOString(),
    };
  }
}

export interface ChatOpts {
  json?: boolean;
  nothink?: boolean;
  /** Fail-open classifiers: on a DOWN answer throw ModelDownError at once instead
   *  of retrying (they would fail open anyway; waiting buys nothing). */
  failFast?: boolean;
  /** Job cancellation: aborts the in-flight request and the retry loop. */
  signal?: AbortSignal;
}

export interface ChatConfig {
  base: string;
  apiKey: string;
  model: string;
  nothinkSuffix: string;
  retryBudgetMs: number; // OVERLOAD budget per call (default 25 min)
  downBudgetMs: number; // DOWN budget per call (default 3 min)
  fetchTimeoutMs: number; // per-attempt bound (a stalled TCP connection)
  probeTimeoutMs: number;
  health: ModelHealth;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  backoff?: (attempt: number) => number;
  log?: (line: string) => void;
}

export function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal!.reason ?? new DOMException("aborted", "AbortError")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Capped exponential backoff with jitter: ~10s, 15s, 22s … cap 90s. */
export function backoffMs(attempt: number): number {
  const base = Math.min(90_000, 10_000 * Math.pow(1.5, attempt));
  return Math.floor(base * (0.75 + Math.random() * 0.5));
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("aborted", "AbortError");
}

/** Builds the per-process chat() and probe() over one ModelHealth latch. */
export function createChat(cfg: ChatConfig) {
  const fetchFn = cfg.fetch ?? fetch;
  const sleep = cfg.sleep ?? realSleep;
  const now = cfg.now ?? Date.now;
  const backoff = cfg.backoff ?? backoffMs;
  const log = cfg.log ?? console.log;
  const url = `${cfg.base}/chat/completions`;
  const headers = { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" };

  type Attempt =
    | { ok: true; content: string }
    | { ok: false; cls: FailureClass; detail: string; status: number };

  async function attempt(body: string, timeoutMs: number, signal?: AbortSignal): Promise<Attempt> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let r: Response;
    try {
      r = await fetchFn(url, { method: "POST", headers, body, signal: sig });
    } catch (e) {
      if (signal?.aborted) throw abortError(signal);
      if (timeout.aborted) {
        // Bounded wait (C6): the gateway took the request and never answered.
        // Not evidence the model is gone - count it as overload.
        return { ok: false, cls: "overload", status: 0, detail: `no response within ${timeoutMs}ms` };
      }
      // The gateway itself is unreachable (connection refused, DNS): down.
      return { ok: false, cls: "down", status: 0, detail: `network: ${(e as Error).message}`.slice(0, 300) };
    }
    if (r.ok) {
      const d = await r.json();
      return { ok: true, content: d?.choices?.[0]?.message?.content ?? "" };
    }
    const text = (await r.text()).slice(0, 300);
    return { ok: false, cls: classifyChatFailure(r.status, text), status: r.status, detail: text };
  }

  async function chat(system: string, user: string, opts: ChatOpts = {}, queueUser = ""): Promise<string> {
    const model = opts.nothink ? `${cfg.model}${cfg.nothinkSuffix}` : cfg.model;
    const body = JSON.stringify({
      model, temperature: 0.2,
      ...(queueUser ? { user: queueUser } : {}),
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    });
    const deadline = now() + cfg.retryBudgetMs;
    let downStartedAt: number | null = null;
    for (let i = 0; ; i++) {
      if (opts.signal?.aborted) throw abortError(opts.signal);
      // The latch: once the model is confirmed down, nobody spends a budget on it.
      if (cfg.health.isDown) throw new ModelDownError(cfg.health.reason, true);
      const a = await attempt(body, cfg.fetchTimeoutMs, opts.signal);
      if (a.ok) {
        cfg.health.markUp(now());
        return a.content;
      }
      const label = a.status ? `chat ${a.status}` : "chat";
      if (a.cls === "fatal") throw new Error(`chat ${a.status}: ${a.detail}`);
      if (a.cls === "down") {
        const reason = `${label}: ${a.detail}`;
        if (opts.failFast) throw new ModelDownError(reason, false);
        downStartedAt ??= now();
        if (now() - downStartedAt >= cfg.downBudgetMs || now() >= deadline) {
          cfg.health.markDown(reason, now());
          throw new ModelDownError(reason, true);
        }
        log(`${label} (upstream down); retry in ${Math.round(backoff(i) / 1000)}s [attempt ${i + 1}]`);
      } else {
        downStartedAt = null; // reachable again, just busy
        if (now() >= deadline) throw new Error(a.status ? `chat ${a.status}: ${a.detail}` : `chat: ${a.detail}`);
        log(`${label} (backpressure); retry in ${Math.round(backoff(i) / 1000)}s [attempt ${i + 1}]`);
      }
      await sleep(backoff(i), opts.signal);
    }
  }

  /** One bounded re-check of the model (single attempt, bypasses the latch).
   *  Returns true when the model answered or is reachable-but-busy; false when
   *  it is still DOWN or did not answer within probeTimeoutMs. */
  async function probe(queueUser = ""): Promise<boolean> {
    const body = JSON.stringify({
      model: `${cfg.model}${cfg.nothinkSuffix}`, temperature: 0, max_tokens: 1,
      ...(queueUser ? { user: queueUser } : {}),
      messages: [{ role: "user", content: "ping" }],
    });
    let a: Attempt;
    try {
      a = await attempt(body, cfg.probeTimeoutMs);
    } catch (e) {
      cfg.health.noteCheck(now());
      log(`[model] probe failed: ${(e as Error).message}`);
      return false;
    }
    if (a.ok || (a.cls !== "down" && a.status !== 0)) {
      cfg.health.markUp(now());
      return true;
    }
    if (a.cls === "down") cfg.health.markDown(`${a.status ? `chat ${a.status}` : "chat"}: ${a.detail}`, now());
    else cfg.health.noteCheck(now());
    return false;
  }

  return { chat, probe };
}
