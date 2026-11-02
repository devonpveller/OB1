// research-workbench P8a-1 (rw-p8a1-core): the contract surface the timeline, trail and page graph panels read -
// pure (the OpenAPI document and the schemas); the database half is panels_integration_test.ts.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildDocument } from "./gen.ts";
import * as K from "./schemas/knowledge.ts";
import { EX } from "./schemas/examples.ts";

type J = Record<string, any>;
const doc = buildDocument() as J;
const schema = (name: string) => doc.components.schemas[name] as J;

Deno.test("P8a-1: the trail answers its lead entries (P3a found_via paths, P4a per-source events) beside the removals", () => {
  const trail = schema("Trail");
  assert(trail.properties.leads, "Trail.leads");
  const lead = schema("LeadTrailEntry");
  for (const k of ["origin", "stage", "url", "source_id", "lifecycle", "found_via", "path", "job_id", "counts_as_evidence"]) {
    assert(lead.properties[k], `LeadTrailEntry.${k}`);
  }
  assertEquals(lead.properties.stage["x-registry"], "admission_trail_kinds");
  assert(K.Trail.safeParse(EX.trail).success, "the trail example validates");
  assert((EX.trail as J).leads[0].found_via, "the example carries a found_via path");
});

Deno.test("P8a-1 (D5): every read a panel lists sources from carries the lifecycle state", () => {
  assertEquals(schema("TrailEntry").properties.lifecycle["x-registry"], "source_states");
  assertEquals(schema("TimelineEvent").properties.lifecycle["x-registry"], "source_states");
  assertEquals(schema("GraphNode").properties.lifecycle["x-registry"], "source_states");
  assert(schema("GraphNode").properties.contested, "GraphNode.contested (D1: the contested entry points)");
  const op = doc.paths["/workbench/contract/source-states"]?.post as J | undefined;
  assert(op, "POST /workbench/contract/source-states");
  assertEquals(op.operationId, "sourceStates");
  assert(K.SourceStates.safeParse(EX.sourceStates).success);
  assert(K.Neighbours.safeParse(EX.neighbours).success);
  assert(K.Timeline.safeParse(EX.timeline).success);
});

Deno.test("P8a-1: a lead entry without its stage, or with a free-text origin, still carries counts_as_evidence false", () => {
  const ok = K.LeadTrailEntry.safeParse({ ...(EX.trail as J).leads[0] });
  assert(ok.success);
  assertEquals(K.LeadTrailEntry.safeParse({ ...(EX.trail as J).leads[0], counts_as_evidence: undefined }).success, false);
});
