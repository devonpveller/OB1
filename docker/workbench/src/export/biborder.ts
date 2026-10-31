// The order a citation style lists the references in (rw-p6b-gate round 3, tester t-p6b-gate2 D10).
//
// A numeric style (IEEE, Vancouver) lists the references in citation order, under the numbers the export
// gives them. An author-date style (APA) SORTS its bibliography (author, date, title - whatever the style's
// <bibliography><sort> says), so its order is citeproc's to decide, not ours. Rather than re-implement
// CSL sorting, this asks the same program the export uses: pandoc --citeproc over the same CSL-JSON items
// and the same verified style, every item uncited-but-listed (nocite @*), written as HTML - and reads the
// order of the `ref-<key>` entries it printed. pandoc runs as a SEPARATE PROCESS over files (D9), with a
// clean environment and a wall clock, exactly as for the export; nothing is read back into pandoc.
import { renderSafeCsl } from "./csl.ts";
import { type RefItem, type StyleDef, verifiedStyle } from "./render.ts";

export async function bibliographyOrder(refs: RefItem[], style: StyleDef, cslDir: string, timeoutMs = 30_000): Promise<RefItem[]> {
  if (refs.length < 2) return refs;
  const dir = await Deno.makeTempDir({ prefix: "ob-biborder-" });
  try {
    await Deno.writeFile(`${dir}/${style.file}`, await verifiedStyle(cslDir, style));
    await Deno.writeTextFile(`${dir}/references.json`, JSON.stringify(refs.map((r) => ({ ...renderSafeCsl(r.csl), id: r.key }))));
    await Deno.writeTextFile(`${dir}/in.md`, "---\nnocite: |\n  @*\n---\n");
    const child = new Deno.Command("pandoc", {
      args: ["+RTS", "-N1", "-M1g", "-RTS", "--from", "markdown", "--to", "html", "--citeproc", "--csl", `${dir}/${style.file}`,
        "--bibliography", `${dir}/references.json`, "--output", `${dir}/out.html`, `${dir}/in.md`],
      cwd: dir, clearEnv: true, env: { PATH: Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8" },
      stdin: "null", stdout: "null", stderr: "piped",
    }).spawn();
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    const { code } = await child.output().finally(() => clearTimeout(timer));
    if (code !== 0) throw new Error("pandoc could not order the bibliography");
    const html = await Deno.readTextFile(`${dir}/out.html`);
    const byKey = new Map(refs.map((r) => [r.key, r]));
    const order: RefItem[] = [];
    for (const m of html.matchAll(/id="ref-([^"]+)"/g)) {
      const r = byKey.get(m[1]);
      if (r && !order.includes(r)) order.push(r);
    }
    // anything citeproc did not list (it lists every nocite item) keeps its place at the end
    for (const r of refs) if (!order.includes(r)) order.push(r);
    return order;
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}
