/**
 * llm-call - one chat-completion call for a compile, with the failure
 * classification of research-workbench D13 item 6.
 *
 *   TRANSIENT (the LLM did not perform): timeout, connection reset/refused,
 *     5xx, 408, 429 (admission pressure from llm-queue - never read as
 *     "unavailable"), an empty reply, a reply body that could not be read in
 *     full. Retry THE CALL ONLY, up to LLM_RETRIES (default 3) times with
 *     exponential backoff (LLM_RETRY_BACKOFF_MS, default 2000: 2s, 4s, 8s).
 *     On exhaustion the cheap endpoint check runs - GET <base>/models must
 *     list the model AND <root>/health/liveliness must answer (never /health
 *     through the alias: it loads every model) - and one notification fires:
 *       endpoint down / model not listed -> "model unavailable: <model>"
 *       endpoint fine                    -> "LLM call failing for this task: <task>"
 *     then CompileError("transient") is thrown; the caller puts the entity in
 *     the failed-ids ledger for the next compile. After a "model unavailable"
 *     verdict, later calls in the same run fail fast (no further calls).
 *   STRUCTURAL (not the LLM): the reply fails the page parser (`parse`), or
 *     the request itself is refused (4xx other than 408/429: a malformed
 *     request or a key the gateway rejects fails identically every time).
 *     NO retry; CompileError("structural") is thrown at once and the caller
 *     raises the "compile structural failure" notification, fails the run,
 *     and keeps the entity OUT of the ledger.
 * A reply that stopped at max_tokens (finish_reason "length") is a complete
 * HTTP response and is passed to the parser like any other; "truncated" here
 * means the body did not arrive whole.
 *
 * All inference goes through the LiteLLM gateway (repo rule); this module only
 * ever calls the base URL it is given.
 */
import { notify } from "./compile-notify.mjs";

export class CompileError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind; // "transient" | "structural"
    Object.assign(this, extra);
  }
}

const RETRIES = () => Math.max(0, Number(process.env.LLM_RETRIES ?? "3"));
const BACKOFF = () => Math.max(0, Number(process.env.LLM_RETRY_BACKOFF_MS ?? "2000"));
const TIMEOUT = () => Math.max(1000, Number(process.env.LLM_TIMEOUT_MS ?? "600000"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const _unavailable = new Set(); // models found unavailable this run

function rootOf(baseUrl) {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

// The cheap endpoint check. Returns { ok, why }.
export async function endpointCheck(baseUrl, apiKey, model) {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  let listed = false;
  try {
    const r = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return { ok: false, why: `/v1/models answered ${r.status}` };
    const j = await r.json();
    listed = Array.isArray(j?.data) && j.data.some((m) => m?.id === model);
    if (!listed) return { ok: false, why: `/v1/models does not list ${model}` };
  } catch (e) {
    return { ok: false, why: `/v1/models unreachable: ${e?.cause?.code || e?.message || e}` };
  }
  try {
    const r = await fetch(`${rootOf(base)}/health/liveliness`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return { ok: false, why: `/health/liveliness answered ${r.status}` };
  } catch (e) {
    return { ok: false, why: `/health/liveliness unreachable: ${e?.cause?.code || e?.message || e}` };
  }
  return { ok: true, why: "endpoint answers and lists the model" };
}

/**
 * opts: { baseUrl, apiKey, model, messages, temperature, max_tokens, headers,
 *         task (entity / notebook label for the notification), outDir,
 *         parse(text) -> page text (throws on a reply the page parser rejects) }
 * Returns the parsed page text. Throws CompileError.
 */
export async function chatComplete(opts) {
  const { baseUrl, apiKey, model, task, outDir } = opts;
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  if (_unavailable.has(model)) {
    throw new CompileError("transient", `model unavailable: ${model} (found unavailable earlier this run; not called)`);
  }
  const body = JSON.stringify({
    model, messages: opts.messages, temperature: opts.temperature ?? 0.3, max_tokens: opts.max_tokens ?? 2048,
  });
  const headers = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...(opts.headers || {}) };
  let last = "";
  const attempts = 1 + RETRIES();
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(BACKOFF() * 2 ** (i - 1));
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(TIMEOUT()) });
    } catch (e) {
      last = `call failed: ${e?.name === "TimeoutError" ? "timeout" : e?.cause?.code || e?.message || e}`;
      console.error(`[llm] ${task}: attempt ${i + 1}/${attempts} transient (${last})`);
      continue;
    }
    if (!res.ok) {
      const t = (await res.text().catch(() => "")).slice(0, 300);
      if (res.status >= 500 || res.status === 408 || res.status === 429) {
        last = `HTTP ${res.status} ${t}`;
        console.error(`[llm] ${task}: attempt ${i + 1}/${attempts} transient (${last.slice(0, 160)})`);
        continue;
      }
      throw new CompileError("structural", `LLM request refused: HTTP ${res.status} ${t}`);
    }
    let text;
    try {
      const j = await res.json();
      text = j?.choices?.[0]?.message?.content;
    } catch (e) {
      last = `reply body unreadable (truncated?): ${e?.message || e}`;
      console.error(`[llm] ${task}: attempt ${i + 1}/${attempts} transient (${last})`);
      continue;
    }
    if (typeof text !== "string" || !text.trim()) {
      last = "empty reply";
      console.error(`[llm] ${task}: attempt ${i + 1}/${attempts} transient (empty reply)`);
      continue;
    }
    // A reply arrived: the page parser decides. A rejection is STRUCTURAL - no retry.
    if (!opts.parse) return text.trim();
    try {
      return opts.parse(text);
    } catch (e) {
      throw new CompileError("structural", `reply failed the page parser: ${e?.message || e}`);
    }
  }
  // Exhausted: the cheap endpoint check decides which notification fires.
  const check = await endpointCheck(baseUrl, apiKey, model);
  if (!check.ok) {
    _unavailable.add(model);
    await notify({ cls: "transient", subject: `model unavailable: ${model}`, entity: task, error: `${last}; ${check.why}`, outDir });
    throw new CompileError("transient", `model unavailable: ${model} (${check.why}); last: ${last}`);
  }
  await notify({ cls: "transient", subject: `LLM call failing for this task: ${task}`, entity: task, error: last, outDir });
  throw new CompileError("transient", `LLM call failing for this task: ${task}; last: ${last}`);
}

// ── page parsers (the structural validation of a reply) ──────────────────────
// Entity page (generate-wiki SYSTEM_PROMPT: "# {Entity Name}, ## Summary ...").
export function parseEntityReply(text) {
  let t = String(text ?? "").trim();
  const fenced = /^```(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(t);
  if (fenced) t = fenced[1].trim();
  if (/^---\s*\r?\n/.test(t)) throw new Error("reply carries its own frontmatter block");
  const at = t.search(/^# \S/m);
  if (at < 0) throw new Error("reply has no '# <Entity Name>' heading");
  return t.slice(at).trim();
}

// Notebook synthesis (synthesize-notebooks SYSTEM_PROMPT: "STARTING AT ## Synthesis").
export function parseNotebookReply(text) {
  let t = String(text ?? "").trim();
  const fenced = /^```(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(t);
  if (fenced) t = fenced[1].trim();
  const at = t.search(/^## \S/m);
  if (at < 0) throw new Error("reply has no '## Synthesis' section");
  return t.slice(at).trim();
}

export function _resetLlmForTests() {
  _unavailable.clear();
}
