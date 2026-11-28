// The viewer's body caps (wiki-viewer/lib/workbench-proxy.mjs bodyCap), mirrored for the tests: the lab image has no wiki-viewer to
// import from. body_limit_test.ts reads workbench-proxy.mjs as text and fails if these, or its upload list, drift.
export const VIEWER_CAP = 1024 * 1024; // any body: 1 MB
export const VIEWER_UPLOAD_CAP = 100 * 1024 * 1024; // its three upload paths: 100 MB
