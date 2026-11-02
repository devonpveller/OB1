// The workbench's secrets, by environment variable name (rw-p8a3-room round 3, tester D2): the ONE list a
// consumer checks before it sends a key anywhere. A LiteLLM virtual key (the export's vision pass, the room's
// chat) that equals any of these is refused - it would otherwise leave the workbench as a bearer token.
//
// secrets_test.ts reads the workbench's `environment:` block in OB1/docker/docker-compose.yml and fails when
// a variable whose name looks secret (KEY, SECRET, PASSWORD, TOKEN) is in neither SECRET_VARS, SECRET_LISTS
// nor NOT_SECRET - so a new secret added to compose cannot be forgotten here.
import { isServiceKey, sameKey } from "./keys.ts";

// one secret value each
export const SECRET_VARS = [
  "WORKBENCH_KEY", "MCP_ACCESS_KEY", "WORKSPACE_DOOR_KEY", // the door and internal keys
  "EMBEDDING_API_KEY", "EXPORT_VISION_KEY", "WORKBENCH_CHAT_KEY", // LiteLLM virtual keys
  "RESEARCH_SCORER_KEY", "RESEARCH_WORKSPACE_KEY", "WORKBENCH_GATE_KEY", // sibling services' caller keys
  "OPENALEX_API_KEY", // the export resolver's OpenAlex key
  "DB_PASSWORD", // the database
  "WORKSPACE_FORWARD_AUTH_CLIENT_SECRET", // Authentik's proxy provider secret (signs the outpost token)
] as const;

// lists of secrets: WORKSPACE_SERVICE_KEYS, name=key;name=key (keys.ts serviceKeys)
export const SECRET_LISTS = ["WORKSPACE_SERVICE_KEYS"] as const;

// names that look secret but are not (none today; each entry says why)
export const NOT_SECRET: Record<string, string> = {};

// The variables (other than `self`) whose secret equals `key`, compared in constant time. Names only.
export function secretsEqualTo(env: (k: string) => string | undefined, key: string, self: string): string[] {
  const out: string[] = SECRET_VARS.filter((n) => n !== self && sameKey((env(n) ?? "").trim(), key));
  for (const n of SECRET_LISTS) if (isServiceKey(env(n), key)) out.push(n);
  return out;
}
