/**
 * The fixed URL list of rw-p1a-render acceptance 1/2/6 (every page class at
 * least once): the anchor's 20, 7 added in attempt 2, 7 in attempt 3. Shared by
 * parity-diff.mjs and outage-probe.mjs.
 */
export const URLS = [
  ["entity", "/content/person/person-ada-fixture"],
  ["entity", "/content/person/person-bob-fixture"],
  ["entity", "/content/tool/tool-fixture-db"],
  ["source leaf", "/content/source/00000000-0000-4000-8000-000000000001"],
  ["source leaf", "/content/source/00000000-0000-4000-8000-000000000002"],
  ["research report", "/content/source/00000000-0000-4000-8000-000000000101"],
  ["research report", "/content/source/00000000-0000-4000-8000-000000000102"],
  ["thought", "/content/thought/9001"],
  ["thought", "/content/thought/9002"],
  ["notebook hub", "/content/notebooks/fixture-notebook/fixture-notebook"],
  ["notebook hub", "/content/notebooks/second-notebook/second-notebook"],
  ["notebooks index", "/content/notebooks/"],
  ["legacy user note", "/notes/fixture-note"],
  ["legacy user note", "/notes/fixture-folder/nested-note"],
  ["folder index", "/content/person/"],
  ["folder index", "/notes/fixture-folder/"],
  ["tag page", "/tags/fixture-tag"],
  ["tag page", "/tags/leaf"],
  ["retired slug", "/content/topic/fixture-retired-topic"],
  ["root", "/"],
  // rw-p1a-render attempt 2: the tester's extra URLs (A1), so the list covers
  // the tag index, a second tag page, and every folder-index shape - incl. a
  // folder whose SUBFOLDER entry carries tags (/content/: the notebooks
  // folder's index page has tags).
  ["tag page", "/tags/"],
  ["tag page", "/tags/notebook"],
  ["folder index", "/content/source/"],
  ["folder index", "/content/"],
  ["folder index", "/notes/"],
  ["folder index", "/content/notebooks/fixture-notebook/"],
  ["folder index", "/content/thought/"],
  // rw-p1a-render attempt 3: the attempt-2 tester's parity hunt (AT2-1) - a
  // kitchen-sink note (footnotes, callouts, math, mermaid, a table, task
  // lists, a ![[note]] transclusion, a link to its own heading -> the page is
  // its own backlink), the tester's frontmatter-only note, a page with every
  // transclusion shape (heading section with a nested transclusion inside it,
  // block, list-item block, unknown page), the page those blocks come from,
  // and three Quartz alias redirect pages (whole document compared).
  ["legacy user note", "/notes/kitchen-sink"],
  ["legacy user note", "/notes/empty-body-note"],
  ["legacy user note", "/notes/transclude-fixture"],
  ["legacy user note", "/notes/block-source"],
  ["alias redirect", "/old-kitchen-sink"],
  ["alias redirect", "/Ada-Fixture"],
  ["alias redirect", "/Second-Notebook"],
];
