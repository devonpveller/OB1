// The caller's own inlet connections (rwr-imports-server-api): GET /workbench/contract/inlets/connections. Acts as the
// identity seam's subject; user-only (a service key has no inlets: middleware/identity.ts USER_ONLY answers 403).
import { createRoute } from "../deps.ts";
import { connectionsOf } from "../repo/inlets.ts";
import { InletConnections, INX } from "../schemas/inlets.ts";
import { type ContractApp, type ContractDeps, errors, fail, json, op, PREFIX, send } from "./http.ts";
import { identityOf } from "../../middleware/identity.ts";

export function registerInlets(app: ContractApp, deps: ContractDeps) {
  op(app, createRoute({
    method: "get", path: `${PREFIX}/inlets/connections`, operationId: "inletConnections", tags: ["inlets"],
    summary: "the caller's own connected inlets: kind and stamps only, never anyone else's",
    description: "Read through the database function inlet_connections_of(sub) (slot 600). Another person's connections are not " +
      "returned, counted or hinted at; a person with none gets an empty list.",
    responses: { 200: json(InletConnections, INX.connections, "the caller's connections"), ...errors },
  }), async (c) => {
    try {
      return send(c, InletConnections, { connections: await connectionsOf(deps.db, await identityOf(c)) });
    } catch (e) {
      return fail(c, e);
    }
  });
}
