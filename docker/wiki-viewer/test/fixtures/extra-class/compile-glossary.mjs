#!/usr/bin/env node
// rw-p1a-render acceptance 10, compile half: register ONE compile rule for
// the new class, compile a glossary page (file + row, the D13 way), then run
// the reconciliation with the class registered. No existing entry is edited.
import { mkdirSync, writeFileSync } from "node:fs";
import { registerCompileClass } from "/ob1/recipes/_shared/page-classes.mjs";
import { queueWikiPage, finishWikiPages } from "/ob1/recipes/_shared/wiki-pages.mjs";
import { reconcile, formatReport } from "/ob1/recipes/_shared/reconcile-wiki-pages.mjs";

if (process.env.P1A_DISPOSABLE !== "wt-rw-p1a-render") { console.error("refusing: not the disposable env"); process.exit(2); }
registerCompileClass({ name: "glossary", version: 1, pageClass: "glossary", priority: 50, match: (_s, p) => p[0] === "content" && p[1] === "glossary" });
const md = "---\ntitle: \"Fixture Term\"\ntags: [glossary]\n---\n# Fixture Term\n\nA term that links [[content/person/person-ada-fixture|Ada Fixture]].\n";
mkdirSync("/wiki/content/glossary", { recursive: true });
writeFileSync("/wiki/content/glossary/term-fixture.md", md);
const row = queueWikiPage("/wiki/content/glossary/term-fixture.md", md);
console.log(`[glossary] row page_class=${row.page_class}`);
const code = await finishWikiPages("glossary-compile");
const r = await reconcile({ vault: "/wiki" });
console.log(formatReport(r));
process.exitCode = code || (r.byClass.glossary && r.byClass.glossary.files === 1 && r.byClass.glossary.rows === 1 ? 0 : 1);
