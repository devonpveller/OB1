/** The retrieval contract's MCP tools against the workbench's OpenAPI document.
 *
 * Run: deno test --allow-read --allow-env contract-tools.test.ts
 *
 * A real McpServer + Client over the SDK's in-memory transport: tools/list is what an MCP client
 * sees. Every operation the OpenAPI document marks x-mcp-tool must be listed under that name,
 * with the same input properties, the same required set and the same JSON types. The expected
 * side is derived from the OpenAPI document ITSELF (not from contract-tools.json), so a stale
 * manifest, a lossy adapter or a hand-edited tool all fail here. Also pins the Zod 4 z.record
 * trap: a one-argument z.record breaks tools/list, so listing succeeding is part of the proof.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CONTRACT_TOOLS, registerContractTools, toRequest } from "./contract-tools.ts";

type J = Record<string, any>;
const doc: J = JSON.parse(await Deno.readTextFile(
  new URL("../../docker/workbench/src/contracts/generated/openapi.json", import.meta.url),
));

function resolve(s: J): J {
  if (s?.$ref) return resolve(doc.components.schemas[s.$ref.split("/").pop()]);
  return s ?? {};
}

// What the OpenAPI document says each MCP tool's input is.
function expected(): Map<string, { props: Map<string, string>; required: Set<string>; op: string }> {
  const out = new Map();
  for (const [path, item] of Object.entries(doc.paths as J)) {
    for (const [method, op] of Object.entries(item as J) as [string, J][]) {
      if (!op["x-mcp-tool"]) continue;
      const props = new Map<string, string>();
      const required = new Set<string>();
      for (const p of op.parameters ?? []) {
        props.set(p.name, p.name === "metadata_filter" ? "object" : resolve(p.schema).type);
        if (p.required) required.add(p.name);
      }
      const body = op.requestBody?.content?.["application/json"]?.schema;
      if (body) {
        const b = resolve(body);
        for (const [k, v] of Object.entries(b.properties ?? {})) props.set(k, resolve(v as J).type);
        for (const r of b.required ?? []) required.add(r);
      }
      out.set(op["x-mcp-tool"], { props, required, op: `${method.toUpperCase()} ${path}` });
    }
  }
  return out;
}

async function listed(): Promise<J[]> {
  const server = new McpServer({ name: "contract-test", version: "1.0.0" });
  const calls: string[] = [];
  registerContractTools(server, {
    workbenchUrl: "http://workbench.invalid:8000", key: "k",
    fetchImpl: ((url: string) => {
      calls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as typeof fetch,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "1.0.0" });
  await client.connect(b);
  const { tools } = await client.listTools();
  await client.close();
  return tools as J[];
}

Deno.test("tools/list exposes exactly the OpenAPI document's x-mcp-tool operations", async () => {
  const want = expected();
  const tools = await listed();
  const names = tools.map((t) => t.name).sort();
  assertEquals(names, [...want.keys()].sort(), "the MCP tool set drifted from the OpenAPI document");
  assert(names.length >= 20, `only ${names.length} contract tools`);
});

Deno.test("every tool's input schema matches its OpenAPI operation: properties, required, types", async () => {
  const want = expected();
  for (const t of await listed()) {
    const w = want.get(t.name)!;
    const props = t.inputSchema.properties ?? {};
    assertEquals(Object.keys(props).sort(), [...w.props.keys()].sort(), `${t.name} (${w.op}): properties drifted`);
    assertEquals([...(t.inputSchema.required ?? [])].sort(), [...w.required].sort(), `${t.name}: required drifted`);
    for (const [k, type] of w.props) {
      assertEquals(props[k].type, type, `${t.name}.${k}: type ${props[k].type} != OpenAPI ${type}`);
    }
  }
});

// The comparable shape of a schema, recursively (attempt 2, tester F5: the top-level-only diff
// let a nested item type, a nested required set and a pattern drift unnoticed). Both sides
// reduce to: type, nullable, pattern, length/range/size bounds, required set, properties and
// items - each nested level the same way. Descriptions and examples are not compared. Zod's
// integer adds the safe-integer range when no bound is set; that default is not a bound.
const SAFE = 9007199254740991;
function shape(s: J | undefined, fromOpenApi: boolean): J {
  s = fromOpenApi ? resolve(s ?? {}) : (s ?? {});
  let type = s.type;
  let nullable = !!s.nullable;
  if (Array.isArray(type)) {
    nullable = nullable || type.includes("null");
    type = type.filter((x: string) => x !== "null")[0];
  }
  for (const alt of (s.anyOf ?? []) as J[]) {
    if (alt.type === "null") nullable = true;
    else return { ...shape(alt, fromOpenApi), nullable: true };
  }
  const out: J = { type: type ?? null, nullable };
  for (const k of ["pattern", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"]) {
    const v = s[k];
    if (v === undefined || ((k === "minimum" || k === "maximum") && Math.abs(v) === SAFE)) continue;
    out[k] = v;
  }
  if (s.properties) {
    out.required = [...(s.required ?? [])].sort();
    out.properties = Object.fromEntries(Object.keys(s.properties).sort().map((k) => [k, shape(s!.properties[k], fromOpenApi)]));
  }
  if (s.items) out.items = shape(s.items, fromOpenApi);
  return out;
}

// What the OpenAPI document says each MCP tool's input is, nested.
function expectedShapes(): Map<string, J> {
  const out = new Map<string, J>();
  for (const item of Object.values(doc.paths as J)) {
    for (const op of Object.values(item as J) as J[]) {
      if (!op["x-mcp-tool"]) continue;
      const props: J = {};
      const required: string[] = [];
      for (const p of op.parameters ?? []) {
        // metadata_filter: a JSON string on the HTTP route, an object over MCP (the adapter
        // serialises it) - the one deliberate difference.
        props[p.name] = p.name === "metadata_filter" ? { type: "object", nullable: false } : shape(p.schema, true);
        if (p.required) required.push(p.name);
      }
      const body = op.requestBody?.content?.["application/json"]?.schema;
      if (body) {
        const b = resolve(body);
        for (const [k, v] of Object.entries(b.properties ?? {})) props[k] = shape(v as J, true);
        required.push(...(b.required ?? []));
      }
      out.set(op["x-mcp-tool"], { type: "object", nullable: false, required: required.sort(), properties: Object.fromEntries(Object.keys(props).sort().map((k) => [k, props[k]])) });
    }
  }
  return out;
}

Deno.test("every tool's input schema matches its OpenAPI operation AT EVERY LEVEL: nested items, required, types, patterns, bounds", async () => {
  const want = expectedShapes();
  for (const t of await listed()) {
    const got = shape(t.inputSchema, false);
    // the MCP side's metadata_filter is a record: compare it as the bare object it is
    if (got.properties?.metadata_filter) got.properties.metadata_filter = { type: got.properties.metadata_filter.type, nullable: false };
    assertEquals(got, want.get(t.name), `${t.name}: the nested input schema drifted from the OpenAPI document`);
  }
});

Deno.test("no contract tool is a write (D14: reads only)", () => {
  for (const s of CONTRACT_TOOLS) {
    const op = (doc.paths[s.path] ?? {})[s.method.toLowerCase()];
    assert(op?.["x-mcp-tool"] === s.tool, `${s.tool} is not an x-mcp-tool operation in the document`);
    assert(!["suppress", "sever", "erase", "admission", "writeSetting"].includes(s.operationId));
  }
});

Deno.test("a call becomes the workbench route: path params, query, metadata_filter as JSON", () => {
  const ref = CONTRACT_TOOLS.find((t) => t.tool === "contract_reference")!;
  const r = toRequest(ref, { id: "abc", version: "2", metadata_filter: { share: "cloud" } }, "http://wb:8000/");
  assertEquals(r.method, "GET");
  assertEquals(r.url, "http://wb:8000/workbench/contract/references/abc?version=2&metadata_filter=%7B%22share%22%3A%22cloud%22%7D");
  const diff = CONTRACT_TOOLS.find((t) => t.tool === "contract_diff_check")!;
  const d = toRequest(diff, { references: [{ source_id: "s", revision: 1 }] }, "http://wb:8000");
  assertEquals([d.method, d.body], ["POST", JSON.stringify({ references: [{ source_id: "s", revision: 1 }] })]);
});

Deno.test("the adapter never uses the one-argument z.record (the Zod 4 trap)", async () => {
  const src = await Deno.readTextFile(new URL("./contract-tools.ts", import.meta.url));
  const code = src.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
  assertEquals(/z\.record\(\s*z\.unknown\(\)\s*\)/.test(code), false);
  assert(/z\.record\(z\.string\(\), z\.unknown\(\)\)/.test(code));
});

// rw-p0-contract2 (reviewer reject of rw-p0-contract): the cloud door forces {"share":"cloud"}
// into metadata_filter, but the SDK hands a tool only the arguments its input schema names - a
// tool without metadata_filter silently loses the filter. The cloud-scoped set is every tool
// whose manifest entry carries metadata_filter (the gateway's default set must be a subset:
// openbrain-gateway/test_openbrain_gateway_contract_tools.py). For each: toRequest puts the
// filter on the workbench URL, AND a real MCP client call delivers it to the workbench fetch.
const FILTER = { share: "cloud" };
const cloudScoped = () => CONTRACT_TOOLS.filter((t) => "metadata_filter" in t.input.properties);
function requiredArgs(t: (typeof CONTRACT_TOOLS)[number]): Record<string, unknown> {
  return Object.fromEntries(t.input.required.map((k) => [k, t.input.properties[k].type === "integer" ? 1 : "fixture-arg"]));
}
function filterOf(url: string): unknown {
  const raw = new URL(url).searchParams.get("metadata_filter");
  return raw === null ? null : JSON.parse(raw);
}

Deno.test("dependence and tombstone are cloud-scoped tools: they carry metadata_filter", () => {
  const names = cloudScoped().map((t) => t.tool);
  for (const must of ["contract_dependence", "contract_tombstone"]) {
    assert(names.includes(must), `${must} carries no metadata_filter: the forced cloud filter would be dropped`);
  }
});

Deno.test("toRequest forwards the forced filter for every cloud-scoped tool", () => {
  for (const t of cloudScoped()) {
    assert(t.json_params.includes("metadata_filter"), `${t.tool}: metadata_filter is not a JSON query parameter`);
    const r = toRequest(t, { ...requiredArgs(t), metadata_filter: FILTER }, "http://wb:8000");
    assertEquals(filterOf(r.url), FILTER, `${t.tool}: toRequest dropped the filter (${r.url})`);
  }
});

Deno.test("a real MCP client call delivers the forced filter to the workbench for every cloud-scoped tool", async () => {
  const server = new McpServer({ name: "contract-scope", version: "1.0.0" });
  const calls: string[] = [];
  registerContractTools(server, {
    workbenchUrl: "http://workbench.invalid:8000", key: "k",
    fetchImpl: ((url: string) => {
      calls.push(String(url));
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "1.0.0" });
  await client.connect(b);
  try {
    for (const t of cloudScoped()) {
      calls.length = 0;
      await client.callTool({ name: t.tool, arguments: { ...requiredArgs(t), metadata_filter: FILTER } });
      assertEquals(calls.length, 1, `${t.tool}: no workbench call`);
      assertEquals(filterOf(calls[0]), FILTER, `${t.tool}: the filter did not reach the workbench (${calls[0]})`);
    }
    // the mechanism the reviewer found, pinned: a tool whose schema lacks the parameter drops it
    const bare = CONTRACT_TOOLS.find((t) => !("metadata_filter" in t.input.properties) && t.input.required.length === 0)!;
    calls.length = 0;
    await client.callTool({ name: bare.tool, arguments: { metadata_filter: FILTER } });
    assertEquals(filterOf(calls[0]), null, `${bare.tool}: expected the SDK to drop an undeclared argument`);
  } finally {
    await client.close();
  }
});
