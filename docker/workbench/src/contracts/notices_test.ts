// deno test src/contracts/notices_test.ts - D9 rule 5: "a dependency added without a notices
// entry fails the build". Runs in the image build gate (THIRD-PARTY-NOTICES.md and deno.lock are
// copied into /app) and in the repo, where it also checks openbrain-mcp's imports.
import { assert } from "jsr:@std/assert@1";

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
