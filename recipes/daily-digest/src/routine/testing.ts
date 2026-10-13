/**
 * Test helpers for the morning-routine suites (mr-routine-outage). NOT used by
 * production code.
 *
 *  - guardNetwork(): every fetch to a host other than 127.0.0.1 / localhost
 *    throws. No test can send a real email / Telegram / Gmail / Calendar call,
 *    whatever the code under test is configured with.
 *  - VirtualClock: the routine's clock in the 01:00-08:00 scenarios. Real I/O
 *    (stub HTTP, files, subprocesses) still runs in real time; advanceTo()
 *    fires virtual timers one at a time and waits for real work to go quiet in
 *    between.
 *  - stub servers on 127.0.0.1:0 that RECORD what they were sent.
 */

import type { Clock } from "./clock.ts";

// ── network guard ────────────────────────────────────────────────────────────
let guarded = false;
export function guardNetwork(): void {
  if (guarded) return;
  guarded = true;
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      return Promise.reject(new TypeError(`test network guard: refused ${url.protocol}//${url.hostname}`));
    }
    return real(input, init);
  }) as typeof fetch;
}

// ── activity tracking (for settle) ───────────────────────────────────────────
export const activity = { inFlight: 0, ticks: 0, busy: [] as Array<() => boolean> };
function touch() {
  activity.ticks++;
}

// ── virtual clock ────────────────────────────────────────────────────────────
interface Timer {
  at: number;
  seq: number;
  resolve: () => void;
}

export class VirtualClock implements Clock {
  #now: number;
  #seq = 0;
  #timers: Timer[] = [];
  constructor(start: number) {
    this.#now = start;
  }
  now(): number {
    return this.#now;
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const t: Timer = { at: this.#now + Math.max(0, ms), seq: this.#seq++, resolve };
      this.#timers.push(t);
      touch();
      signal?.addEventListener("abort", () => {
        this.#timers = this.#timers.filter((x) => x !== t);
        reject(signal.reason);
      }, { once: true });
    });
  }
  get timers(): number[] {
    return this.#timers.map((t) => t.at).sort((a, b) => a - b);
  }

  /** Wait (real time) until nothing real is happening: no stub request in
   *  flight, no busy predicate true, and no new activity for `quietMs`. */
  async settle(quietMs = 60, maxMs = 60_000): Promise<void> {
    const start = Date.now();
    let lastTicks = -1;
    let quietSince = Date.now();
    while (Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 10));
      const busy = activity.inFlight > 0 || activity.busy.some((b) => b());
      if (busy || activity.ticks !== lastTicks) {
        lastTicks = activity.ticks;
        quietSince = Date.now();
        continue;
      }
      if (Date.now() - quietSince >= quietMs) return;
    }
    throw new Error("VirtualClock.settle: real work did not go quiet within the bound");
  }

  /** Fire every virtual timer due up to `t`, in order, settling between. */
  async advanceTo(t: number): Promise<void> {
    while (true) {
      await this.settle();
      this.#timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.#timers[0];
      if (!next || next.at > t) break;
      this.#timers.shift();
      this.#now = Math.max(this.#now, next.at);
      touch();
      next.resolve();
    }
    this.#now = Math.max(this.#now, t);
    await this.settle();
  }
}

// ── stub server base ─────────────────────────────────────────────────────────
export interface Stub {
  url: string;
  port: number;
  close(): Promise<void>;
}

export function stubServer(handler: (req: Request, path: string) => Promise<Response> | Response): Stub {
  const ac = new AbortController();
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} }, async (req) => {
    activity.inFlight++;
    touch();
    try {
      return await handler(req, new URL(req.url).pathname);
    } finally {
      activity.inFlight--;
      touch();
    }
  });
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    port: server.addr.port,
    async close() {
      ac.abort();
      await server.finished;
    },
  };
}

// ── LLM gateway stub ─────────────────────────────────────────────────────────
/** The exact body the 2026-10-13 outage returned (research_jobs.error of job
 *  37b3e59f, same fixture as research-service/fixtures/upstream-down.ts). */
export const UPSTREAM_DOWN_502 =
  String.raw`{"error":{"message":"litellm.BadGatewayError: BadGatewayError: OpenAIException - llm-queue: [Errno -3] Temporary failure in name resolution. Received Model Group=local-large\nAvailable Model Group Fallbacks=None","type":null,"param":null,"code":"502"}}`;

export type GatewayMode = "up" | "down" | "slow" | "overload502";

export interface GatewayStub extends Stub {
  mode: GatewayMode;
  slowMs: number;
  /** Every request: method + path + model + whether it was a 1-token probe. */
  log: Array<{ method: string; path: string; model?: string; probe?: boolean; at: number }>;
  /** Chat calls that were NOT 1-token probes (real model work). */
  work(): Array<{ model?: string; at: number }>;
  healthGets(): number;
  answer: (prompt: string, model: string) => string;
}

