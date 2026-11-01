/** rw-p5a-intake: the `academic` contract class reaches the scholarly indexes.
 *
 *  - the class names the PubMed / NCBI domains (`contract.ts` lacked them while `filtering.ts`
 *    already ranked them academic), so a PubMed hit survives the class's allow-list;
 *  - the class routes the job's searches to SearXNG's science category: `withContract` hands the
 *    category to `searchWeb`, which sends `categories=` to the search gateway.
 *  Run: deno test academic-route.test.ts */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { permitsUrl, resolveContract, newContractDrops } from "./contract.ts";
import { withContract, type Deps } from "./harness.ts";
import { searchUrl } from "./lib.ts";

const PUBMED = "https://www.ncbi.nlm.nih.gov/pubmed/40128952";

Deno.test("academic class admits the PubMed source the 2026-09-11 audit missed", () => {
  const rc = resolveContract({ contract: { sources: { classes: ["academic"] } } })!;
  assertEquals(permitsUrl(rc, PUBMED), true);
  assertEquals(permitsUrl(rc, "https://pubmed.ncbi.nlm.nih.gov/40128952/"), true);
  assertEquals(permitsUrl(rc, "https://pubmed.gov/40128952"), true);
  // the allow-list still refuses a general page
  assertEquals(permitsUrl(rc, "https://www.merriam-webster.com/dictionary/clinical"), false);
});

Deno.test("academic class routes the search to the science category; no class sends none", () => {
  assertEquals(resolveContract({ contract: { sources: { classes: ["academic"] } } })!.searchCategories, ["general", "science"]);
  assertEquals(resolveContract({ contract: { sources: { classes: ["advisories"] } } })!.searchCategories, undefined);
  assertEquals(resolveContract({ contract: { budget: { rounds: 1 } } })!.searchCategories, undefined);
});

Deno.test("withContract hands the class's categories to searchWeb and keeps the PubMed hit", async () => {
  const rc = resolveContract({ contract: { sources: { classes: ["academic"] } } })!;
  const seen: unknown[] = [];
  const deps = {
    searchWeb: (q: string, k: number, opts?: { categories?: string[] }) => {
      seen.push({ q, k, categories: opts?.categories });
      return Promise.resolve([
        { url: PUBMED, title: "Just 1-min exposure to a pure tone at 100 Hz", snippet: "motion sickness" },
        { url: "https://www.merriam-webster.com/dictionary/clinical", title: "Clinical", snippet: "dictionary" },
      ]);
    },
    fetchPage: () => Promise.resolve({ page: null, outcome: "error" as const }),
  } as unknown as Deps;
  const drops = newContractDrops();
  const hits = await withContract(deps, rc, drops).searchWeb("clinical trial 100 Hz tone VR motion sickness reduction study", 8);
  assertEquals(seen, [{ q: "clinical trial 100 Hz tone VR motion sickness reduction study", k: 8, categories: ["general", "science"] }]);
  assertEquals(hits.map((h) => h.url), [PUBMED]);
});

Deno.test("searchUrl sends categories only when asked", () => {
  assertEquals(searchUrl("http://gateway:8080", "a b", undefined), "http://gateway:8080/search?q=a%20b&format=json");
  assertEquals(searchUrl("http://gateway:8080", "a b", ["general", "science"]),
    "http://gateway:8080/search?q=a%20b&format=json&categories=general%2Cscience");
});
