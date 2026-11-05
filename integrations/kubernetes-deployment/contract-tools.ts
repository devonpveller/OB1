/**
 * The retrieval contract as MCP tools (research-workbench P0, D14: openbrain-mcp is the MCP host;
 * the workbench stays MCP-off; READS ONLY).
 *
 * The contract is defined once, as zod schemas in the workbench (docker/workbench/src/contracts/).
 * Its generator writes contract-tools.json beside this file: every read operation, with its
 * parameters and body flattened into one input object. This adapter turns that manifest into
 * tools, and each tool calls the workbench's contract route over HTTP - one implementation,
 * two front doors. contract-tools.test.ts lists the tools through a real MCP client and diffs
 * their schemas against the workbench's OpenAPI document; any drift fails.
 *
 * Two facts of this server shape the adapter:
 *   - registerTool's inputSchema is a PROPERTY BAG ({name: zodType}), not a z.object().
 *   - Zod 4's z.record must take TWO arguments (z.record(z.string(), z.unknown())); the
 *     one-argument form breaks at tools/list time (index.ts, metadataFilterArg).
 * metadata_filter is an object over MCP (the cloud gateway forces {share:"cloud"} into it) and
 * a JSON string on the HTTP route; the adapter serialises it.
 */
import type { Caller } from "./mcp-identity.ts";
import { z } from "zod";
import manifest from "./contract-tools.json" with { type: "json" };

export interface ContractToolSpec {
  tool: string;
  operationId: string;
  method: string;
  path: string;
  description: string;
  input: { type: "object"; properties: Record<string, JsonSchema>; required: string[] };
  path_params: string[];
  query_params: string[];
  json_params: string[];
  body_params: string[];
}

export interface JsonSchema {
  type?: string;
  description?: string;
  nullable?: boolean;
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: unknown;
  [k: string]: unknown;
}

export const CONTRACT_TOOLS = manifest as unknown as ContractToolSpec[];

// JSON schema (the subset the contract emits) -> zod. Unknown shapes become z.unknown() rather
// than guessing.
export function jsonToZod(s: JsonSchema): z.ZodType {
  let t: z.ZodType;
  // Bounds are carried, not dropped (attempt 2, tester F5): the diff test compares them.
  const n = (k: string) => (typeof s[k] === "number" ? (s[k] as number) : undefined);
  if (s.type === "string") {
    let x = s.pattern ? z.string().regex(new RegExp(s.pattern)) : z.string();
    if (n("minLength") !== undefined) x = x.min(n("minLength")!);
    if (n("maxLength") !== undefined) x = x.max(n("maxLength")!);
    t = x;
  } else if (s.type === "integer" || s.type === "number") {
    let x = s.type === "integer" ? z.number().int() : z.number();
    if (n("minimum") !== undefined) x = x.min(n("minimum")!);
    if (n("maximum") !== undefined) x = x.max(n("maximum")!);
    t = x;
  } else if (s.type === "boolean") t = z.boolean();
  else if (s.type === "array") {
    let x = z.array(jsonToZod(s.items ?? {}));
    if (n("minItems") !== undefined) x = x.min(n("minItems")!);
    if (n("maxItems") !== undefined) x = x.max(n("maxItems")!);
    t = x;
  }
  else if (s.type === "object" && s.properties) {
    const req = new Set(s.required ?? []);
    t = z.object(Object.fromEntries(Object.entries(s.properties).map(([k, v]) => {
      const inner = jsonToZod(v);
      return [k, req.has(k) ? inner : inner.optional()];
    })));
  } else if (s.type === "object") t = z.record(z.string(), z.unknown());
  else t = z.unknown();
  if (s.nullable) t = t.nullable();
  return s.description ? t.describe(s.description) : t;
}