export function gatewayStub(initial: GatewayMode = "up"): GatewayStub {
  const g = {
    mode: initial as GatewayMode,
    slowMs: 300,
    log: [] as GatewayStub["log"],
    answer: (_p: string, _m: string) => "VERDICT: KEEP\nok",
  } as GatewayStub;
  const s = stubServer(async (req, path) => {
    const at = Date.now();
    if (req.method === "GET") {
      g.log.push({ method: "GET", path, at });
      if (path === "/health") {
        // LiteLLM /health loads EVERY model: a test that hits it must fail.
        return new Response("GET /health is forbidden (loads every model)", { status: 599 });
      }
      if (path === "/health/liveliness") return new Response(`"I'm alive!"`, { status: 200 });
      return new Response("nf", { status: 404 });
    }
    const body = await req.json().catch(() => ({})) as {
      model?: string;
      max_tokens?: number;
      messages?: Array<{ content: string }>;
    };
    const probe = body.max_tokens === 1;
    g.log.push({ method: "POST", path, model: body.model, probe, at });
    if (g.mode === "down") return new Response(UPSTREAM_DOWN_502, { status: 502, headers: { "content-type": "application/json" } });
    if (g.mode === "overload502") return new Response(`{"error":{"message":"queue full"}}`, { status: 502 });
    if (g.mode === "slow") await new Promise((r) => setTimeout(r, g.slowMs));
    const prompt = (body.messages ?? []).map((m) => m.content).join("\n");
    const content = probe ? "p" : g.answer(prompt, body.model ?? "");
    return Response.json({
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    });
  });
  return Object.assign(g, s, {
    work: () => g.log.filter((l) => l.method === "POST" && !l.probe),
    healthGets: () => g.log.filter((l) => l.method === "GET" && l.path === "/health").length,
  });
}

// ── Gmail API stub (the REAL GmailClient talks to it) ───────────────────────
export interface SentMail {
  subject: string;
  to: string;
  html: string;
  at: number;
  /** X-OpenBrain-Digest header, if any. */
  marker: string;
}
export interface GmailStub extends Stub {
  mode: "ok" | "fail500";
  sent: SentMail[];
  attempts: number;
  /** Sent-folder reads (messages.list / messages.get) - what the Sent check asked. */
  reads: number;
  /** Sent-folder answers 403 (a gmail.send-only token). */
  readForbidden: boolean;
}

function b64urlDecode(s: string): string {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(b, (c) => c.charCodeAt(0)));
}

export function gmailStub(clock: { now(): number }): GmailStub {
  const g = { mode: "ok", sent: [] as SentMail[], attempts: 0, reads: 0, readForbidden: false } as GmailStub;
  const s = stubServer(async (req, path) => {
    // Sent folder (read-only check): list SENT newest first, get headers.
    if (req.method === "GET" && path.startsWith("/gmail/v1/users/me/messages")) {
      g.reads++;
      if (g.readForbidden) return Response.json({ error: { code: 403, message: "Request had insufficient authentication scopes." } }, { status: 403 });
      const id = path.split("/").pop()!;
      if (id === "messages") {
        const u = new URL(req.url);
        if (u.searchParams.get("labelIds") !== "SENT") return Response.json({ messages: [] });
        return Response.json({ messages: g.sent.map((_, i) => ({ id: `m${i + 1}` })).reverse() });
      }
      const m = g.sent[Number(id.slice(1)) - 1];
      if (!m) return Response.json({ error: { code: 404 } }, { status: 404 });
      return Response.json({ id, payload: { headers: m.marker ? [{ name: "X-OpenBrain-Digest", value: m.marker }] : [] } });
    }
    if (req.method !== "POST" || path !== "/gmail/v1/users/me/messages/send") return new Response("nf", { status: 404 });
    g.attempts++;
    const { raw } = await req.json() as { raw: string };
    if (g.mode === "fail500") return new Response(`{"error":{"code":500,"message":"backend error"}}`, { status: 500 });
    const msg = b64urlDecode(raw);
    const [head, ...rest] = msg.split("\r\n\r\n");
    const subjLine = head.split("\r\n").find((l) => l.startsWith("Subject: ")) ?? "";
    const enc = /=\?UTF-8\?B\?(.*)\?=/.exec(subjLine)?.[1] ?? "";
    const subject = new TextDecoder().decode(Uint8Array.from(atob(enc), (c) => c.charCodeAt(0)));
    const to = (head.split("\r\n").find((l) => l.startsWith("To: ")) ?? "").slice(4);
    const marker = (head.split("\r\n").find((l) => l.startsWith("X-OpenBrain-Digest: ")) ?? "").slice(20);
    g.sent.push({ subject, to, html: rest.join("\r\n\r\n"), at: clock.now(), marker });
    return Response.json({ id: `m${g.sent.length}` });
  });
  return Object.assign(g, s);
}

