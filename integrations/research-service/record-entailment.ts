/**
 * record-entailment.ts - re-record the entailment fixture layer from a REAL judge
 * (research-workbench P3a). Operator/tester tool; never run by the test suite.
 *
 *   deno run --allow-read --allow-write --allow-net --allow-env record-entailment.ts job-100hz [job-optiplex ...]
 *
 * It replays exactly what the stage does - citedLines -> citedWindows -> ENTAIL_SYS - against the
 * model behind CHAT_API_BASE (default http://llama-cpp:8080/v1, the LiteLLM alias on llm-gateway;
 * never an *-upstream address) with CHAT_API_KEY, which must be the research service's own
 * LiteLLM virtual key, and rewrites fixtures/entailment/<job>.entail.json with the RECORDED
 * responses (and a provenance line saying so). The replay test then pins whatever was recorded.
 */
import { createChat, ModelHealth } from "./llm.ts";
import { citedLines, citedWindows, ENTAIL_PROMPT_VERSION, ENTAIL_SYS, judgeUserPrompt, parseVerdict } from "./entailment.ts";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const base = env("CHAT_API_BASE", "http://llama-cpp:8080/v1").replace(/\/+$/, "");
if (/-upstream\b/.test(base)) { console.error("refused: the judge goes through LiteLLM, never an *-upstream address"); Deno.exit(64); }
const llm = createChat({
  base, apiKey: env("CHAT_API_KEY", "not-needed"), model: env("CHAT_MODEL", "local-large"), nothinkSuffix: env("NOTHINK_SUFFIX", ":nothink"),
  retryBudgetMs: 600_000, downBudgetMs: 60_000, fetchTimeoutMs: 600_000, probeTimeoutMs: 60_000, health: new ModelHealth(),
});
const VERDICTS = new Set(["supports", "partial", "unsupported"]);
for (const name of Deno.args) {
  const job = JSON.parse(await Deno.readTextFile(`./fixtures/${name}.json`));
  const lines = [];
  for (const l of citedLines(job.synthesis)) {
    const cited = l.cites.filter((n) => job.cited_texts[n - 1]).map((n) => ({
      source: n, title: job.cited_texts[n - 1].title, windows: citedWindows(l.text, job.cited_texts[n - 1].content),
    }));
    const raw = await llm.chat(ENTAIL_SYS, judgeUserPrompt(job.query, l, cited), { json: true, nothink: true });
    const v = parseVerdict(raw, VERDICTS);
    if (!v) throw new Error(`${name} line ${l.index}: the judge gave no usable verdict: ${raw.slice(0, 200)}`);
    lines.push({ line: l.index, tag: l.tag, text: l.text, cites: l.cites, cited_text: cited, judge_response: raw, verdict: v.verdict });
    console.log(`${name} line ${l.index}: ${v.verdict}`);
  }
  await Deno.writeTextFile(`./fixtures/entailment/${name}.entail.json`, JSON.stringify({
    _provenance: `RECORDED ${new Date().toISOString()} from ${env("CHAT_MODEL", "local-large")} via ${base} by record-entailment.ts`,
    job_fixture: name, job_id: job.job_id, prompt_version: ENTAIL_PROMPT_VERSION, question: job.query, lines,
  }, null, 1) + "\n");
}
