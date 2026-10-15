/**
 * kp-contract: the URL normaliser is the SAME implementation as agent-bridge's
 * hardened one (knowledge_package.normalise_url, kp-research..kp-harden), and the
 * contract decides on it.
 *
 * fixtures/url-normalise-corpus.json holds every URL-shaped input of the
 * kp-research / kp-harden testers' probes (session scratchpad kpr2..kpr5,
 * kph-acc, kph_*.py) plus a deterministic replay of their WHATWG bypass fuzz
 * (kpr5/fuzz_whatwg.py, seed 5), each with the Python oracle's verdict. The
 * oracle has the text filters that are not URL normalisation switched off
 * (directive regex, secret-parameter regex, the package's 160-char cap - see the
 * generator header). No network: `deno test --deny-net urlnorm.test.ts`.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normaliseUrl, removeDotSegments, decodeUnreserved } from "./urlnorm.ts";
import { permitsUrl, resolveContract } from "./contract.ts";

interface Row { url: string; from: string; norm: [string, string[]] | null; admit: boolean }
const corpus = JSON.parse(
  Deno.readTextFileSync(new URL("./fixtures/url-normalise-corpus.json", import.meta.url)),
) as { entries: string[]; rows: Row[] };

Deno.test("corpus: normaliseUrl agrees with the agent-bridge normaliser on every tester probe", () => {
  assert(corpus.rows.length > 3000, `corpus too small: ${corpus.rows.length}`);
  const bad: string[] = [];
  for (const r of corpus.rows) {
    const got = normaliseUrl(r.url);
    const want = r.norm ? { host: r.norm[0], segs: r.norm[1] } : null;
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      bad.push(`${JSON.stringify(r.url)} [${r.from}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
    }
  }
  assertEquals(bad.length, 0, bad.slice(0, 20).join("\n"));
});

Deno.test("corpus: the contract admits exactly what the oracle admits (software-docs + per-task entries)", () => {
  const sw = resolveContract({ contract: { sources: { classes: ["software-docs"] } } })!;
  const extra = corpus.entries.slice(sw.allowDomains.length);
  const c = resolveContract({ contract: { sources: { classes: ["software-docs"], allow: extra } } })!;
  assertEquals([...c.allowDomains].sort(), [...corpus.entries].sort());
  const bad: string[] = [];
  let admitted = 0;
  for (const r of corpus.rows) {
    const got = permitsUrl(c, r.url);
    if (got) admitted++;
    if (got !== r.admit) bad.push(`${JSON.stringify(r.url)} got=${got} want=${r.admit}`);
  }
  assertEquals(bad.length, 0, bad.slice(0, 20).join("\n"));
  assert(admitted > 100, `too few admitted rows to mean anything: ${admitted}`);
});

Deno.test("normaliser: host case, trailing root dot, unreserved escapes, empty port", () => {
  assertEquals(normaliseUrl("https://DOCS.Python.ORG./3/%7Euser/x"), { host: "docs.python.org", segs: ["3", "~user", "x"] });
  assertEquals(normaliseUrl("https://docs.python.org:/3/"), { host: "docs.python.org", segs: ["3", ""] });
  assertEquals(normaliseUrl("https://docs.python.org"), { host: "docs.python.org", segs: [""] });
  assertEquals(normaliseUrl("http://docs.python.org/a%3Ab"), { host: "docs.python.org", segs: ["a%3Ab"] });
  assertEquals(normaliseUrl("https://docs.python.org/a%3ab"), { host: "docs.python.org", segs: ["a%3Ab"] });
});

Deno.test("normaliser: refuses every hidden-segment, host and encoding trick", () => {
  for (const u of [
    "https://docs.python.org/3/../x", "https://docs.python.org/3/./x", "https://docs.python.org/3/.../x",
    "https://docs.python.org/3/%2e%2e/x", "https://docs.python.org/3/%2E./x", "https://docs.python.org/3%2fx",
    "https://docs.python.org/3%5cx", "https://docs.python.org/3\\x", "https://docs.python.org/3/..;/x",
    "https://docs.python.org/3/%252e%252e/x", "https://docs.python.org/3/%c0%ae%c0%ae/x",
    "https://docs.python.org/3/%e0%80%ae/x", "https://docs.python.org/3/%f0%80%80%ae/x",
    "https://docs.python.org/3/%ed%a0%80/x", "https://docs.python.org/3/%e2%80%a5/x",
    "https://docs.python.org/3/%ef%bc%8f/x", "https://docs.python.org/3/%e3%80%82/x",
    "https://docs.python.org/3/%00x", "https://docs.python.org/3/%09x", "https://docs.python.org/3/%20x",
    "https://docs.python.org/3/%u002e", "https://docs.python.org/3/%",
    "https://docs.python.org/3/é", "https://docs.python.org/3/\t../x", " https://docs.python.org/3/",
    "https://docs.python.org:443/3/", "https://u:p@docs.python.org/3/", "https://docs.python.org@evil.com/3/",
    "https://127.0.0.1/3/", "https://[::1]/3/", "https://localhost/3/", "https://docs.internal/3/",
    "https://xn--dcs-python-xyz.org/3/", "https://docs.python.org../3/", "https://docs..python.org/3/",
    "https://docs.python.123/3/", "HTTPS://docs.python.org/3/", "https:/docs.python.org/3/",
    "https:docs.python.org/3/", "//docs.python.org/3/", "https://docs.python.org/3/data:x",
  ]) assertEquals(normaliseUrl(u), null, u);
});

Deno.test("RFC 3986 helpers match the reference algorithm", () => {
  assertEquals(removeDotSegments("/a/b/c/./../../g"), "/a/g");
  assertEquals(removeDotSegments("mid/content=5/../6"), "mid/6");
  assertEquals(removeDotSegments("/../a"), "/a");
  assertEquals(decodeUnreserved("/%41%2d%2F%7e%c3%a9"), "/A-%2F~%C3%A9");
});
