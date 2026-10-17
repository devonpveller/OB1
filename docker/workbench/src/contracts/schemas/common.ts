// Shared building blocks of the retrieval contract.
//
// Three rules hold for every schema in src/contracts/schemas/ (the conformance test checks
// the generated document for them):
//   1. No enum, no literal, no union. An enumerated kind is a registry value (registry.ts);
//      a record that can be in several states is ONE shape whose `state` says which of its
//      optional parts are present. A new state or kind is a registry row, never a schema edit.
//   2. Every record carries `state` (record_states) and `state_detail`, owned by the API, so a
//      panel never meets a state it does not know how to read.
//   3. Ids are uuids except page slugs and chunk ids (`<source uuid>:<idx>`).
import { z } from "../deps.ts";
import { REGISTRY, registryValue } from "../registry.ts";
import { FX } from "./fixtures.ts";

export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function uuid(example: string = FX.sourceActive, description = "uuid") {
  return z.string().regex(UUID_RE).openapi({ example, description });
}

export const Iso = z.string().openapi({ example: FX.at, description: "ISO-8601 timestamp" });

// A JSON object. Zod 4 needs the TWO-argument z.record (the one-argument form is the trap
// openbrain-mcp documents at index.ts metadataFilterArg).
export const Json = z.record(z.string(), z.unknown());

export const recordState = (example = "current") => registryValue(REGISTRY.recordStates, example);

export const StateDetail = Json.openapi({
  example: {},
  description: "What the state needs to be read: reason, original context, the action a loading " +
    "record is waiting on, the last-known value of an unreachable one.",
});

export const ErrorBody = z.object({
  error: z.string(),
  detail: Json.optional(),
}).openapi("Error");

export const NotImplemented = z.object({
  status: z.string().openapi({ example: "not_implemented", description: "always not_implemented" }),
  operation: registryValue(REGISTRY.implementationStates, "watches"),
  lands_in: z.string().openapi({ example: "P5b" }),
  message: z.string(),
}).openapi("NotImplemented");

// Query flags are strings on the wire; a regex keeps them out of enum territory.
export const flag = (name: string, description: string) =>
  z.string().regex(/^(true|false)$/).optional().openapi({
    param: { name, in: "query", example: "false" },
    description,
  });

export const evidenceOnly = flag(
  "evidence_only",
  "true = an evidence-only caller: suppressed, unlinked, erased and held records are omitted " +
    "(a single fetch answers state 'omitted'). Default false: they are returned, typed.",
);

export const metadataFilter = z.string().optional().openapi({
  param: { name: "metadata_filter", in: "query", example: "{}" },
  description: "Optional JSON object. When non-empty, only records whose metadata contains it " +
    "are returned, and a record kind that carries no metadata returns nothing (fail closed). " +
    "The cloud gateway forces {\"share\":\"cloud\"} here.",
});

export const limit = (def: number, max: number) =>
  z.string().regex(/^[0-9]{1,4}$/).optional().openapi({
    param: { name: "limit", in: "query", example: String(def) },
    description: `1-${max}, default ${def}`,
  });

export function pathParam(name: string, example: string, description = "") {
  return z.string().min(1).openapi({ param: { name, in: "path", example }, description });
}

export function queryParam(name: string, example: string, description = "") {
  return z.string().optional().openapi({ param: { name, in: "query", example }, description });
}
