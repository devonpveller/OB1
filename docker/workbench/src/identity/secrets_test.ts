// deno test src/identity/secrets_test.ts - rw-p8a3-room round 3 (tester D2): a LiteLLM key (the room's chat,
// the export's vision pass) equal to ANY secret the workbench holds is refused, both directions between the
// two; and the list of secrets is complete against the workbench's compose environment block.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { NOT_SECRET, SECRET_LISTS, SECRET_VARS, secretsEqualTo } from "./secrets.ts";
import { chatConfigFromEnv } from "../rooms/chat.ts";
import { visionConfigFromEnv } from "../export/vision.ts";

const K = "sk-shared-secret-0123456789";
const env = (m: Record<string, string>) => (k: string) => m[k];

Deno.test("D2: a chat key equal to any workbench secret is refused (chat-key-shared), naming variables only", () => {
  for (const n of SECRET_VARS.filter((x) => x !== "WORKBENCH_CHAT_KEY")) {
    const c = chatConfigFromEnv(env({ WORKBENCH_CHAT_KEY: K, WORKBENCH_CHAT_MODEL: "m", [n]: K }));
    assertEquals([c.state, c.code], ["refused", "chat-key-shared"], n);
    assert(c.reason?.includes(n) && !c.reason.includes(K), `${n}: ${c.reason}`);
  }
  const s = chatConfigFromEnv(env({ WORKBENCH_CHAT_KEY: K, WORKBENCH_CHAT_MODEL: "m", WORKSPACE_SERVICE_KEYS: `a=x-0123456789abcdef;b=${K}` }));
  assertEquals(s.code, "chat-key-shared");
});

Deno.test("D2: a vision key equal to any workbench secret is refused (vision-key-shared) - the chat key included", () => {
  for (const n of SECRET_VARS.filter((x) => x !== "EXPORT_VISION_KEY")) {
    const v = visionConfigFromEnv(env({ EXPORT_VISION_KEY: K, EXPORT_VISION_MODEL: "m", [n]: K }));
    assertEquals([v.state, v.code], ["refused", "vision-key-shared"], n);
    assert(!v.reason?.includes(K));
  }
});

Deno.test("D2: both directions between chat and vision, and the named cases of the finding", () => {
  const both = { WORKBENCH_CHAT_KEY: K, WORKBENCH_CHAT_MODEL: "m", EXPORT_VISION_KEY: K, EXPORT_VISION_MODEL: "m" };
  assertEquals(chatConfigFromEnv(env(both)).code, "chat-key-shared");
  assertEquals(visionConfigFromEnv(env(both)).code, "vision-key-shared");
  for (const n of ["OPENALEX_API_KEY", "DB_PASSWORD", "WORKSPACE_FORWARD_AUTH_CLIENT_SECRET"]) {
    assertEquals(chatConfigFromEnv(env({ WORKBENCH_CHAT_KEY: K, WORKBENCH_CHAT_MODEL: "m", [n]: K })).state, "refused", `chat ${n}`);
    assertEquals(visionConfigFromEnv(env({ EXPORT_VISION_KEY: K, EXPORT_VISION_MODEL: "m", [n]: K })).state, "refused", `vision ${n}`);
  }
  assertEquals(visionConfigFromEnv(env({ EXPORT_VISION_KEY: K, EXPORT_VISION_MODEL: "m", WORKBENCH_GATE_KEY: K })).state, "refused");
  // distinct keys are accepted
  assertEquals(chatConfigFromEnv(env({ WORKBENCH_CHAT_KEY: K, WORKBENCH_CHAT_MODEL: "m", DB_PASSWORD: "other", EXPORT_VISION_KEY: "other2" })).state, "on");
  assertEquals(secretsEqualTo(env({ DB_PASSWORD: K }), K, "WORKBENCH_CHAT_KEY"), ["DB_PASSWORD"]);
});

// The workbench's compose environment block: OB1/docker/docker-compose.yml, service openbrain-workbench.
// Found from the source tree (a checkout) or WORKBENCH_COMPOSE_FILE (the lab mounts it into the test image);
// the image's build gate has no compose file, so there the test is ignored and run-room-tests.ps1 runs it.
function composePath(): string | null {
  const fromEnv = Deno.env.get("WORKBENCH_COMPOSE_FILE");
  const cands = [fromEnv, decodeURIComponent(new URL("../../../docker-compose.yml", import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1")].filter(Boolean) as string[];
  for (const p of cands) {
    try {
      Deno.statSync(p);
      return p;
    } catch { /* next */ }
  }
  return null;
}
const COMPOSE = composePath();

export function workbenchEnvNames(yml: string): string[] {
  const lines = yml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^ {2}openbrain-workbench:\s*$/.test(l));
  if (start < 0) throw new Error("no openbrain-workbench service in the compose file");
  const names: string[] = [];
  let inEnv = false;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^ {2}\S/.test(l)) break; // the next service
    if (/^ {4}environment:\s*$/.test(l)) { inEnv = true; continue; }
    if (inEnv && /^ {4}\S/.test(l)) inEnv = false; // the next key of the service
    const m = inEnv ? /^ {6}(?:- )?([A-Z][A-Z0-9_]*)\s*[:=]/.exec(l) : null;
    if (m) names.push(m[1]);
  }
  return names;
}

Deno.test({
  name: "D2: every secret-looking variable in the workbench's compose environment is on the secrets list (or allow-listed)",
  ignore: !COMPOSE,
  fn: async () => {
    const names = workbenchEnvNames(await Deno.readTextFile(COMPOSE!));
    assert(names.length > 30 && names.includes("WORKBENCH_CHAT_KEY") && names.includes("DB_PASSWORD"), `parsed ${names.length} names`);
    const known = new Set<string>([...SECRET_VARS, ...SECRET_LISTS, ...Object.keys(NOT_SECRET)]);
    const missing = names.filter((n) => /KEY|SECRET|PASSWORD|TOKEN/.test(n) && !known.has(n));
    assertEquals(missing, [], "a secret-looking variable the workbench is passed is not on src/identity/secrets.ts's list");
    console.log(`D2 compose check: ${names.length} variables in the workbench's environment, ${names.filter((n) => /KEY|SECRET|PASSWORD|TOKEN/.test(n)).length} secret-looking, all listed`);
  },
});

Deno.test("D2: the compose parser finds a planted secret-looking name (the check is not vacuous)", () => {
  const yml = "services:\n  openbrain-workbench:\n    image: x\n    environment:\n      DB_PASSWORD: ${P}\n      NEW_THING_TOKEN: ${T}\n    volumes:\n      - a:/b\n  other:\n    environment:\n      OTHER_SECRET: x\n";
  assertEquals(workbenchEnvNames(yml), ["DB_PASSWORD", "NEW_THING_TOKEN"]);
  const known = new Set<string>([...SECRET_VARS, ...SECRET_LISTS, ...Object.keys(NOT_SECRET)]);
  assertEquals(workbenchEnvNames(yml).filter((n) => /KEY|SECRET|PASSWORD|TOKEN/.test(n) && !known.has(n)), ["NEW_THING_TOKEN"]);
});
