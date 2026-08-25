/**
 * clip — surrogate-safe string truncation for LLM payloads.
 *
 * String.prototype.slice() cuts at UTF-16 code units: clipping through an
 * emoji (or any astral-plane character) leaves a LONE SURROGATE at the
 * cut. JSON.stringify happily emits it ("\ud83d"), and the OpenAI-
 * compatible stack then refuses the whole request — LiteLLM: "'utf-8'
 * codec can't encode character '\ud83d' … surrogates not allowed" → 500.
 * One poisoned snippet fails the entire completion; a deterministic
 * poison (same source, same cut) pins the entity red on every compile
 * (entity #27198 "San Francisco", found 2026-08-25 — same bug class as
 * the chunk-worker emoji rejection).
 *
 * clip() truncates without splitting a pair and also strips lone
 * surrogates already present in the input (data-borne corruption from
 * pre-sanitizer ingests).
 */

// Remove unpaired surrogates: a high surrogate not followed by a low, or
// a low surrogate not preceded by a high.
export function stripLoneSurrogates(s) {
  return String(s ?? "").replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

// Drop-in replacement for `String(x || "").slice(0, max)` on any text
// that ends up inside an LLM request.
export function clip(s, max) {
  const str = stripLoneSurrogates(s);
  if (str.length <= max) return str;
  let out = str.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1); // never end mid-pair
  return out;
}
