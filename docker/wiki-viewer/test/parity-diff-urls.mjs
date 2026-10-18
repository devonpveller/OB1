/**
 * The fixed 20-URL list of rw-p1a-render acceptance 1/2/6 (every page class
 * at least once). Shared by parity-diff.mjs and outage-probe.mjs.
 */
// The fixed 20-URL list (every page class at least once).
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
];
