// deno test src/contracts/notices_test.ts - D9 rule 5: "a dependency added without a notices
// entry fails the build". Runs in the image build gate (THIRD-PARTY-NOTICES.md and deno.lock are
// copied into /app) and in the repo, where it also checks openbrain-mcp's imports.
import { assert, assertEquals } from "jsr:@std/assert@1";

const root = new URL("../../", import.meta.url);
const notices = await Deno.readTextFile(new URL("THIRD-PARTY-NOTICES.md", root));
const rows = notices.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("|---"));

function hasRow(name: string, version: string): boolean {
  return rows.some((r) => {
    const cells = r.split("|").map((c) => c.trim());
    return cells[1]?.includes(name) && cells[2]?.includes(version);
  });
}

const PERMISSIVE = /^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|PostgreSQL|MPL-2\.0|BSD-2-Clause-Patent)\b/;

Deno.test("every jsr and npm package in deno.lock has a notices row at its locked version, with a permissive licence", async () => {
  const lock = JSON.parse(await Deno.readTextFile(new URL("deno.lock", root)));
  const pkgs = [...Object.keys(lock.jsr ?? {}), ...Object.keys(lock.npm ?? {})];
  assert(pkgs.length >= 8, `only ${pkgs.length} packages in deno.lock`);
  for (const p of pkgs) {
    const m = /^(@?[^@]+)@([^_]+)/.exec(p)!;
    const [name, version] = [m[1], m[2]];
    assert(hasRow(name, version), `deno.lock has ${name}@${version} but THIRD-PARTY-NOTICES.md has no row for it`);
    const row = rows.find((r) => r.split("|")[1].includes(name) && r.split("|")[2].includes(version))!;
    assert(PERMISSIVE.test(row.split("|")[3].trim()), `${name}@${version} is not under a permissive licence: ${row}`);
  }
});

Deno.test("every remote module host in deno.lock is noticed (deno-postgres, deno std)", async () => {
  const lock = JSON.parse(await Deno.readTextFile(new URL("deno.lock", root)));
  const remotes = Object.keys(lock.remote ?? {});
  const versions = new Set<string>();
  for (const u of remotes) {
    const m = /deno\.land\/(x\/postgres|std)@v?([0-9.]+)\//.exec(u);
    assert(m, `unrecognised remote module ${u}: add it to the notices and to this check`);
    versions.add(`${m[1]}@${m[2]}`);
  }
  for (const v of versions) {
    const [name, version] = v.split("@");
    assert(hasRow(name === "x/postgres" ? "deno-postgres" : "deno.land/std", version), `no notices row for ${v}`);
  }
});

Deno.test("openbrain-mcp's imports are noticed (the contract's MCP host)", async () => {
  let cfg: { imports: Record<string, string> };
  try {
    cfg = JSON.parse(await Deno.readTextFile(new URL("../../integrations/kubernetes-deployment/deno.json", root)));
  } catch {
    return; // not in the workbench image's build context
  }
  for (const spec of Object.values(cfg.imports)) {
    const m = /^npm:(@?[^@]+)@(.+)$/.exec(spec) ?? /deno\.land\/x\/(postgres)@v([0-9.]+)/.exec(spec);
    assert(m, `unrecognised import ${spec}`);
    const name = m[1] === "postgres" ? "deno-postgres" : m[1];
    assert(hasRow(name, m[2]), `openbrain-mcp imports ${spec} but THIRD-PARTY-NOTICES.md has no row for it`);
  }
});

Deno.test("the model weights in use are listed with their model-card licence", () => {
  const section = notices.split("## Model weights in use")[1]?.split("\n## ")[0] ?? "";
  for (const required of ["BAAI/bge-m3", "Qwen3.8-27B", "ThinkingCap", "Kokoro-82M", "deberta-v3-base-prompt-injection-v2"]) {
    assert(section.includes(required), `model ${required} is missing from the notices`);
  }
  assert(/ThinkingCap[^\n]*apache-2\.0[^\n]*NO licence field/i.test(section), "the ThinkingCap card / GGUF gap must be recorded");
  assert(/bge-m3[^\n]*\bMIT\b/.test(section), "bge-m3 must be listed as MIT");
  assert(/Kokoro-82M[^\n]*P7a[^\n]*apache-2\.0/i.test(section), "Kokoro must be listed as Apache-2.0, landing in P7a");
});

