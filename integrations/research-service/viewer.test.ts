// deno test viewer.test.ts - rw-identity round 2: whose jobs a read shows, and the prompt omission.
import { assertEquals } from "jsr:@std/assert@1";
import { callerFor, parseCallers } from "./origin.ts";
import { omitPrompts, readViewer } from "./viewer.ts";

const OWUI = "owui-key-0123456789abcdef";
const AO = "agent-org-key-0123456789ab";
const WS = "ws-key-0123456789abcdef";
const SHARED = "shared-mcp-key-0123456789";
const callers = parseCallers(`owui-tool=owui:${OWUI};agent-org=mattermost:${AO};workspace=workspace:${WS}`, SHARED, "manual");
const by = (k: string) => callerFor(k, callers)!;

Deno.test("readViewer: OWUI and the workspace may read for a user; every other key reads as its service; naming a user from one is 403", () => {
  assertEquals(readViewer(by(OWUI), "ak-alice"), { sub: "ak-alice" });
  assertEquals(readViewer(by(WS), " ak-bob "), { sub: "ak-bob" });
  assertEquals(readViewer(by(OWUI), null), { sub: "service:owui-tool" });
  assertEquals(readViewer(by(AO), ""), { sub: "service:agent-org" });
  assertEquals(readViewer(by(SHARED), null), { sub: "service:shared-key" });
  for (const k of [AO, SHARED]) assertEquals((readViewer(by(k), "ak-alice") as { status: number }).status, 403);
  assertEquals((readViewer(by(OWUI), "service:internal") as { status: number }).status, 400);
});

Deno.test("omitPrompts: every string carrying the prompt (or its 40-char head) is dropped at any depth; the rest is kept", () => {
  const p = "CrossUserPrompt0123 how do tidal locks form in binary systems";
  const job = {
    id: "j", status: "done", progress: { phase: "plan", message: `planning ${p}` },
    result: { query: p, synthesis: "Tidal locking happens when...", sources: [{ title: `about ${p}`, url: "https://x" }, { title: "other", url: "https://y" }] },
    error: `failed on ${p.slice(0, 40)}...`, tags: [p, "kept"],
  };
  assertEquals(omitPrompts(job as Record<string, unknown>, [p]), {
    id: "j", status: "done", progress: { phase: "plan" },
    result: { synthesis: "Tidal locking happens when...", sources: [{ url: "https://x" }, { title: "other", url: "https://y" }] },
    tags: ["kept"],
  });
  assertEquals(omitPrompts(job, []), job);
});
