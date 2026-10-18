// The export's about text (research-workbench P6a, acceptance 7): the CSL project with its link,
// every style with its own author and contributor listing, and the separate programs the export
// runs with their licences - pandoc with its GPL-2.0-or-later source offer.
import type { RegistryEntry } from "../contracts/registry.ts";

export const CSL_PROJECT = {
  name: "Citation Style Language (CSL) project",
  url: "https://citationstyles.org/",
  styles_repository: "https://github.com/citation-style-language/styles",
  licence: "CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0/)",
};

export const PANDOC_SOURCE_OFFER =
  "pandoc is free software under the GNU General Public License, version 2 or later. The export runs " +
  "the unmodified upstream pandoc binary as a separate program; it is not part of this product and is " +
  "not linked to it. Its complete corresponding source code is published at " +
  "https://github.com/jgm/pandoc/archive/refs/tags/{version}.tar.gz (and on Hackage as pandoc-{version}). " +
  "Whoever distributes an image carrying this binary offers, for at least three years from that " +
  "distribution, to give anyone a copy of that source on a medium customarily used for software " +
  "interchange, for no more than the cost of performing the copy.";

export function aboutExport(styles: RegistryEntry[], formats: RegistryEntry[], env: (k: string) => string | undefined = (k) => Deno.env.get(k)) {
  const pandoc = env("EXPORT_PANDOC_VERSION") ?? "unknown";
  const typst = env("EXPORT_TYPST_VERSION") ?? "unknown";
  const live = (e: RegistryEntry) => !e.retired_at;
  return {
    text: "Citations and reference lists are formatted by citeproc, inside pandoc, with citation styles " +
      `from the ${CSL_PROJECT.name} (${CSL_PROJECT.url}). The styles are used unmodified under ` +
      `${CSL_PROJECT.licence}, each with its author and contributor listing as published. Reference ` +
      "metadata comes from OpenAlex (keyed) and Crossref (polite pool), by persistent identifier.",
    csl_project: CSL_PROJECT,
    styles: styles.filter(live).map((e) => ({
      key: e.key, title: e.label, citation_format: e.definition.citation_format, default: e.definition.default === true,
      authors: e.definition.authors, contributors: e.definition.contributors, licence: e.definition.licence,
      upstream: e.definition.upstream, sha256: e.definition.sha256,
    })),
    formats: formats.filter(live).map((e) => ({ key: e.key, label: e.label, ext: e.definition.ext })),
    programs: [
      {
        name: "pandoc", version: pandoc, licence: "GPL-2.0-or-later", use: "separate process (markdown in, document out)",
        url: "https://pandoc.org", source_offer: PANDOC_SOURCE_OFFER.replaceAll("{version}", pandoc),
      },
      { name: "Typst", version: typst, licence: "Apache-2.0", use: "pandoc's PDF engine, a separate process", url: "https://typst.app" },
    ],
  };
}
