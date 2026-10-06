/** Tests for the personal lane (mcp-lanes.ts; ai-stack item amp-owui-deny).
 *
 * Run: deno test --allow-read mcp-lanes.test.ts
 *
 * The behaviour that matters most - the agent-memory tools are ABSENT from the personal
 * lane's tools/list and a call writes nothing - only exists once the server is assembled, so
 * it is proven by the disposable rig (scripts/checks/smoke-openbrain-personal-lane.ps1 in
 * ai-stack). These pin the pieces a running server cannot show cheaply.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isAgentMemoryTool,
  laneForKey,
  personalLaneRefusal,
  resolvePersonalKey,
} from "./mcp-lanes.ts";

const SEVEN = [
  "agent_memory_writeback",
  "agent_memory_recall",
  "agent_memory_review",
  "agent_memory_inspect",
  "agent_memory_list_review_queue",
  "agent_memory_report_usage",
  "agent_memory_recall_trace",
];

Deno.test("laneForKey: full key -> full, personal key -> personal, anything else -> 401", () => {
  assertEquals(laneForKey("F", "F", "P"), "full");
  assertEquals(laneForKey("P", "F", "P"), "personal");
  assertEquals(laneForKey("x", "F", "P"), null);
  assertEquals(laneForKey("", "F", "P"), null);
  assertEquals(laneForKey(null, "F", "P"), null);
  // No personal key configured: an empty provided value must never match the empty key.
  assertEquals(laneForKey("", "F", ""), null);
  assertEquals(laneForKey("P", "F", ""), null);
});

Deno.test("resolvePersonalKey: unset is off; equal to the full key is IGNORED, never a demotion of every caller", () => {
  assertEquals(resolvePersonalKey("F", undefined), { key: "", warning: null });
  assertEquals(resolvePersonalKey("F", "  "), { key: "", warning: null });
  assertEquals(resolvePersonalKey("F", "P").key, "P");
  const same = resolvePersonalKey("F", "F");
  assertEquals(same.key, "");
  assert(same.warning && same.warning.includes("IGNORED"));
  // And so the full-key holder keeps the full lane.
  assertEquals(laneForKey("F", "F", same.key), "full");
});

Deno.test("all seven agent-memory tools are matched; other tools are not", () => {
  for (const t of SEVEN) assert(isAgentMemoryTool(t), t);
  for (const t of ["search_thoughts", "capture_thought", "fetch", "search", "agent_memoryX", "", undefined, 7]) {
    assert(!isAgentMemoryTool(t), String(t));
  }
});

Deno.test("personal lane: every agent-memory tools/call is refused with a clear JSON-RPC error", () => {
  for (const t of SEVEN) {
    const r = personalLaneRefusal({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: t, arguments: {} } }) as
      Record<string, unknown>;
    assert(r, t);
    assertEquals(r.id, 42);
    const e = r.error as { code: number; message: string };
    assertEquals(e.code, -32601);
    assert(e.message.includes(t) && e.message.includes("personal lane") && e.message.includes("Nothing was written"));
  }
});

Deno.test("personal lane: other methods and other tools dispatch normally", () => {
  assertEquals(personalLaneRefusal({ jsonrpc: "2.0", id: 1, method: "tools/list" }), null);
  assertEquals(personalLaneRefusal({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), null);
  assertEquals(
    personalLaneRefusal({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_thoughts", arguments: {} } }),
    null,
  );
  assertEquals(personalLaneRefusal(null), null);
  assertEquals(personalLaneRefusal("junk"), null);
});

Deno.test("personal lane: a batch carrying one agent-memory call is refused whole", () => {
  const r = personalLaneRefusal([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_thoughts", arguments: {} } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agent_memory_writeback", arguments: {} } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ]) as Record<string, unknown>[];
  assert(Array.isArray(r));
  assertEquals(r.map((m) => m.id), [1, 2]);
});

Deno.test("index.ts registers agent memory on the FULL lane only", async () => {
  // A source guard, because the assembled server cannot be imported without its side effects
  // (Deno.serve, a DB pool). If someone passes `server` back in, the personal lane silently
  // regains all seven tools; this catches that edit before the rig does.
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(/registerAgentMemory\(fullLaneOnly,/.test(src), "registerAgentMemory must receive fullLaneOnly");
  assert(!/registerAgentMemory\(server\b/.test(src), "registerAgentMemory must not receive server");
  assert(!/registerAgentMemory\(personalServer\b/.test(src), "registerAgentMemory must not receive personalServer");
  assert(/lane === "full" \? server : personalServer/.test(src), "the catch-all must pick the server by lane");
});
