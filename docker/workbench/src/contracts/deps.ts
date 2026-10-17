// One import point for the contract's schema toolkit. `z` is the zod instance
// @hono/zod-openapi extends with .openapi(); importing zod directly elsewhere would risk a
// second instance the OpenAPI generator does not recognise.
export { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
export type { RouteConfig } from "@hono/zod-openapi";
// The direct zod import pins the version (deno.json "zod": npm:zod@4.6.5, the licence-verified
// pin, D9 rule 6); @hono/zod-openapi's own ^4.2.1 range then resolves to the same instance.
export type { ZodType } from "zod";
