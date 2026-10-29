// research-workbench P2b: the user document grammar (pure; the image build test gate runs it).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  breakTransclusion, chipText, parseDocument, referenceIdsOf, setFrontmatterField, transclusionText,
} from "./grammar.ts";
import { clusterSeeds } from "./hub.ts";
import { docRel, inSubtree, isTrashed, liveRel } from "./paths.ts";
import { identityConfig, ownerKey, resolveIdentity } from "../middleware/identity.ts";

const R1 = "a1000000-0000-4000-8000-000000000001";
const R2 = "a1000000-0000-4000-8000-000000000002";
const S1 = "b1000000-0000-4000-8000-000000000001";

const DOC = `---
title: "Writing about contracts"
idea: "a workspace that pins what it quotes"
tags: [draft]
---

# Writing

See [[content/tool/tool-fixture|the tool]] and [[source:${S1}|a source]] and [[claim:${S1}]].
A chip [@ref:${R1}] and a transclusion:

{{ref:${R2}}}quoted text with [[content/person/not-a-link]] inside{{/ref}}
`;

Deno.test("C12/C13: links are typed ids; a transclusion's quoted text is not the document's links", () => {
  const d = parseDocument(DOC, "documents/w.md");
  assertEquals(d.title, "Writing about contracts");
  assertEquals(d.idea, "a workspace that pins what it quotes");
  assertEquals(d.links.map((l) => [l.kind, l.id]), [["page", "content/tool/tool-fixture"], ["source", S1], ["claim", S1]]);
  assertEquals(d.chips.map((c) => c.reference_id), [R1]);
  assertEquals(d.transclusions.map((t) => [t.reference_id, t.text]), [[R2, "quoted text with [[content/person/not-a-link]] inside"]]);
  assertEquals(referenceIdsOf(d), [R1, R2]);
});

Deno.test("C2: the deliberate break leaves the text and a chip naming THE SAME record", () => {
  const d = parseDocument(DOC);
  const out = breakTransclusion(DOC, d.transclusions[0]);
  const after = parseDocument(out);
  assertEquals(after.transclusions.length, 0);
  assertEquals(after.chips.map((c) => c.reference_id), [R1, R2]);
  assert(out.includes(`quoted text with [[content/person/not-a-link]] inside [@ref:${R2}]`));
});

Deno.test("transclusion text cannot close itself early", () => {
  const t = transclusionText(R1, "a {{/ref}} b");
  const d = parseDocument(t);
  assertEquals(d.transclusions.length, 1);
  assertEquals(d.transclusions[0].to, t.length);
  assertEquals(chipText(R1), `[@ref:${R1}]`);
});

Deno.test("C12 (properties): a frontmatter field is set and every other line kept verbatim", () => {
  const out = setFrontmatterField(DOC, "idea", "changed");
  assert(out.includes('tags: [draft]'));
  assert(out.includes('idea: "changed"'));
  assertEquals(out.slice(out.indexOf("# Writing")), DOC.slice(DOC.indexOf("# Writing")));
  const none = setFrontmatterField("# T\n", "idea", "x");
  assertEquals(parseDocument(none).idea, "x");
});

Deno.test("title falls back to the first heading, then the file name", () => {
  assertEquals(parseDocument("# Head\n\nbody", "documents/x.md").title, "Head");
  assertEquals(parseDocument("body", "documents/some-name.md").title, "some-name");
});

Deno.test("paths: one directory per user; trash and archive by path; no escape", () => {
  const who = { sub: "operator", actor: "operator", name: "Operator", key: "operator" };
  assertEquals(docRel("a/b.md", who), "documents/operator/a/b.md");
  assertEquals(docRel("documents/operator/a/b.md", who), "documents/operator/a/b.md");
  assertEquals(inSubtree("documents/operator/a/b.md", ".trash", who), "documents/operator/.trash/a/b.md");
  assertEquals(liveRel("documents/operator/.archive/a/b.md"), "documents/operator/a/b.md");
  assertEquals(liveRel("documents/.trash/legacy.md"), "documents/legacy.md");
  assert(isTrashed("documents/operator/.trash/x.md") && !isTrashed("documents/operator/x.md"));
  let threw = false;
  try {
    docRel("../notes/x.md", who);
  } catch {
    threw = true;
  }
  assert(threw, "traversal refused");
});

Deno.test("the identity seam: the default identity until sign-on; a configured header names the subject; subject == actor", async () => {
  const cfg = identityConfig(() => undefined);
  const d = await resolveIdentity(() => undefined, cfg);
  assertEquals([d.sub, d.actor, d.name, d.key], ["operator", "operator", "Operator", "operator"]);
  const on = identityConfig((k) => ({ WORKSPACE_IDENTITY_HEADER: "X-Test-Sub" } as Record<string, string>)[k]);
  const b = await resolveIdentity((h) => (h === "X-Test-Sub" ? "ak-subject-0f9e" : undefined), on);
  assertEquals([b.sub, b.actor, b.key], ["ak-subject-0f9e", "ak-subject-0f9e", "ak-subject-0f9e"]);
  // an opaque subject that is not a safe directory name gets a stable hashed key
  const odd = await resolveIdentity(() => "a/b c", on);
  assertEquals(odd.sub, "a/b c");
  assert(/^h-[0-9a-f]{32}$/.test(odd.key) && odd.key === (await ownerKey("a/b c")));
  // the header is ignored while the seam is off
  assertEquals((await resolveIdentity(() => "someone", cfg)).sub, "operator");
});

Deno.test("C15/C16: hubs are computed - the shared neighbour is the centre; an isolated seed is its own", () => {
  const n = (seed: string, slug: string, deg: number) => ({ seed, slug, title: slug, page_class: "entity", in_degree: deg });
  const hubs = clusterSeeds(["s/a", "s/b", "s/c"], [
    n("s/a", "e/topic", 5), n("s/b", "e/topic", 5), n("s/a", "e/other", 9), n("s/c", "e/lonely", 1),
  ]);
  assertEquals(hubs.map((h) => [h.centre.slug, h.seeds]), [["e/topic", ["s/a", "s/b"]], ["e/lonely", ["s/c"]]]);
  const alone = clusterSeeds(["s/x"], []);
  assertEquals(alone.map((h) => [h.centre.slug, h.seeds]), [["s/x", ["s/x"]]]);
});
