/**
 * The two lanes of the MCP catch-all (memory-plane PLAN §1.1; ai-stack item amp-owui-deny,
 * operator decision D1, 2026-10-06).
 *
 * THE GAP THIS CLOSES. Every caller of openbrain-mcp used to present the same credential
 * (MCP_ACCESS_KEY): agent-bridge, the two gateway doors, and Open WebUI's `open-brain` tool
 * server (openbrain-mcpo). The agent-memory tools stamp what they write with this server's
 * door value, `ops`, so a chat surface that can read personal-plane data could write
 * ops-visible memories. §1.1 says a memory is never more visible than what its writer could
 * read. Nothing at the wire told the OWUI path apart, so nothing could refuse it.
 *
 * THE MECHANISM: a second, scoped credential. MCP_PERSONAL_ACCESS_KEY is the key a
 * personal-plane surface (OWUI via openbrain-mcpo) holds. A request authenticated with it is
 * served by a server instance on which the agent-memory tools were NEVER REGISTERED, so they
 * are absent from tools/list (and so from mcpo's openapi.json) and a tools/call for one
 * cannot reach a handler. This module adds a clear refusal in front of that, so a caller is
 * told why instead of getting a bare "tool not found".
 *
 * WHY THIS AND NOT A FILTER IN mcpo OR A NEW DOOR: the denial lives in the credential the OWUI
 * side holds. An edit to mcpo's config or to OWUI's tool-server list can only use what that
 * side holds, and after the change it holds no credential that unlocks agent memory. An mcpo
 * per-tool filter would be undone by deleting one line of a config that still held the full
 * key. Rationale and evidence: the plan store, agent-memory-plane/findings/amp-owui-deny.md.
 *
 * The REST twins (/agent-memory/*) keep their own guard, which accepts MCP_ACCESS_KEY only,
 * so the personal key never reaches them either.
 */

export type Lane = "full" | "personal";

/** The tool-name prefix the personal lane never serves. All seven agent-memory tools carry it. */
export const AGENT_MEMORY_TOOL_PREFIX = "agent_memory_";

/**
 * Resolve the personal key from the environment. A personal key EQUAL to the full key is
 * ignored (and reported): it would either do nothing or, worse, demote every full-lane caller.
 */
export function resolvePersonalKey(fullKey: string, raw: string | undefined): {
  key: string;
  warning: string | null;
} {
  const v = (raw ?? "").trim();
  if (!v) return { key: "", warning: null };
  if (v === fullKey) {
    return {
      key: "",
      warning:
        "MCP_PERSONAL_ACCESS_KEY equals MCP_ACCESS_KEY and is IGNORED: the personal lane is off " +
        "and any caller holding that value gets the full lane. Give it its own value.",
    };
  }
  return { key: v, warning: null };
}

/** Which lane a provided key opens, or null for an unknown/missing key (401). */
export function laneForKey(provided: string | null | undefined, fullKey: string, personalKey: string): Lane | null {
  if (!provided) return null;
  if (fullKey && provided === fullKey) return "full";
  if (personalKey && provided === personalKey) return "personal";
  return null;
}

export function isAgentMemoryTool(name: unknown): boolean {
  return typeof name === "string" && name.startsWith(AGENT_MEMORY_TOOL_PREFIX);
}

export function personalLaneRefusalMessage(tool: string): string {
  return `Refused: ${tool} is not available on the personal lane (Open WebUI via openbrain-mcpo). ` +
    `Agent memory is stamped ops-visible, and a surface that can read personal data must not write ` +
    `it (memory-plane PLAN §1.1, operator decision D1 2026-10-06). Nothing was written. Agent memory ` +
    `is served on the internal lane (agent-bridge) and the ops door only.`;
}

/**
 * Given a parsed JSON-RPC body arriving on the personal lane, return the refusal to send
 * instead of dispatching, or null to dispatch normally. A batch is refused whole if any
 * message in it calls an agent-memory tool: splitting a batch would mean answering part of
 * it, and nothing on this lane needs batches.
 */
export function personalLaneRefusal(body: unknown): Record<string, unknown> | Record<string, unknown>[] | null {
  const msgs = Array.isArray(body) ? body : [body];
  const hit = msgs.find((m) => {
    if (!m || typeof m !== "object") return false;
    const o = m as Record<string, unknown>;
    const params = o.params as Record<string, unknown> | undefined;
    return o.method === "tools/call" && !!params && isAgentMemoryTool(params.name);
  }) as Record<string, unknown> | undefined;
  if (!hit) return null;
  const tool = String((hit.params as Record<string, unknown>).name);
  const err = (id: unknown) => ({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code: -32601, message: personalLaneRefusalMessage(tool) },
  });
  if (Array.isArray(body)) {
    return msgs
      .filter((m) => m && typeof m === "object" && "id" in (m as Record<string, unknown>))
      .map((m) => err((m as Record<string, unknown>).id));
  }
  return err((hit as Record<string, unknown>).id);
}