Deno.test("copyleft programs appear only as separate processes", () => {
  for (const r of rows.filter((x) => /\bGPL\b|GPL-/.test(x) && !/LGPL/.test(x))) {
    assert(/SEPARATE PROCESS|separate service|separate container/i.test(r), `a GPL item is not marked separate: ${r}`);
  }
});

// research-workbench P6a (acceptance 5 and 7, D9): the export's separate programs with their
// versions, pandoc's source offer, the CSL project with its link, every shipped style with its
// author listing, and manubot's licence mismatch.
const section = (title: string) => notices.split(`## ${title}`)[1]?.split("\n## ")[0] ?? "";
const programRow = (name: string) => rows.find((r) => r.split("|")[1]?.trim().startsWith(name));

Deno.test("P6a: pandoc, Typst and poppler are listed with their versions; the GPL ones as separate processes", async () => {
  const want: Record<string, string> = { pandoc: "3.11", Typst: "0.15.1", "poppler-utils": "25.03.0" };
  let dockerfile = "";
  try {
    dockerfile = await Deno.readTextFile(new URL("Dockerfile", root));
  } catch { /* inside the image: the Dockerfile is not copied */ }
  for (const [name, version] of Object.entries(want)) {
    const r = programRow(name);
    assert(r, `no notices row for ${name}`);
    assert(r.split("|")[2].includes(version), `${name}: the row does not carry ${version}`);
  }
  for (const name of ["pandoc", "poppler-utils"]) assert(/SEPARATE PROCESS only/.test(programRow(name)!), `${name} is not marked a separate process`);
  if (dockerfile) {
    assert(dockerfile.includes("ARG PANDOC_VERSION=3.11") && dockerfile.includes("ARG TYPST_VERSION=0.15.1"), "the Dockerfile pins differ from the notices");
  }
  const env = Deno.env.get("EXPORT_PANDOC_VERSION");
  if (env) assertEquals(env, want.pandoc, "the image's pandoc version differs from the notices");
});

Deno.test("P6a: pandoc's GPL-2.0-or-later source offer is in the notices", () => {
  const offer = section("pandoc: GPL-2.0-or-later source offer");
  assert(/GNU General Public License,\s+version 2 or later/.test(offer), "the licence");
  assert(offer.includes("https://github.com/jgm/pandoc/archive/refs/tags/3.11.tar.gz"), "where the source is");
  assert(/three years/.test(offer) && /separate program/.test(offer), "the written offer and the separation");
});

Deno.test("P6a: the notices mention the CSL project with its link and list every shipped style with its authors", async () => {
  const csl = section("Citation styles (data, used unmodified)");
  assert(csl.includes("Citation Style Language (CSL) project") && csl.includes("https://citationstyles.org/"), "the CSL mention and link");
  assert(/Attribution-ShareAlike 3\.0/.test(csl), "the licence");
  for (const e of Deno.readDirSync(new URL("csl/", root))) {
    if (!e.name.endsWith(".csl")) continue;
    const xml = await Deno.readTextFile(new URL(`csl/${e.name}`, root));
    const row = csl.split("\n").find((l) => l.startsWith(`| ${e.name} |`));
    assert(row, `${e.name} is shipped but not listed`);
    const info = /<info>([\s\S]*?)<\/info>/.exec(xml)![1];
    for (const m of info.matchAll(/<(author|contributor)>[\s\S]*?<name>([\s\S]*?)<\/name>/g)) {
      assert(row.includes(m[2].trim().replaceAll("&apos;", "'")), `${e.name}: ${m[1]} ${m[2]} is missing from the notices`);
    }
  }
});

Deno.test("P6a: manubot is noticed at its pinned commit with its licence text and the PyPI mismatch recorded", () => {
  const ported = section("Code ported into the workbench (research-workbench P6a)");
  assert(ported.includes("859dd15850d7e89184e75c3a63e9d9e3f9ab9873"), "the pinned commit");
  assert(/BSD-2-Clause Plus Patent License/.test(ported) && /Recorded mismatch/.test(ported) && /BSD 3-Clause License/.test(ported));
  assert(ported.includes("Redistributions of source code must retain the above copyright notice"), "the licence text is carried");
});
