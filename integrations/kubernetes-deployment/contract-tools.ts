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
  if (s.type === "string") t = s.pattern ? z.string().regex(new RegExp(s.pattern)) : z.string();
  else if (s.type === "integer") t = z.number().int();
  else if (s.type === "number") t = z.number();
  else if (s.type === "boolean") t = z.boolean();
  else if (s.type === "array") t = z.array(jsonToZod(s.items ?? {}));
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

type Registrar = { registerTool: (...a: never[]) => unknown };
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function registerContractTools(
  server: Registrar,
  opts: { workbenchUrl: string; key: string; fetchImpl?: typeof fetch; tools?: ContractToolSpec[] },
) {
  const doFetch = opts.fetchImpl ?? fetch;
  for (const spec of opts.tools ?? CONTRACT_TOOLS) {
    const handler = async (args: Record<string, unknown>): Promise<ToolResult> => {
      try {
        const r = toRequest(spec, args ?? {}, opts.workbenchUrl);
        const res = await doFetch(r.url, {
          method: r.method,
          headers: { "content-type": "application/json", "x-brain-key": opts.key },
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
