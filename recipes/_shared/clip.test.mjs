// node --test recipes/_shared/
import test from "node:test";
import assert from "node:assert/strict";
import { clip, stripLoneSurrogates } from "./clip.mjs";

test("clip never ends on a lone high surrogate", () => {
  const s = "abc\u{1F600}"; // 3 + 2 code units
  const cut = clip(s, 4); // would bisect the emoji
  assert.equal(cut, "abc");
  assert.doesNotThrow(() => new TextEncoder().encode(JSON.parse(JSON.stringify(cut))));
});

test("clip keeps a pair that fits and respects max", () => {
  const s = "ab\u{1F600}cd";
  assert.equal(clip(s, 4), "ab\u{1F600}");
  assert.equal(clip(s, 100), s);
  assert.equal(clip(s, 6), s);
});

test("stripLoneSurrogates removes data-borne lone surrogates, keeps pairs", () => {
  const poisoned = "ok\uD83Dmore\uDE00tail\u{1F600}";
  const clean = stripLoneSurrogates(poisoned);
  assert.equal(clean, "okmoretail\u{1F600}");
  // The regression: a lone surrogate must never survive into UTF-8 encoding.
  assert.doesNotThrow(() => new TextEncoder().encode(clean));
  assert.throws(() => {
    // sanity that the fixture really was poisonous
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(poisoned)) throw new Error("lone surrogate");
  });
});

test("clip tolerates null/undefined/numbers like the String(x || '') idiom", () => {
  assert.equal(clip(null, 5), "");
  assert.equal(clip(undefined, 5), "");
  assert.equal(clip(12345678, 5), "12345");
});
