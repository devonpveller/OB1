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

// An OpenAPI $ref is resolved in the document's components; one that does not resolve THROWS
// (rw-p0b-purge-door attempt 3: a missing target used to compare as {} silently).
function resolve(s: J): J {
  if (s?.$ref) {
    const m = /^#\/components\/schemas\/([^/]+)$/.exec(String(s.$ref));
    const target = m ? doc.components?.schemas?.[m[1]] : undefined;
    if (target === undefined) throw new Error(`unresolvable OpenAPI $ref '${s.$ref}'`);
    return resolve(target);
  }
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
// THE KEYWORD LIST IS CLOSED (rw-p0b-purge-door attempt 2, tester finding N4: `not`, `enum`,
// `oneOf` were never read, so `additionalProperties: {"not": {}}` or `{"enum": []}` - both
// semantically `false` - and any oneOf branch passed). Every keyword is either COMPARED or
// deliberately IGNORED below; a schema carrying any other keyword fails the test, naming it, so a
// keyword this diff does not understand can never be skipped silently.
const COMPARED_SCALARS = ["pattern", "format", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum",
  "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "default"];
// annotations that change no accepted value ($ref is resolved; type/nullable/required/properties/
// items/additionalProperties/not/enum/const/anyOf/oneOf/allOf/propertyNames/patternProperties/
// prefixItems are compared structurally below)
// $ref is RESOLVED on both sides (deref below; attempt 3 - the manifest side used to ignore it, so a
// generator that starts emitting $ref would have compared {} silently); $defs / definitions are
// only read through a $ref.
const IGNORED = new Set(["description", "title", "example", "examples", "$schema", "x-registry", "deprecated", "readOnly", "writeOnly", "$defs", "definitions"]);
const STRUCTURAL = new Set(["type", "nullable", "required", "properties", "items", "additionalProperties", "not", "enum", "const",
  "anyOf", "oneOf", "allOf", "propertyNames", "patternProperties", "prefixItems"]);
const sortedBranches = (xs: J[], fromOpenApi: boolean, root: J) =>
  xs.map((x) => shape(x, fromOpenApi, root)).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
// Follows $ref: the OpenAPI side into components/schemas, a JSON schema (tools/list, the manifest)
// into its root's $defs / definitions. A $ref that does not resolve, points anywhere else, carries
// a sibling keyword this diff would compare, or loops, THROWS - never compared as {}.
function deref(s: J, fromOpenApi: boolean, root: J): J {
  for (let hops = 0; s && typeof s === "object" && "$ref" in s; hops++) {
    if (hops >= 32) throw new Error(`shape(): $ref chain longer than 32 (a loop?) at '${s.$ref}'`);
    const extra = Object.keys(s).filter((k) => k !== "$ref" && !IGNORED.has(k));
    if (extra.length) throw new Error(`shape(): $ref '${s.$ref}' with sibling keyword(s) ${extra.join(", ")} is not compared (refused)`);
    let target: J | undefined;
    if (fromOpenApi) {
      const m = /^#\/components\/schemas\/([^/]+)$/.exec(String(s.$ref));
      target = m ? doc.components?.schemas?.[m[1]] : undefined;
    } else {
      const m = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(String(s.$ref));
      target = m ? root?.[m[1]]?.[m[2]] : undefined;
    }
    if (target === undefined) throw new Error(`shape(): unresolvable $ref '${s.$ref}'`);
    s = target;
  }
  return s;
}
function shape(s: J | undefined, fromOpenApi: boolean, root?: J): J {
  root = root ?? s ?? {};
  s = deref(s ?? {}, fromOpenApi, root!);
  for (const k of Object.keys(s)) {
    if (!IGNORED.has(k) && !STRUCTURAL.has(k) && !COMPARED_SCALARS.includes(k)) {
      throw new Error(`shape(): schema keyword '${k}' is neither compared nor deliberately ignored (${JSON.stringify(s).slice(0, 200)})`);
    }
  }
  let type = s.type;
  let nullable = !!s.nullable;
  if (Array.isArray(type)) {
    nullable = nullable || type.includes("null");
    type = type.filter((x: string) => x !== "null")[0];
  }
  // anyOf [X, {type: null}] is how Zod writes a nullable X: collapse exactly that shape; any other
  // anyOf is compared branch by branch (attempt 1 returned the first non-null branch and dropped
  // the rest)
  const any = (s.anyOf ?? []) as J[];
  const nonNull = any.filter((alt) => alt.type !== "null");
  if (any.length && nonNull.length === 1 && any.length === 2 && Object.keys(s).every((k) => k === "anyOf" || IGNORED.has(k))) {
    return { ...shape(nonNull[0], fromOpenApi, root), nullable: true };
  }
  const out: J = { type: type ?? null, nullable };
  for (const k of COMPARED_SCALARS) {
    const v = s[k];
    if (v === undefined || ((k === "minimum" || k === "maximum") && Math.abs(v) === SAFE)) continue;
    out[k] = v;
  }
  if (s.properties) {
    out.required = [...(s.required ?? [])].sort();
    out.properties = Object.fromEntries(Object.keys(s.properties).sort().map((k) => [k, shape(s!.properties[k], fromOpenApi, root)]));
  } else if (s.required) out.required = [...s.required].sort();
  // items: false (no item allowed) is kept as false, never read as "absent" (attempt 3)
  if ("items" in s) {
    out.items = typeof s.items === "boolean" ? s.items
      : Array.isArray(s.items) ? s.items.map((x: J) => shape(x, fromOpenApi, root)) : shape(s.items, fromOpenApi, root);
  }
  if (s.prefixItems) out.prefixItems = (s.prefixItems as J[]).map((x) => shape(x, fromOpenApi, root));
  // additionalProperties (rw-p0b-purge-door, tester finding T2-4: `{}` -> `false` passed): a
  // boolean is kept as it is, a schema is compared as one; absent stays absent.
  if ("additionalProperties" in s) {
    const ap = s.additionalProperties;
    out.additionalProperties = typeof ap === "boolean" ? ap : shape(ap as J, fromOpenApi, root);
  }
  if (s.patternProperties) {
    out.patternProperties = Object.fromEntries(Object.keys(s.patternProperties).sort().map((k) => [k, shape(s!.patternProperties[k], fromOpenApi, root)]));
  }
  if ("propertyNames" in s) out.propertyNames = typeof s.propertyNames === "boolean" ? s.propertyNames : shape(s.propertyNames, fromOpenApi, root);
  // the value-restricting keywords (attempt 2, N4): compared, never skipped
  if ("not" in s) out.not = typeof s.not === "boolean" ? s.not : shape(s.not, fromOpenApi, root);
  if ("enum" in s) out.enum = (s.enum as unknown[]).map((v) => JSON.stringify(v)).sort();
  if ("const" in s) out.const = JSON.stringify(s.const);
  if (any.length) out.anyOf = sortedBranches(any, fromOpenApi, root);
  if (s.oneOf) out.oneOf = sortedBranches(s.oneOf, fromOpenApi, root);
  if (s.allOf) out.allOf = sortedBranches(s.allOf, fromOpenApi, root);
  return out;
}

// metadata_filter: a JSON string on the HTTP route, an object over MCP (the adapter serialises
// it) - the one deliberate difference. The OpenAPI string carries "an optional JSON object" of
// any keys, so the MCP side is an object whose additional properties are any value: `{}`.
const METADATA_FILTER_SHAPE: J = { type: "object", nullable: false, additionalProperties: shape({}, false) };

// What the OpenAPI document says each MCP tool's input is, nested.
function expectedShapes(): Map<string, J> {
  const out = new Map<string, J>();
  for (const item of Object.values(doc.paths as J)) {
    for (const op of Object.values(item as J) as J[]) {
      if (!op["x-mcp-tool"]) continue;
      const props: J = {};
      const required: string[] = [];
      for (const p of op.parameters ?? []) {
        props[p.name] = p.name === "metadata_filter" ? METADATA_FILTER_SHAPE : shape(p.schema, true);
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
    // the MCP side's metadata_filter is a record: compare it as the bare object it is, with its
    // additionalProperties (z.record emits propertyNames too; that is the record's key type)
    const mf = got.properties?.metadata_filter;
    if (mf) got.properties.metadata_filter = { type: mf.type, nullable: false, additionalProperties: mf.additionalProperties };
    assertEquals(got, want.get(t.name), `${t.name}: the nested input schema drifted from the OpenAPI document`);
  }
});

// The tool MANIFEST (contract-tools.json, what the adapter is built from) against the OpenAPI
// document at every level, additionalProperties included (rw-p0b-purge-door, T2-4): the adapter
// maps every bare object to a record and never reads additionalProperties, so tools/list alone
// cannot see a manifest that says `false` where the document allows any key.
Deno.test("the tool manifest matches the OpenAPI document AT EVERY LEVEL, additionalProperties included", () => {
  const want = expectedShapes();
  assertEquals(CONTRACT_TOOLS.map((t) => t.tool).sort(), [...want.keys()].sort(), "the manifest's tool set drifted");
  for (const t of CONTRACT_TOOLS) {
    assertEquals(shape(t.input as J, false), want.get(t.tool), `${t.tool}: the manifest's input schema drifted from the OpenAPI document`);
  }
});

// rw-p0b-purge-door attempt 3 (attempt-2 tester near-miss): shape() resolves $ref on BOTH sides
// (or refuses it) and keeps items:false. Each assertion is one shape; a revert of either makes it fail.
function shapeThrows(s: J, fromOpenApi: boolean, rx: RegExp): void {
  let msg = "(no throw)";
  try {
    shape(s, fromOpenApi);
  } catch (e) {
    msg = String(e);
  }
  assert(rx.test(msg), `expected a throw matching ${rx}, got '${msg}' for ${JSON.stringify(s)}`);
}
Deno.test("shape(): a $ref resolves to its definition (manifest side: $defs and definitions)", () => {
  const inline = { type: "object", properties: { a: { type: "string", pattern: "^a" } }, required: ["a"] };
  const viaDefs = { type: "object", properties: { a: { $ref: "#/$defs/A" } }, required: ["a"], $defs: { A: { type: "string", pattern: "^a" } } };
  const viaDefinitions = { type: "object", properties: { a: { $ref: "#/definitions/A" } }, required: ["a"], definitions: { A: { type: "string", pattern: "^a" } } };
  assertEquals(shape(viaDefs, false), shape(inline, false));
  assertEquals(shape(viaDefinitions, false), shape(inline, false));
  const drift = { ...viaDefs, $defs: { A: { type: "string", pattern: "^b" } } };
  assert(JSON.stringify(shape(drift, false)) !== JSON.stringify(shape(inline, false)), "a drift behind a $ref must show");
});
Deno.test("shape(): an unresolvable $ref throws (manifest side)", () => {
  shapeThrows({ type: "object", properties: { a: { $ref: "#/$defs/Nope" } } }, false, /unresolvable \$ref '#\/\$defs\/Nope'/);
});
Deno.test("shape(): a $ref outside the schema throws", () => {
  shapeThrows({ type: "object", properties: { a: { $ref: "https://example.invalid/s.json" } } }, false, /unresolvable \$ref/);
});
Deno.test("shape(): an unresolvable OpenAPI $ref throws", () => {
  shapeThrows({ $ref: "#/components/schemas/NoSuchSchema" }, true, /unresolvable \$ref/);
});
Deno.test("shape(): a looping $ref throws", () => {
  shapeThrows({ $ref: "#/$defs/A", $defs: { A: { $ref: "#/$defs/A" } } }, false, /longer than 32/);
});
Deno.test("shape(): a $ref with a sibling keyword it would drop throws", () => {
  shapeThrows({ type: "object", properties: { a: { $ref: "#/$defs/A", type: "integer" } }, $defs: { A: { type: "string" } } }, false, /sibling keyword\(s\) type/);
});
Deno.test("shape(): items:false is compared as false, not as absent", () => {
  const none = shape({ type: "array", items: false }, false);
  assertEquals(none.items, false);
  assert(JSON.stringify(none) !== JSON.stringify(shape({ type: "array" }, false)), "items:false must differ from no items keyword");
  assert(JSON.stringify(none) !== JSON.stringify(shape({ type: "array", items: {} }, false)), "items:false must differ from items:{}");
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
