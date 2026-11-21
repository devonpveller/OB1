// rwr-own-thoughts-search-api: the answer of the own-thoughts search. Every hit says it is private to its owner; no
// response carries a count, a total or a length (a count would tell a caller that something exists); nothing nested
// (no metadata, no links; no closed list - the contract test forbids enum/const): a hit is exactly the picker's SearchHit shape plus `date`, `private` and `marker`.
import { z } from "../deps.ts";

export const OwnThoughtHit = z.object({
  kind: z.string().openapi({ example: "thought", description: "always thought" }),
  id: z.string().openapi({ example: "4711" }),
  title: z.string().openapi({ example: "Compost idea for the allotment" }),
  snippet: z.string().openapi({ example: "Try <<HL>>compost<</HL>> tea on the beans", description: "inert <<HL>>/<</HL>> markers around matches (escape first, then swap)" }),
  state: z.string().openapi({ example: "current" }),
  lifecycle: z.null(),
  page_class: z.null(),
  date: z.string().openapi({ example: "2026-11-01T10:00:00.000Z", description: "when the thought was saved" }),
  private: z.boolean().openapi({ example: true, description: "always true: visible to its owner only" }),
  marker: z.string().openapi({ example: "private to you", description: "always the words: private to you" }),
}).openapi("OwnThoughtHit");

export const OwnThoughts = z.object({
  private: z.boolean().openapi({ example: true, description: "always true: this answer is the caller's own thoughts, never shared, cached or fed to the wiki, digest or research" }),
  query: z.string(),
  results: z.array(OwnThoughtHit),
}).openapi("OwnThoughts");

export const OWN_THOUGHTS_EXAMPLE = {
  private: true, query: "compost",
  results: [{
    kind: "thought", id: "4711", title: "Compost idea for the allotment", snippet: "Try <<HL>>compost<</HL>> tea on the beans",
    state: "current", lifecycle: null, page_class: null, date: "2026-11-01T10:00:00.000Z", private: true, marker: "private to you",
  }],
};
