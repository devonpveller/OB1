// The Imports fake (e2e/imports-fake.mjs) must not drift from the real server (the docs-list tester caught that class of
// bug): this reads the server's own source and checks the constants and refusal texts the screen depends on. It runs
// in the repo checkout, where the server source is beside the app; inside the app's image build (whose context holds
// only the app) the server files are absent and these cases are skipped, the forwarder's case reads the copy the image
// carries at lib/shared.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACTIVE, CANCELLABLE, KINDS, MAX_ATTEMPTS as FAKE_MAX, RETRIED_ALREADY } from "../e2e/imports-fake.mjs";
import { FILE_LIMIT_BYTES, JOBS_LIMIT, MAX_ATTEMPTS } from "../src/screens/imports/imports-data";

const SERVER = resolve(__dirname, "../../workbench/src/intake");
const have = existsSync(resolve(SERVER, "repo.ts"));
const src = (f: string) => readFileSync(resolve(SERVER, f), "utf8");
const setOf = (text: string, name: string) => {
  const m = text.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`));
  return m ? [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]) : null;
};

describe.skipIf(!have)("the fake matches the server's intake source", () => {
  it("the active and cancellable import states, and the queues the panel shows", () => {
    const repo = src("repo.ts");
    expect(setOf(repo, "ACTIVE_IMPORT")).toEqual(ACTIVE);
    expect(setOf(repo, "CANCELLABLE_IMPORT")).toEqual(CANCELLABLE);
    expect(repo.match(/INTAKE_KINDS = \[([^\]]*)\]/)![1].match(/"([a-z]+)"/g)!.map((s) => s.slice(1, -1))).toEqual(KINDS);
  });
  it("a job starts at attempts 1 and a retry adds one (so MAX_ATTEMPTS = 2 means Try again once)", () => {
    expect(readFileSync(resolve(__dirname, "../../init-intake-queue.sql"), "utf8")).toMatch(/attempts\s+INT NOT NULL DEFAULT 1/);
    expect(src("routes.ts")).toMatch(/attempts = attempts \+ 1/);
    expect(MAX_ATTEMPTS).toBe(2);
  });
  it("the list's per-kind limit is 200 and its default is 50 (parseLimit)", () => {
    expect(src("routes.ts")).toMatch(/parseLimit\(c\.req\.query\("limit"\), 50, 200\)/);
    expect(JOBS_LIMIT).toBe(200);
  });
  it("every refusal text the fake answers with is in the server's source", () => {
    const routes = src("routes.ts"), repo = src("repo.ts");
    for (const t of [
      "no such job", "a link or a file is required", "a link or a file, not both", "the link must be an http or https address", "a refinery or a document, not both",
      "choose the refinery it joins (a user add lands only in an existing idea refinery)", "no such refinery (an add joins one of your existing refineries)",
      "this document has no open refinery: open the document's refinery first (a user source lands only in an existing refinery)",
      "a file add is a PDF or a saved web page (a YouTube transcript is added by its link)", "the job moved on before it could be retried", "not a queue the panel shows",
    ]) expect(routes, t).toContain(t);
    expect(routes).toContain("a ${job.status} ${job.kind} job cannot be retried");
    expect(repo).toContain("a ${job.status} ${job.kind} job cannot be cancelled");
    expect(repo).toContain("cancelled by the user");
    expect(readFileSync(resolve(__dirname, "../../workbench/src/documents/repo.ts"), "utf8")).toContain('new DocError("no such document", 404)');
  });
  it("a foreign job and a missing one are the same 404 answer (getJob is owner-scoped, the route says one text)", () => {
    const routes = src("routes.ts");
    expect((routes.match(/c\.json\(\{ error: "no such job" \}, 404\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(src("repo.ts")).toMatch(/MINE\("j", "\$2", "\$3"\)/);
  });
  it("the detail fields the screen reads are the ones the import read selects", () => {
    const repo = src("repo.ts");
    for (const f of ["origin", "error", "url", "filename", "content_type", "refinery_id", "doc_path", "held_source_id", "source_id", "attempts"]) expect(repo, f).toContain(`'${f}'`);
    expect(repo).toMatch(/phase: r\.status, actions: a\.actions|phase: r\.status/);
  });
});

describe.skipIf(!have)("the file limit, the retry cap and the own-inlets route are the server's", () => {
  it("the screen's up-front file limit is the intake route's own (25 MB), read from its source", () => {
    const m = src("routes.ts").match(/deps\.maxFileBytes \?\? (\d+) \* 1024 \* 1024/);
    expect(m).toBeTruthy();
    expect(FILE_LIMIT_BYTES).toBe(Number(m![1]) * 1024 * 1024);
    expect(src("routes.ts")).toContain("the file is larger than ${maxFile} bytes");
  });
  it("the retry cap and its reason match intake/repo.ts and the route's 409", () => {
    const repo = src("repo.ts");
    expect(Number(repo.match(/MAX_ATTEMPTS = (\d+)/)![1])).toBe(FAKE_MAX);
    expect(repo).toContain(`RETRIED_ALREADY = "${RETRIED_ALREADY}"`);
    expect(src("routes.ts")).toMatch(/attempts \?\? 1\) >= repo\.MAX_ATTEMPTS\) return c\.json\(\{ error: repo\.RETRIED_ALREADY \}, 409\)/);
  });
  it("the own-inlets route answers kind and the two stamps, as the fake does", () => {
    const base = resolve(__dirname, "../../workbench/src/contracts");
    const schema = readFileSync(resolve(base, "schemas/inlets.ts"), "utf8");
    for (const f of ["kind", "created_at", "updated_at"]) expect(schema).toContain(`${f}:`);
    expect(readFileSync(resolve(base, "routes/inlets.ts"), "utf8")).toContain("/inlets/connections");
  });
});
