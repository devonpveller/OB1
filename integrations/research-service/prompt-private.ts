/**
 * The original prompt is private; what research derives from it is shared (rw-identity round 5;
 * operator 2026-10-28). What the research service hands to shared knowledge (the curator package ->
 * sources.metadata, thoughts; the staging session row) must carry no VERBATIM span of the prompt:
 * no run of SPAN (5) or more consecutive words of it - compared case- and punctuation-insensitively,
 * after Unicode NFKC - and, for a prompt shorter than that, not the whole prompt. Generated text
 * (a synthesis, a decomposed need) is fine; a copied span is withheld ("…").
 */
export const SPAN = 5;

interface Tok { start: number; end: number; w: string }

function tokens(s: string): Tok[] {
  const out: Tok[] = [];
  const t = s.normalize("NFKC");
  for (const m of t.matchAll(/[\p{L}\p{N}]+/gu)) out.push({ start: m.index!, end: m.index! + m[0].length, w: m[0].toLowerCase() });
  return out;
}

function grams(prompt: string, n: number): { k: number; set: Set<string> } {
  const p = tokens(prompt).map((t) => t.w);
  const k = Math.min(n, p.length);
  const set = new Set<string>();
  if (k === 0) return { k, set };
  for (let i = 0; i + k <= p.length; i++) set.add(p.slice(i, i + k).join(" "));
  return { k, set };
}

/** The spans of `text` that copy `prompt` (each as its words); [] when none. */
export function promptSpans(text: string, prompt: string, n = SPAN): string[] {
  const { k, set } = grams(prompt, n);
  if (!k) return [];
  const t = tokens(text).map((x) => x.w);
  const out: string[] = [];
  for (let i = 0; i + k <= t.length; i++) {
    const g = t.slice(i, i + k).join(" ");
    if (set.has(g)) out.push(g);
  }
  return out;
}

/** `text` with every copied span of `prompt` withheld as "…" (the rest kept as written). */
export function withoutPromptSpans(text: string, prompt: string, n = SPAN): string {
  if (!text) return text;
  const { k, set } = grams(prompt, n);
  if (!k) return text;
  const t = text.normalize("NFKC");
  const toks = tokens(t);
  const marked = new Array(toks.length).fill(false);
  for (let i = 0; i + k <= toks.length; i++) {
    if (set.has(toks.slice(i, i + k).map((x) => x.w).join(" "))) for (let j = i; j < i + k; j++) marked[j] = true;
  }
  if (!marked.some(Boolean)) return t;
  let out = "";
  let pos = 0;
  for (let i = 0; i < toks.length; i++) {
    if (!marked[i]) continue;
    let j = i;
    while (j + 1 < toks.length && marked[j + 1]) j++;
    out += t.slice(pos, toks[i].start) + "…";
    pos = toks[j].end;
    i = j;
  }
  return out + t.slice(pos);
}

const meaningful = (s: string) => s.replace(/[…\s\p{P}]+/gu, "").length > 0;

/** The research question as shared knowledge files it: the planner's decomposed needs (generated),
 *  each with any copied prompt span withheld; else the subject the planner named; else a fixed label. */
export function derivedQuestion(needs: string[], subject: string, prompt: string): string {
  const parts = needs.map((x) => withoutPromptSpans(String(x ?? ""), prompt).trim()).filter(meaningful);
  if (parts.length) return parts.join("; ").slice(0, 600);
  const s = withoutPromptSpans(String(subject ?? ""), prompt).trim();
  return meaningful(s) ? s.slice(0, 200) : "the research question (private to its owner)";
}

/** A list of generated strings with copied prompt spans withheld; entries left empty are dropped. */
export function scrubList(xs: unknown, prompt: string): string[] {
  return (Array.isArray(xs) ? xs : []).map((x) => withoutPromptSpans(String(x ?? ""), prompt).trim()).filter(meaningful);
}
