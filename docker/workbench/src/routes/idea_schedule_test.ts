import { assertEquals } from "jsr:@std/assert@1";
import { Hono } from "hono";
import type { Db } from "../contracts/db.ts";
import { ideaScheduleRouter, parseSchedule } from "./idea-schedule.ts";

Deno.test("parseSchedule validates the three modes", () => {
  assertEquals(typeof parseSchedule({ mode: "hourly" }), "string");
  assertEquals(typeof parseSchedule({ mode: "daily", at_time: "25:00" }), "string");
  assertEquals(typeof parseSchedule({ mode: "weekly", at_time: "09:00", weekday: 8 }), "string");
  assertEquals(parseSchedule({ mode: "immediate" }), { mode: "immediate", at_time: null, weekday: null, tz: "UTC" });
  assertEquals(parseSchedule({ mode: "weekly", at_time: "18:00", weekday: 3, tz: "Asia/Kolkata" }), { mode: "weekly", at_time: "18:00", weekday: 3, tz: "Asia/Kolkata" });
});

Deno.test("the router reads and writes only the caller's subject, and research-now refuses another user's idea", async () => {
  const seen: unknown[][] = [];
  const db: Db = {
    query: (sql: string, args: unknown[] = []) => {
      seen.push([sql, ...args]);
      if (/FROM public\.ideas WHERE id/.test(sql)) return Promise.resolve([]); // not the caller's idea
      return Promise.resolve([{ mode: "immediate" }]);
    },
    tx: (fn: (d: Db) => Promise<unknown>) => fn(db),
  } as never;
  const app = new Hono().route("/s", ideaScheduleRouter(db));
  await app.request("/s");
  assertEquals(seen[0][1], "operator"); // the seam's default subject
  const r = await app.request("/s/research-now/11111111-1111-1111-1111-111111111111", { method: "POST" });
  assertEquals(r.status, 404);
  assertEquals(seen.some((s) => /idea_research_now/.test(String(s[0]))), false);
  const bad = await app.request("/s", { method: "PUT", body: JSON.stringify({ mode: "daily" }), headers: { "content-type": "application/json" } });
  assertEquals(bad.status, 400);
});
