// The Cast and voices fake (e2e/voices-fake.mjs) must not drift from the real server (the docs-list tester caught that class of bug):
// this reads the server's own source (contracts/repo/cast.ts, routes/cast.ts, schemas/cast.ts, init-cast.sql) and checks the constants
// and refusal texts the screen and the fake depend on. It runs in the repo checkout, where the server source is beside the app; in the
// app image build (whose context holds only the app) the server files are absent and these cases are skipped.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ID_RE, KINDS, LANG_RE, MAX_SEATS, MODES, NAME_TAKEN, NO_SUCH, ROUTE_RE, USES, VOICE_RE } from "../e2e/voices-fake.mjs";
import { FORMAT_KINDS, FORMAT_USES, MAX_SEATS as APP_SEATS, SPEED_MAX, SPEED_MIN } from "../src/screens/voices/voices-data";

const BASE = resolve(__dirname, "../../workbench/src/contracts");
const have = existsSync(resolve(BASE, "repo/cast.ts"));
const src = (f: string) => readFileSync(resolve(BASE, f), "utf8").replace(/\r\n/g, "\n");
const keys = (sql: string, reg: string) => [...sql.matchAll(new RegExp(`\\('${reg}',\\s*'([a-z]+)'`, "g"))].map((m) => m[1]);
const FAKE = resolve(__dirname, "../e2e/voices-fake.mjs");

describe.skipIf(!have)("the fake matches the server's cast source", () => {
  it("the 404 texts, the name clash and the seat cap", () => {
    const repo = src("repo/cast.ts");
    for (const [k, v] of Object.entries(NO_SUCH)) expect(repo, k).toContain(`${k}: "${v}"`);
    expect(repo).toContain(`"${NAME_TAKEN}"`);
    expect(src("schemas/cast.ts")).toContain(`MAX_SEATS = ${MAX_SEATS};`);
    expect(APP_SEATS).toBe(MAX_SEATS);
  });
  it("the refusal sentences the screen shows to the owner are the server's (and the fake's)", () => {
    const repo = src("repo/cast.ts");
    const fake = readFileSync(FAKE, "utf8");
    for (const t of [
      "a presenter sits in a team once", "a team has at most ${MAX_SEATS} seats: ${MAX_SEATS - 1} presenters and yours", "user_seat is 0 .. ${members.length} (the number of presenters)",
      "a use is listed twice", ": give them another voice first`", "take it out of ${teams.length > 1 ? \"those teams\" : \"the team\"} first",
      "delete or move ${formats.length > 1 ? \"them\" : \"it\"} first",
    ]) expect(repo, t).toContain(t);
    for (const t of ["a presenter sits in a team once", "a use is listed twice", ": give them another voice first`", "take it out of ${teams.length > 1 ? \"those teams\" : \"the team\"} first", "delete or move ${formats.length > 1 ? \"them\" : \"it\"} first"]) {
      expect(fake, t).toContain(t);
    }
  });
  it("the registries' keys are the SQL seeds' (kinds, uses, prompt modes) and the screen offers exactly those", () => {
    const sql = readFileSync(resolve(BASE, "../../../init-cast.sql"), "utf8");
    expect(keys(sql, "podcast_format_kinds")).toEqual(KINDS);
    expect(keys(sql, "podcast_format_uses")).toEqual(USES);
    expect(keys(sql, "podcast_prompt_modes")).toEqual(MODES);
    expect(FORMAT_KINDS.map((k) => k.key)).toEqual(KINDS);
    expect(FORMAT_USES.map((u) => u.key)).toEqual(USES);
  });
  it("the field patterns and ranges are the schemas'", () => {
    const sc = src("schemas/cast.ts");
    expect(sc).toContain(`ROUTE_RE = ${ROUTE_RE.toString()};`);
    expect(sc).toContain(`const VOICE = z.string().regex(${VOICE_RE.toString()});`);
    expect(sc).toContain(`const LANG = z.string().regex(${LANG_RE.toString()})`);
    expect(sc).toContain("const SPEED = z.number().gt(0.25).lte(4);");
    expect(SPEED_MIN).toBeGreaterThan(0.25);
    expect(SPEED_MAX).toBeLessThanOrEqual(4);
    expect(src("routes/cast.ts")).toContain(`ID_RE = ${ID_RE.toString()};`);
  });
  it("the sample route: the caller's own voice link, the one 404, 503 / 429 / 502, audio/wav, never cached", () => {
    const r = src("routes/cast.ts");
    expect(r).toContain("`${P}/voices/{id}/sample`");
    expect(r).toContain('if (!v) return notFound(c, "voice");');
    expect(r).toContain("cast.getVoice(db, who.sub, id)");
    const words = ["voice samples are not available on this server", "one sample at a time, and not too many: wait a moment", "the voice engine did not answer: try again in a moment"];
    const f = readFileSync(FAKE, "utf8");
    for (const t of words) { expect(r, t).toContain(t); expect(f, t).toContain(t); }
    expect(r).toContain('"content-type": "audio/wav", "cache-control": "no-store"');
  });
  it("only the caller's own rows are listed: every list and every read is scoped by owner_sub in the repository", () => {
    const repo = src("repo/cast.ts");
    expect(repo).toMatch(/FROM public\.podcast_voice_links v WHERE v\.owner_sub = \$1/);
    expect(repo).toMatch(/v\.id = \$1 AND v\.owner_sub = \$2/);
  });
});