/** credentials.json + a non-expired fake token.json, so GoogleOAuth never refreshes. */
export async function fakeOAuthFiles(dir: string): Promise<{ credentialsPath: string; tokenPath: string }> {
  await Deno.mkdir(dir, { recursive: true });
  const credentialsPath = `${dir}/credentials.json`;
  const tokenPath = `${dir}/token.json`;
  await Deno.writeTextFile(credentialsPath, JSON.stringify({ installed: { client_id: "test", client_secret: "test", redirect_uris: [] } }));
  await Deno.writeTextFile(
    tokenPath,
    JSON.stringify({ access_token: "fake-access", refresh_token: "fake-refresh", token_type: "Bearer", expiry_date: Date.now() + 30 * 86400_000 }),
  );
  return { credentialsPath, tokenPath };
}

// ── Telegram Bot API stub ────────────────────────────────────────────────────
export interface TelegramStub extends Stub {
  messages: Array<{ chatId: string; text: string; at: number }>;
  /** Real-time answer delay (an alert in flight). */
  delayMs: number;
}
export function telegramStub(clock: { now(): number }): TelegramStub {
  const t = { messages: [] as TelegramStub["messages"], delayMs: 0 } as TelegramStub;
  const s = stubServer(async (req, path) => {
    if (req.method !== "POST" || !/^\/bot[^/]+\/sendMessage$/.test(path)) return new Response("nf", { status: 404 });
    if (t.delayMs) await new Promise((r) => setTimeout(r, t.delayMs));
    const form = new URLSearchParams(await req.text());
    t.messages.push({ chatId: form.get("chat_id") ?? "", text: form.get("text") ?? "", at: clock.now() });
    return Response.json({ ok: true, result: { message_id: t.messages.length } });
  });
  return Object.assign(t, s);
}

// ── owner channel (Mattermost #sysadmin) stub ────────────────────────────────
export interface OwnerStub extends Stub {
  posts: Array<{ channel: string; message: string; at: number }>;
}
export function ownerStub(clock: { now(): number }): OwnerStub {
  const o = { posts: [] as OwnerStub["posts"] } as OwnerStub;
  const s = stubServer(async (req, path) => {
    if (req.method !== "POST" || path !== "/api/v4/posts") return new Response("nf", { status: 404 });
    const b = await req.json() as { channel_id: string; message: string };
    o.posts.push({ channel: b.channel_id, message: b.message, at: clock.now() });
    return Response.json({ id: `p${o.posts.length}` }, { status: 201 });
  });
  return Object.assign(o, s);
}

/** research-engine /health stub: {ok, model:{state}} as mr-research-failfast serves it. */
export function researchHealthStub(): Stub & { state: "up" | "down" } {
  const r = { state: "up" as "up" | "down" };
  const s = stubServer(() => Response.json({ ok: true, model: { state: r.state, reason: r.state === "down" ? "model_unreachable" : null } }));
  return Object.assign(r, s);
}

// ── brain (PostgREST) stub ───────────────────────────────────────────────────
export const NEWSLETTER_BODY = Array.from(
  { length: 8 },
  (_, i) =>
    `Paragraph ${i + 1}: the newsletter discusses model routing, queue admission and how a local inference stack recovers after an outage without losing the morning brief.`,
).join("\n\n");

export function brainStub(): Stub & { requests: string[] } {
  const requests: string[] = [];
  const thought = {
    id: "t1",
    content: `[Email from Test Letter <letter@example.test> | Subject: Routing notes | Date: 2026-10-13]\n${NEWSLETTER_BODY}`,
    metadata: {
      gmail_id: "g1",
      gmail_thread_id: "g1",
      gmail_labels: ["brain/test"],
      chunk_index: 0,
      chunk_count: 1,
      email_date: "2026-10-13T04:00:00Z",
      topics: ["inference"],
    },
    created_at: "2026-10-13T04:00:00Z",
  };
  const s = stubServer((req, path) => {
    const u = new URL(req.url);
    requests.push(`${req.method} ${path}${u.search}`);
    // a READ-only stub (GET): nothing is ever inserted. Matched by regex so the
    // ai-stack corpus-exposure gate does not take this read route for a producer.
    if (req.method === "GET" && /^\/rest\/v1\/thoughts$/.test(path)) {
      const typeFilters = u.searchParams.getAll("metadata->>type");
      if (typeFilters.some((f) => f.startsWith("eq."))) return Response.json([]); // profile_field / calendar_event
      return Response.json([thought]);
    }
    if (path.startsWith("/rest/v1/sources")) return Response.json([]);
    if (path.startsWith("/rest/v1/rpc/")) return Response.json([]);
    return Response.json([]);
  });
  return Object.assign(s, { requests });
}

export async function postJson(url: string, body: unknown = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** Real-time poll until `pred` (bounded). */
export async function until(pred: () => boolean | Promise<boolean>, maxMs = 30_000, stepMs = 50): Promise<void> {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`until: condition not met within ${maxMs} ms`);
}
