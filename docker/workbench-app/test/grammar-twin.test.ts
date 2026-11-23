// rwr-doc-editor acceptance 5: the grammar twin check fails when the app's copy differs from the documents API's grammar
// by ONE byte. The check itself is scripts/grammar-twin.mjs (the lab runner's step [5c] runs it against the real server
// file). In the image build only this app is present, so the comparison with the server file runs where it exists
// (the repo checkout) and the rest of the tests run everywhere.
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error a plain .mjs script
import { check, firstDifference, SERVER, TWIN } from "../scripts/grammar-twin.mjs";

describe("the grammar twin check", () => {
  const twin = readFileSync(TWIN);
  it("two identical byte strings pass", () => {
    expect(firstDifference(twin, Buffer.from(twin))).toBeNull();
  });
  it("one changed byte fails, and says where", () => {
    for (const at of [0, 1234, twin.length - 1]) {
      const other = Buffer.from(twin);
      other[at] = other[at] ^ 0x01;
      expect(firstDifference(twin, other)).toMatch(new RegExp(`differ at byte ${at} `));
    }
  });
  it("one extra or missing byte fails (a trailing newline counts, so does a line ending)", () => {
    expect(firstDifference(twin, Buffer.concat([twin, Buffer.from("\n")]))).toMatch(/differ in length/);
    expect(firstDifference(twin, twin.subarray(0, twin.length - 1))).toMatch(/differ in length/);
    const lf = Buffer.from(twin.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
    if (lf.length !== twin.length) expect(firstDifference(twin, lf)).not.toBeNull();
  });
  it("check() reads two files and fails for a file that differs by one byte", () => {
    const dir = mkdtempSync(join(tmpdir(), "twin-"));
    const a = join(dir, "a.ts"), b = join(dir, "b.ts");
    writeFileSync(a, twin);
    writeFileSync(b, twin);
    expect(check(a, b).ok).toBe(true);
    const mut = Buffer.from(twin);
    mut[200] = mut[200] === 0x78 ? 0x79 : 0x78;
    writeFileSync(b, mut);
    const r = check(a, b);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/differ at byte 200/);
  });
  it.skipIf(!existsSync(SERVER))("the app's copy is byte-identical to the documents API grammar (repo checkout)", () => {
    const r = check();
    expect(r.message).toMatch(/byte-identical/);
    expect(r.ok).toBe(true);
  });
});
