// The Imports fake (e2e/imports-fake.mjs) must not drift from the real server (the docs-list tester caught that class of
// bug): this reads the server's own source and checks the constants and refusal texts the screen depends on. It runs
// in the repo checkout, where the server source is beside the app; inside the app's image build (whose context holds
// only the app) the server files are absent and these cases are skipped, the forwarder's case reads the copy the image
// carries at lib/shared.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACTIVE, CANCELLABLE, KINDS } from "../e2e/imports-fake.mjs";
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

describe("the forwarder in front of the workbench", () => {
  const candidates = [resolve(__dirname, "../lib/shared/workbench-proxy.mjs"), resolve(__dirname, "../../wiki-viewer/lib/workbench-proxy.mjs")];
  const file = candidates.find(existsSync);
  it("refuses a body over 1 MB except on the old import route: a file add here is capped at FILE_LIMIT_BYTES", () => {
    expect(file).toBeTruthy();
    const text = readFileSync(file!, "utf8");
    expect(text).toMatch(/UPLOAD\.test\(path\) \? 100 \* MB : 1 \* MB/);
    expect(text).toMatch(/const UPLOAD = \/\^\\\/workbench\\\/\(import\(/);
    expect(text).not.toMatch(/intake/); // the add route is not an upload path
    expect(FILE_LIMIT_BYTES).toBe(1024 * 1024);
  });
});
