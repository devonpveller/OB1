/**
 * wiki-db - the viewer's ONE door to wiki_pages (PostgREST, openbrain-rest),
 * with the connection state D13 makes a front-end condition.
 *
 * D13 (research-workbench, operator 2026-09-23/25): the row is what is
 * presented. So a DB problem is never folded into "no row" (the old
 * fetchWikiPage returned null on any error, behind a 10 s negative cache, and
 * the caller fell through to a file render - the "empty or file-rendered
 * leaf" D13 retires). Every read here returns a TYPED result:
 *   { ok: true, row }          the row (or row: null = there is no row)
 *   { ok: false, state }       the database is not answering; state is
 *                              "connecting" or "unreachable" (see below)
 *
 * Connection state (one per process, driven by a background probe AND by
 * every real read). PostgREST answers the SAME way (503 PGRST002 "Retrying")
 * whether Postgres is stopped or still starting, so the viewer asks the
 * network itself: a TCP connect to the database (WIKI_DB_TCP, default
 * openbrain-db:5432).
 *   connecting   - the database host accepts connections but the API does not
 *                  answer yet (Postgres starting, PostgREST reconnecting /
 *                  loading its schema cache); or Postgres said 57P03
 *                  "starting up"; or, whatever the TCP answer, an outage
 *                  younger than WIKI_DB_CONNECT_GRACE_MS (incl. process start)
 *   unreachable  - the database host does not accept connections (stopped,
 *                  network failed) for longer than the grace window
 *   up           - the last probe/read succeeded
 * Transitions to `up` fire the registered onConnect hooks (the reconcile
 * repair pass, D13 item 4) - on the first connect and on every reconnect.
 */
import { connect } from "node:net";

const OB_URL = () => (process.env.OPEN_BRAIN_URL || "http://openbrain-rest").replace(/\/+$/, "");
const TIMEOUT_MS = () => Math.max(500, Number(process.env.WIKI_DB_RENDER_TIMEOUT_MS || "3000"));
const GRACE_MS = () => Math.max(0, Number(process.env.WIKI_DB_CONNECT_GRACE_MS || "15000"));
const PROBE_MS = () => Math.max(250, Number(process.env.WIKI_DB_PROBE_MS || "5000"));
const DB_TCP = () => String(process.env.WIKI_DB_TCP || "openbrain-db:5432");


