/**
 * rw-p3a-entail attempt 6 (tester near-miss NM1): run-credibility-e2e.ps1's chain (Get-Chain) skips YAML
 * comments - a commented-out `- ./init-...` mount (`# - ...`, `#- ...`, or spelled after a ` #` on a
 * line) is not staged, so the runner never tests a chain the real compose does not mount. Drives the
 * runner itself with -ChainOnly -ComposeFile (no docker). Needs PowerShell and --allow-run/--allow-write,
 * so it is IGNORED in the image build (which grants neither) and run on the host:
 *   deno test --allow-read --allow-run --allow-write --allow-env runner-chain.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const RUNNER = new URL("./run-credibility-e2e.ps1", import.meta.url);
const COMPOSE = new URL("../../docker/docker-compose.yml", import.meta.url);
const granted = (name: "run" | "write") => { try { return Deno.permissions.querySync({ name }).state === "granted"; } catch { return false; } };
const shell = Deno.build.os === "windows" ? "powershell" : "pwsh";
const runnable = granted("run") && granted("write") && (() => {
  try { return new Deno.Command(shell, { args: ["-NoProfile", "-Command", "exit 0"], stdout: "null", stderr: "null" }).outputSync().success; } catch { return false; }
})();
const path = (u: URL) => decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, "$1");

async function chainOnly(compose: string): Promise<{ code: number; out: string }> {
  const dir = await Deno.makeTempDir({ prefix: "p3a6-chain-" });
  try {
    // the compose's relative mounts resolve against the runner's OB1/docker, so only the file moves
    const f = `${dir}/docker-compose.yml`;
    await Deno.writeTextFile(f, compose);
    const o = await new Deno.Command(shell, { args: ["-NoProfile", "-File", path(RUNNER), "-ChainOnly", "-ComposeFile", f] }).output();
    return { code: o.code, out: new TextDecoder().decode(o.stdout) + new TextDecoder().decode(o.stderr) };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
const staged = (out: string) => Number((out.match(/staged (\d+) migrations/) ?? [])[1] ?? -1);

Deno.test({
  name: "attempt 6 NM1: a commented-out initdb mount is not staged - the chain check fails on a compose whose 245 (or 240) mount is a YAML comment",
  ignore: !runnable,
  async fn() {
    const real = Deno.readTextFileSync(COMPOSE).replace(/\r\n/g, "\n");
    const lines = real.split("\n");
    const i245 = lines.findIndex((l) => l.includes(":/docker-entrypoint-initdb.d/245-init-research-credibility.sql"));
    const i240 = lines.findIndex((l) => l.includes(":/docker-entrypoint-initdb.d/240-init-references.sql"));
    assert(i245 > 0 && i240 > 0, "the compose mounts 240 and 245");
    const base = await chainOnly(real);
    assertEquals(base.code, 0, base.out);
    const n = staged(base.out);
    assert(n >= 30, base.out);
    const variant = (idx: number, f: (l: string) => string) => lines.map((l, k) => (k === idx ? f(l) : l)).join("\n");
    const cases: Array<[string, string, RegExp]> = [
      ["245 as '# - ...'", variant(i245, (l) => l.replace(/^(\s*)- /, "$1# - ")), /FAIL\s+the chain mounts 245-init-research-credibility\.sql/],
      ["245 as '#- ...'", variant(i245, (l) => l.replace(/^(\s*)- /, "$1#- ")), /FAIL\s+the chain mounts 245-init-research-credibility\.sql/],
      ["240 as '# - ...'", variant(i240, (l) => l.replace(/^(\s*)- /, "$1# - ")), /FAIL\s+initdb runs 240-init-references\.sql before 245/],
    ];
    for (const [name, text, fail] of cases) {
      const r = await chainOnly(text);
      assert(r.code !== 0, `${name}: exit ${r.code}\n${r.out}`);
      assertEquals(staged(r.out), n - 1, `${name}: staged`);
      assert(fail.test(r.out), `${name}: ${r.out}`);
    }
    // a mount spelled after a ' #' on a line is a comment too: nothing extra is staged
    const trailing = variant(i245, (l) => `${l}  # - ./init-claims.sql:/docker-entrypoint-initdb.d/999-commented.sql:ro`);
    const t = await chainOnly(trailing);
    assertEquals([t.code, staged(t.out)], [0, n], t.out);
  },
});
