// A person's own inlet connections (rwr-imports-server-api): what the Imports screen's "Connected inlets" panel lists.
// Read through slot 600's inlet_connections_of(sub): the caller's rows only, kind and stamps only - never the connection's
// id (it can name a mailbox or a vault), never an owner. No request has a user field: whose connections come back is
// the identity seam's subject.
import { z } from "../deps.ts";
import { Iso } from "./common.ts";
import { FX } from "./fixtures.ts";

export const InletConnection = z.object({
  kind: z.string().min(1).openapi({ example: "gmail", description: "what the inlet is (gmail, vault, ...): an open string, never a closed list here" }),
  created_at: Iso,
  updated_at: Iso,
}).openapi("InletConnection");

export const InletConnections = z.object({
  connections: z.array(InletConnection).openapi({ description: "the caller's own connections, oldest first; none when they have none" }),
}).openapi("InletConnections");

export const INX = {
  connections: { connections: [{ kind: "gmail", created_at: FX.at, updated_at: FX.at }] },
};