// The property bag registerTool takes.
export function inputShape(spec: ContractToolSpec): Record<string, z.ZodType> {
  const req = new Set(spec.input.required);
  return Object.fromEntries(Object.entries(spec.input.properties).map(([k, v]) => {
    const t = jsonToZod(v);
    return [k, req.has(k) ? t : t.optional()];
  }));
}

// The HTTP request one tool call becomes.
export function toRequest(spec: ContractToolSpec, args: Record<string, unknown>, base: string) {
  let path = spec.path;
  for (const p of spec.path_params) {
    const v = args[p];
    if (v === undefined || v === null || v === "") throw new Error(`${p} is required`);
    path = path.replace(`{${p}}`, encodeURIComponent(String(v)));
  }
  const qs = new URLSearchParams();
  for (const q of spec.query_params) if (args[q] !== undefined && args[q] !== null) qs.set(q, String(args[q]));
  for (const q of spec.json_params) {
    const v = args[q];
    if (v !== undefined && v !== null) qs.set(q, JSON.stringify(v));
  }
  const body = spec.body_params.length
    ? JSON.stringify(Object.fromEntries(spec.body_params.filter((b) => args[b] !== undefined).map((b) => [b, args[b]])))
    : undefined;
  const url = `${base.replace(/\/+$/, "")}${path}${qs.size ? `?${qs}` : ""}`;
  return { url, method: spec.method, body };
}

/**
 * rw-mcp-identity round 2 (tester F1): who the workbench serves for one contract call. The full lane (the operator's own
 * clients) keeps MCP_ACCESS_KEY, which the workbench resolves to the operator. Every other caller goes with the workbench's
 * service key for this server (`mcp` in WORKSPACE_SERVICE_KEYS: service:mcp, nobody), and a token-verified Open WebUI user
 * adds their own token (x-ob-user-token) for the workbench to verify itself. No mcp key = refused (null).
 */
export function contractHeaders(caller: Caller | undefined, fullKey: string, mcpKey: string): Record<string, string> | null {
  if (!caller) return null;
  if (caller.lane === "full") return { "x-brain-key": fullKey };
  if (!mcpKey) return null;
  if (caller.via === "token" && caller.subject && caller.token) return { "x-brain-key": mcpKey, "x-ob-user-token": caller.token };
  return { "x-brain-key": mcpKey };
}

type Registrar = { registerTool: (...a: never[]) => unknown };
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function registerContractTools(
  server: Registrar,
  opts: {
    workbenchUrl: string;
    key?: string;
    /**
     * rw-mcp-identity round 2 (tester F1): the headers that say WHO the workbench serves, per call - the caller's, never
     * this server's own standing. null = the call is refused before anything is sent. Without it, `key` is sent (tests).
     */
    headers?: () => Record<string, string> | null;
    fetchImpl?: typeof fetch;
    tools?: ContractToolSpec[];
  },
) {
  const doFetch = opts.fetchImpl ?? fetch;
  for (const spec of opts.tools ?? CONTRACT_TOOLS) {
    const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
      try {
        const who = opts.headers ? opts.headers() : { "x-brain-key": opts.key ?? "" };
        if (!who) {
          return { content: [{ type: "text", text: "Refused: the research workspace is not configured for this lane (no workbench key for callers other than the operator); nothing was read." }], isError: true };
        }
        const r = toRequest(spec, args ?? {}, opts.workbenchUrl);
        const res = await doFetch(r.url, {
          method: r.method,
          headers: { "content-type": "application/json", ...who },
          body: r.body,
        });
        const text = await res.text();
        // 501 is a typed not_implemented answer, not a failure of the call.
        return { content: [{ type: "text", text }], ...(res.status >= 400 && res.status !== 501 ? { isError: true } : {}) };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
      }
    };
    (server.registerTool as unknown as (n: string, c: unknown, h: unknown) => unknown)(
      spec.tool,
      { title: spec.operationId, description: spec.description, annotations: { readOnlyHint: true }, inputSchema: inputShape(spec) },
      handler,
    );
  }
}
