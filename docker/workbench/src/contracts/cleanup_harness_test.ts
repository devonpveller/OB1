// The round-3 / round-3b test harness (no database): a scripted Db that models transactions - a statement belongs
// to the transaction it ran in, a throw rolls that transaction back - behind the real identity seam in header mode
// (X-Test-Sub), with the contract app mounted as src/app.ts mounts it (under the app's last-resort onError).
// A *_test.ts file so the runtime image never ships it; it declares no test.
import { Hono } from "hono";
import { createContractApp } from "./app.ts";
import { RegistryReader } from "./registry.ts";
import { unavailableScorer } from "./logic/reopen.ts";
import type { Db } from "./db.ts";
import { internalError } from "../middleware/errors.ts";
import { identitySeam, seamDeps } from "../middleware/identity.ts";

export const SRC = "33333333-3333-4333-8333-333333333333";
export const TOMB = "66666666-6666-4666-8666-666666666667";
export const AT = "2026-11-02T00:00:00.000Z";

export interface Stmt { sql: string; args: unknown[]; tx: number }
export type Handler = [RegExp, (args: unknown[]) => unknown[]];

const REG = [
  ["erasure_reasons", "deliberate", { reopen_path: "note_only" }], ["erasure_reasons", "debunked", { reopen_path: "rescore_contest" }],
  ["erasers", "user", { gate: "candidate", requires: "user" }], ["erasers", "automation", { gate: "auto", requires: "run_id" }],
  ["dependence_kinds", "chunk", { blocks_erase: true, severable: true }], ["dependence_kinds", "trail_event", { blocks_erase: false, severable: false }],
].map(([registry, key, definition]) => ({ registry, key, version: 1, label: key, definition, retired_at: null, superseded_by: null }));

export const tombRow = (over: Record<string, unknown> = {}) => ({
  id: TOMB, source_id: SRC, url: "https://example.org/x", title: "x", reason_type: "deliberate", note: null, batch_run_id: null,
  eraser_kind: "user", eraser_user: "u-bee", eraser_run_id: null, confidence: null, score_version: null, fingerprint: null,
  erased_at: AT, lifted_at: null, lifted_by: null, readmitted_source_id: null, attempts: [], readmitted_in_scope: false, ...over,
});

export function harness(handlers: Handler[]) {
  const seen: Stmt[] = [];
  const rolledBack = new Set<number>();
  let nextTx = 0;
  const make = (tx: number): Db => ({
    query: <T>(sql: string, args: unknown[] = []) => {
      seen.push({ sql, args, tx });
      if (/FROM public\.contract_registry_view/.test(sql)) return Promise.resolve(REG as T[]);
      for (const [re, fn] of handlers) if (re.test(sql)) return Promise.resolve().then(() => fn(args) as T[]);
      return Promise.resolve([] as T[]);
    },
    tx: async <T>(fn: (d: Db) => Promise<T>) => {
      if (tx !== 0) return await fn(make(tx)); // nested: the same transaction
      const id = ++nextTx;
      try {
        return await fn(make(id));
      } catch (e) {
        rolledBack.add(id);
        throw e;
      }
    },
  });
  const db = make(0);
  const contract = createContractApp({
    db, registry: new RegistryReader(db, 0), scorer: unavailableScorer, embed: () => Promise.reject(new Error("x")),
    chunk: () => [], mountsRoot: "/mounts", streamPollMs: 10, log: () => {},
  });
  const env = (k: string) => ({ WORKSPACE_IDENTITY_HEADER: "X-Test-Sub" } as Record<string, string>)[k];
  const app = new Hono();
  app.onError(internalError);
  app.use("*", identitySeam(seamDeps(null, env)));
  app.route("/", contract);
  const call = (who: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json", "x-test-sub": who }, body: body === undefined ? undefined : JSON.stringify(body) });
  // a statement committed = it ran outside any transaction, or in one that was not rolled back
  const committed = (re: RegExp) => seen.filter((s) => re.test(s.sql) && (s.tx === 0 || !rolledBack.has(s.tx)));
  return { call, seen, committed };
}

export const lockUnlinked: Handler = [/FROM public\.sources WHERE id = \$1 FOR UPDATE/, () => [{ id: SRC, lifecycle: "unlinked", url: "https://example.org/x", title: "x", content: "c" }]];
export const lifeUnlinked: Handler = [/AS lifecycle FROM public\.sources\s+WHERE id = \$1 AND/, () => [{ lifecycle: "unlinked" }]];
export const tombInsert: Handler = [/INSERT INTO public\.source_tombstones/, () => [{ id: TOMB }]];
export const tombSelect = (over: Record<string, unknown> = {}): Handler => [/FROM public\.source_tombstones t/, () => [tombRow(over)]];
