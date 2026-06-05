// Unit tests for the import chunker (P5.5). Run: `deno test`.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { chunkText } from "./chunk.ts";

Deno.test("empty / whitespace → no chunks", () => {
  assertEquals(chunkText(""), []);
  assertEquals(chunkText("   \n\n  "), []);
});

Deno.test("short text → exactly one chunk", () => {
  const r = chunkText("One sentence. Two sentence. Three.");
  assertEquals(r.length, 1);
  assert(r[0].includes("Three"));
});

Deno.test("long multi-sentence text → multiple chunks", () => {
  const sentence = "Sentence " + "x".repeat(60) + ". ";
  const r = chunkText(sentence.repeat(60)); // well over the ~1200-char target
  assert(r.length > 1, `expected >1 chunk, got ${r.length}`);
});

Deno.test("a single oversized unit is hard-sliced (no infinite/empty)", () => {
  const r = chunkText("y".repeat(5000));
  assert(r.length > 1, `expected >1 chunk, got ${r.length}`);
  assert(r.every((c) => c.length > 0));
});