// Does the database host accept a TCP connection right now? (1 s bound)
export function tcpReachable(target = DB_TCP()) {
  const i = target.lastIndexOf(":");
  const host = target.slice(0, i);
  const port = Number(target.slice(i + 1));
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(1000, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

const SELECT_FULL = "slug,title,body,page_class,entity_type,tags,links,updated_at,frontmatter";
// A database migrated before the frontmatter column (init-wiki-pages.sql) still
// answers with the narrower projection; the column then reads as {}.
const SELECT_NARROW = "slug,title,body,page_class,entity_type,tags,links,updated_at";
let _select = SELECT_FULL;

const _state = {
  state: "connecting",
  since: Date.now(),      // when the current state began
  failingSince: null,     // first failure of the current outage
  lastOkAt: null,
  lastError: null,
  everUp: false,
};
const _onConnect = [];
let _probeTimer = null;

export function dbState() {
  return { ..._state };
}

export function onConnect(fn) {
  _onConnect.push(fn);
}

function setState(next, err) {
  const prev = _state.state;
  if (next === "up") {
    _state.lastOkAt = Date.now();
    _state.failingSince = null;
    _state.lastError = null;
  } else {
    _state.lastError = err ? String(err).slice(0, 300) : _state.lastError;
  }
  if (prev !== next) {
    _state.state = next;
    _state.since = Date.now();
    console.log(`[wiki-viewer] database ${prev} -> ${next}${err ? ` (${String(err).slice(0, 160)})` : ""}`);
    if (next === "up") {
      const reason = _state.everUp ? "reconnect" : "connect";
      _state.everUp = true;
      for (const fn of _onConnect) {
        Promise.resolve().then(() => fn(reason)).catch((e) =>
          console.error(`[wiki-viewer] onConnect hook failed: ${e?.message || e}`));
      }
    }
  }
}

// Classify a failure into the state the front end shows.
async function failed(err, startingUp) {
  const now = Date.now();
  if (_state.failingSince == null) _state.failingSince = now;
  if (startingUp) return setState("connecting", err);
  if (now - _state.failingSince < GRACE_MS()) return setState("connecting", err);
  const hostUp = await tcpReachable();
  setState(hostUp ? "connecting" : "unreachable", `${err}; database host ${hostUp ? "accepts" : "refuses"} TCP (${DB_TCP()})`);
}

const STARTING_RE = /starting up|57P03|not yet accepting/i;

// One PostgREST GET. Returns { ok:true, json } or { ok:false, error, startingUp }.
async function restGet(pathq) {
  let r;
  try {
    r = await fetch(`${OB_URL()}/rest/v1/${pathq}`, {
      headers: { apikey: "local-trust" },
      signal: AbortSignal.timeout(TIMEOUT_MS()),
    });
  } catch (e) {
    return { ok: false, error: e?.cause?.code || e?.message || String(e), startingUp: false };
  }
  if (r.ok) {
    try {
      return { ok: true, json: await r.json() };
    } catch (e) {
      return { ok: false, error: `bad json: ${e?.message}`, startingUp: false };
    }
  }
  const text = await r.text().catch(() => "");
  return { ok: false, status: r.status, error: `${r.status} ${text.slice(0, 200)}`, startingUp: STARTING_RE.test(text) };
}

// Probe: cheap, touches the real table (so a missing table is a failure too).
export async function probe() {
  const res = await restGet("wiki_pages?select=slug&limit=1");
  if (res.ok) setState("up");
  else await failed(res.error, res.startingUp);
  return dbState();
}

export function startProbe() {
  if (_probeTimer) return;
  const tick = async () => {
    try { await probe(); } finally { _probeTimer = setTimeout(tick, PROBE_MS()); }
  };
  _probeTimer = setTimeout(tick, 0);
  _probeTimer.unref?.();
}

export function stopProbe() {
  clearTimeout(_probeTimer);
  _probeTimer = null;
}

// The state the front end shows when a read fails right now.
function down() {
  return { ok: false, state: _state.state === "up" ? "connecting" : _state.state };
}

async function selectRows(filter, limit) {
  let res = await restGet(`wiki_pages?${filter}&select=${_select}&limit=${limit}`);
  if (!res.ok && res.status === 400 && _select === SELECT_FULL && /frontmatter/.test(res.error)) {
    console.warn("[wiki-viewer] wiki_pages has no frontmatter column yet (apply init-wiki-pages.sql); reading without it");
    _select = SELECT_NARROW;
    res = await restGet(`wiki_pages?${filter}&select=${_select}&limit=${limit}`);
  }
  return res;
}

function normalizeRow(row) {
  if (!row) return null;
  const fm = row.frontmatter && typeof row.frontmatter === "object" && !Array.isArray(row.frontmatter)
    ? row.frontmatter : {};
  return { ...row, frontmatter: fm, tags: Array.isArray(row.tags) ? row.tags : [], links: Array.isArray(row.links) ? row.links : [] };
}

/**
 * The row for an exact slug. { ok:true, row|null } or { ok:false, state }.
 * No negative cache: a missing row is a STATE (pending-compile), and caching
 * "missing" is how a stale miss pins itself over a page that just landed.
 */
export async function fetchRow(slug) {
  if (!slug) return { ok: true, row: null };
  const res = await selectRows(`slug=eq.${encodeURIComponent(slug)}`, 1);
  if (!res.ok) { await failed(res.error, res.startingUp); return down(); }
  setState("up");
  return { ok: true, row: normalizeRow(Array.isArray(res.json) ? res.json[0] : null) };
}

/** Basename form ("person-x") - Quartz emits basename URLs for unresolved links. */
export async function fetchRowByBasename(base) {
  if (!base || base.includes("/")) return { ok: true, row: null };
  const res = await selectRows(`slug=like.*%2F${encodeURIComponent(base)}`, 2);
  if (!res.ok) { await failed(res.error, res.startingUp); return down(); }
  setState("up");
  const rows = Array.isArray(res.json) ? res.json : [];
  return { ok: true, row: rows.length === 1 ? normalizeRow(rows[0]) : null };
}

// Test seam.
export function _resetForTests() {
  Object.assign(_state, { state: "connecting", since: Date.now(), failingSince: null, lastOkAt: null, lastError: null, everUp: false });
  _onConnect.length = 0;
  _select = SELECT_FULL;
}
