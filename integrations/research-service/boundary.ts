/**
 * THE REQUEST BOUNDARY (research-workbench rw-boundary-core, plan 09 sections 2-5, PD0a; operator 2026-11-04,
 * "PD0: approved", defaults D1-D12). Research formed from personal data reaches the shared store only as a
 * de-personalised request: `formDerivedRequest` forms it, `insertDerivedJob` writes it (the ONLY writer of
 * research_jobs.request_kind = 'derived'; slot 420's guard refuses a derived job that carries anything personal),
 * and the private hand-back (research_handbacks, owner-only) ties it to its owner.
 *
 * What a derived request carries (and nothing else): a question and a topic made of allow-listed tokens
 * (boundary-gate.ts), canonical public links each fetched anonymously with success, and the boundary stamp. Never
 * a field of the item, the owner, the inlet id or revision, a callback, a thread root or seed content: the
 * research service fetches the public links itself when it runs the job.
 *
 * The model only PROPOSES (deps.propose: the local model through the research service's LiteLLM key, tagged
 * `request-boundary`, D9); the pure gate DECIDES; the title template is the fallback. A refusal starts no job.
 */
import {
  BOUNDARY_VERSION, canonicalLink, cleanText, deniedIndices, denySet, type Evidence, gate, type GateCode, lexicon, type Lexicon,
  linkPathRefusal, type PublicPage, templateQuestion, tokens, topicOf,
} from "./boundary-gate.ts";
import { judgeAddresses } from "./intake-fetch.ts";

export type InletKind = "idea" | "gmail" | "google_activity" | "brainstorm" | "document" | "chat";
export type Purpose = "idea-research" | "digest-article" | "digest-gap" | "brainstorm-gap";
export const INLET_KINDS: ReadonlySet<string> = new Set(["idea", "gmail", "google_activity", "brainstorm", "document", "chat"]);
export const PURPOSES: ReadonlySet<string> = new Set(["idea-research", "digest-article", "digest-gap", "brainstorm-gap"]);

export interface PersonalItem {
  kind: InletKind;
  id: string;                       // the private id (idea id, gmail id, MM post id) - hand-back only
  revision?: number;
  owner_sub: string;                // never 'service:*', never blank
  fields: Record<string, string>;   // the personal text - transient, never stored by this module
  links: string[];                  // URLs found in the item - candidates for public links
  identity?: string[];              // extra identity strings the caller knows (a Mattermost username)
}

export interface DerivedRequest {
  question: string;                 // <= 300 chars
  topic: string;                    // <= 80 chars
  links: string[];                  // canonical, anonymously fetched, public
  purpose: Purpose;
  // round 2 (TF4): the evidence snapshot rides on the stamp - the run-time fetch uses a page only if its hash matches
  boundary: { version: string; lexicon: string; verdict_id: string; evidence: Array<{ url: string; sha256: string }> };
}

export type Refusal = "no_owner" | "no_public_evidence" | "no_candidate_passed" | "identity_token" | "link_not_public" | "empty";

/** The gate record: hashes and codes only, never the personal text (it is what the hand-back's `verdict` holds). */
export interface GateRecord {
  boundary_version: string;
  lexicon_version: string;
  purpose: Purpose;
  accepted_by: "model" | "template" | null;
  candidate_sha256: string | null;
  evidence: Array<{ url: string; sha256: string }>;
  refusal: Refusal | null;
  tried: number;
  codes: Array<GateCode | "ok">;
  links_dropped: number;
}

export type BoundaryVerdict =
  | { ok: true; request: DerivedRequest; record: GateRecord; verdict_id: string }
  | { ok: false; refusal: Refusal; record: GateRecord; verdict_id: string; owner_view: OwnerView | null };

/** What only the owner sees on a refused idea (awaiting_owner, PD0b's review): the best candidate and its failing
 *  tokens. RLS-scoped to the owner in research_handbacks.owner_view; never in a shared row. */
export interface OwnerView { candidate: string; failing: string[]; code: GateCode | Refusal }

export interface BoundaryDeps {
  propose: (item: PersonalItem, evidence: Evidence) => Promise<string[]>;
  fetchPublic: (url: string) => Promise<{ title: string; text: string } | null>;
  identity: (owner_sub: string) => Promise<string[]>;
  /** round 2 (TF6): the host's addresses (A + AAAA); a link whose host resolves to any private, loopback, link-local or
   *  reserved address (or does not resolve) is refused before its fetch (intake-fetch.ts judgeAddresses). */
  resolve: (host: string) => Promise<string[]>;
  lexicon?: Lexicon;
}

export const MAX_LINKS = 5;
export const MAX_CANDIDATES = 3;

/** round 2 (TF6): every address the link's host resolves to is public (judgeAddresses: IPv4 private / loopback /
 *  link-local / CGNAT / reserved, IPv6 outside global unicast, an empty answer - all refused). */
export async function publicAddress(url: string, deps: Pick<BoundaryDeps, "resolve">): Promise<boolean> {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/\.+$/, ""); } catch { return false; }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return judgeAddresses(host, [host]).ok;
  const addrs = await deps.resolve(host).catch(() => [] as string[]);
  return judgeAddresses(host, addrs).ok;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Canonical JSON (keys sorted) - the verdict id is its sha256, so equal records have equal ids. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

const BAD_SUB = /^(service|system|anonymous):/i;

export async function formDerivedRequest(item: PersonalItem, purpose: Purpose, deps: BoundaryDeps): Promise<BoundaryVerdict> {
  const lex = deps.lexicon ?? lexicon();
  const record: GateRecord = {
    boundary_version: BOUNDARY_VERSION, lexicon_version: lex.version, purpose, accepted_by: null, candidate_sha256: null,
    evidence: [], refusal: null, tried: 0, codes: [], links_dropped: 0,
  };
  const refuse = async (refusal: Refusal, ownerView: OwnerView | null = null): Promise<BoundaryVerdict> => {
    record.refusal = refusal;
    return { ok: false, refusal, record, verdict_id: await sha256Hex(canonicalJson(record)), owner_view: ownerView };
  };
  const owner = String(item.owner_sub ?? "").trim();
  if (!owner || BAD_SUB.test(owner)) return refuse("no_owner");
  const fields = Object.fromEntries(Object.entries(item.fields ?? {}).map(([k, v]) => [k, String(v ?? "")]));
  const rawLinks = (item.links ?? []).map((l) => String(l ?? "")).filter(Boolean);
  if (!Object.values(fields).some((v) => v.trim()) && !rawLinks.length) return refuse("empty");

  // round 2 (TF3): the identity / id part of DENY is known before any link is judged - a link whose path carries one
  // is refused before its fetch (the link-token part of DENY needs the public set, so it comes after)
  const identity = [...(await deps.identity(owner).catch(() => [] as string[])), ...(item.identity ?? [])].map(String);
  const baseDeny = denySet({ ownerSub: owner, identity, fields, links: [], publicLinks: [], id: item.id });
  // the public links: canonical, not on the private-host list, a public address, no id or identity in the path,
  // fetched anonymously with success (a snapshot)
  const pages: PublicPage[] = [];
  const seen = new Set<string>();
  for (const l of rawLinks) {
    const c = canonicalLink(l);
    if (!("url" in c) || seen.has(c.url)) { if (!("url" in c)) record.links_dropped++; continue; }
    seen.add(c.url);
    if (pages.length >= MAX_LINKS || linkPathRefusal(c.url, baseDeny)) { record.links_dropped++; continue; }
    if (!(await publicAddress(c.url, deps))) { record.links_dropped++; continue; }
    const got = await deps.fetchPublic(c.url).catch(() => null);
    if (!got || !String(got.text ?? "").trim()) { record.links_dropped++; continue; }
    const title = String(got.title ?? ""), text = String(got.text ?? "");
    pages.push({ url: c.url, title, text, sha256: await sha256Hex(`${title}\n${text}`) });
  }
  record.evidence = pages.map((p) => ({ url: p.url, sha256: p.sha256 }));
  if (purpose === "digest-article" && !pages.length) return refuse(rawLinks.length ? "link_not_public" : "no_public_evidence");

  const deny = denySet({ ownerSub: owner, identity, fields, links: rawLinks, publicLinks: pages.map((p) => p.url), id: item.id });
  const ev: Evidence = { pages };
  const personal = Object.values(fields);

  // candidates: the model's (not for an article: the article is the subject, the template is the question), then
  // the template from each fetched page's title
  let proposed: string[] = [];
  if (purpose !== "digest-article") {
    proposed = (await deps.propose(item, ev).catch(() => [] as string[]))
      .filter((x) => typeof x === "string").slice(0, MAX_CANDIDATES);
  }
  const candidates: Array<{ q: string; topic: string | null; by: "model" | "template" }> = proposed.map((q) => ({ q, topic: null, by: "model" as const }));
  for (const p of pages) {
    const t = templateQuestion(p.title, deny);
    if (t) candidates.push({ q: t.question, topic: t.topic, by: "template" });
  }
  if (!candidates.length) return refuse(pages.length ? "no_candidate_passed" : "no_public_evidence");

  let best: OwnerView | null = null;
  for (const cand of candidates) {
    record.tried++;
    const g = gate(cleanText(cand.q).trim(), ev, deny, lex, personal);
    record.codes.push(g.ok ? "ok" : g.code);
    if (!g.ok) {
      if (!best && cand.by === "model") best = { candidate: cand.q.slice(0, 300), failing: g.tokens.slice(0, 20), code: g.code };
      continue;
    }
    // round 2 (TF1): the stored question IS the string the gate judged (cleanText: no invisible characters)
    const question = cleanText(cand.q).trim();
    const topic = (cand.topic ?? (pages[0] ? templateQuestion(pages[0].title, deny)?.topic : null) ?? topicOf(question)) || topicOf(question);
    // belt and braces (section 2.3, "an identity token present after the fallback"): neither string holds a DENY token
    if (deniedIndices(tokens(question), deny).size || deniedIndices(tokens(topic), deny).size || question !== cleanText(question)) return refuse("identity_token", best);
    record.accepted_by = cand.by;
    record.candidate_sha256 = await sha256Hex(question);
    const verdict_id = await sha256Hex(canonicalJson(record));
    return {
      ok: true, record, verdict_id,
      request: { question, topic, links: pages.map((p) => p.url), purpose, boundary: { version: BOUNDARY_VERSION, lexicon: lex.version, verdict_id, evidence: record.evidence } },
    };
  }
  return refuse("no_candidate_passed", purpose === "idea-research" ? best : null);
}

/** The proposer's prompt (the local model; D9). It sees the personal item - the model is local and its output is
 *  only a proposal: nothing it writes reaches a shared row unless the gate accepts it. */
export const PROPOSER_SYSTEM =
  `You write research questions for a public research library. From the PRIVATE NOTE below, write up to 3 short, ` +
  `self-contained questions about the PUBLIC topic it concerns, using only common words and the words of the PUBLIC ` +
  `PAGES. Never include a person's name, an address, a company or product the note invents, an id, a code, a date, a ` +
  `number that is not on a public page, or any phrase copied from the note. Answer JSON: {"questions": ["..."]}.`;

export function proposerUser(item: PersonalItem, ev: Evidence): string {
  const note = Object.entries(item.fields).map(([k, v]) => `${k}: ${String(v).slice(0, 2000)}`).join("\n");
  const pages = ev.pages.map((p) => `- ${p.title}: ${p.text.slice(0, 1500)}`).join("\n");
  return `PRIVATE NOTE:\n${note}\n\nPUBLIC PAGES:\n${pages || "(none)"}`;
}

export function parseProposals(raw: string): string[] {
  try {
    const j = JSON.parse(raw);
    const qs = Array.isArray(j) ? j : (j?.questions ?? []);
    return Array.isArray(qs) ? qs.filter((x: unknown) => typeof x === "string").slice(0, MAX_CANDIDATES) : [];
  } catch { return []; }
}

// ── the one writer ───────────────────────────────────────────────────────────────────────────
export interface Q { queryObject<T>(sql: string, args?: unknown[]): Promise<{ rows: T[] }> }

/** The ONLY writer of a derived job (request_kind 'derived'): query = anchor = the question, no inlet_ref, no
 *  refinery_id, no seed content / callback / on-behalf in options (the public links ride as `public_links`, which
 *  the research service fetches itself), caller 'boundary', origin 'manual' (generic: no lane names the inlet), the
 *  boundary stamp. No research_prompts row: the question is public. Slot 420's trigger refuses anything else. */
export async function insertDerivedJob(c: Q, req: DerivedRequest, run: DerivedRun = {}): Promise<string> {
  // rw-boundary-digest (slot 460): the engine's run knobs ride beside the links - fixed values, a flag and a time,
  // nothing a caller wrote (parseDoorBody validated them; slot 460's allow-list refuses anything else)
  const options = { public_links: req.links, queue_origin: "manual", ...runOptions(run) };
  const r = await c.queryObject<{ id: string }>(
    `INSERT INTO public.research_jobs (status, origin, caller, query, anchor, options, request_kind, boundary)
     VALUES ('queued', 'manual', 'boundary', $1, $1, $2::jsonb, 'derived', $3::jsonb) RETURNING id::text AS id`,
    [req.question, JSON.stringify(options), JSON.stringify({ ...req.boundary, topic: req.topic })],
  );
  return r.rows[0].id;
}

/** rw-boundary-digest (plan 09 2.5 P3/P5, slot 460): how a derived job RUNS - never what it is about. The digest's
 *  article keeps its article mode and its preliminary gap pass; a dry run writes nothing canonical; the caller's
 *  deadline means the engine never starts a job nobody waits for. Enumerated values, a boolean and a timestamp only. */
export interface DerivedRun { mode?: "article"; gap_research?: "none" | "preliminary"; dry_run?: boolean; deadline_at?: string }

export function runOptions(run: DerivedRun): Record<string, unknown> {
  return {
    ...(run.mode === "article" ? { mode: "article" } : {}),
    ...(run.gap_research ? { gap_research: run.gap_research } : {}),
    ...(run.dry_run === true ? { dry_run: true } : {}),
    ...(run.deadline_at ? { deadline_at: run.deadline_at } : {}),
  };
}

/** The door's `run` object, validated: anything but the four keys and their fixed shapes is refused. The deadline is
 *  normalised to the one stored shape (Date#toISOString), as POST /research does. */
export function parseRun(v: unknown): { run: DerivedRun } | { error: string } {
  if (v === undefined || v === null) return { run: {} };
  if (typeof v !== "object" || Array.isArray(v)) return { error: "run is an object" };
  const r = v as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => !["mode", "gap_research", "dry_run", "deadline_at"].includes(k));
  if (extra.length) return { error: `run carries only mode, gap_research, dry_run, deadline_at (not ${extra.join(", ").slice(0, 80)})` };
  const run: DerivedRun = {};
  if (r.mode !== undefined) { if (r.mode !== "article") return { error: "run.mode is article" }; run.mode = "article"; }
  if (r.gap_research !== undefined) {
    if (r.gap_research !== "none" && r.gap_research !== "preliminary") return { error: "run.gap_research is none or preliminary" };
    run.gap_research = r.gap_research;
  }
  if (r.dry_run !== undefined) { if (typeof r.dry_run !== "boolean") return { error: "run.dry_run is a boolean" }; if (r.dry_run) run.dry_run = true; }
  if (r.deadline_at !== undefined && r.deadline_at !== null && r.deadline_at !== "") {
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;
    if (typeof r.deadline_at !== "string" || !ISO.test(r.deadline_at.trim())) return { error: "run.deadline_at is an ISO-8601 date-time with a zone" };
    const d = new Date(r.deadline_at.trim());
    if (!Number.isFinite(d.getTime())) return { error: "run.deadline_at is not a valid time" };
    run.deadline_at = d.toISOString();
  }
  return { run };
}

/** The hand-back row (slot 420's SECURITY DEFINER handback_open: the app role has no grant on the table). */
export async function openHandback(c: Q, h: {
  item: PersonalItem; purpose: Purpose; jobId: string | null; state: "queued" | "refused" | "awaiting_owner";
  record: GateRecord; verdictId: string; ownerView: OwnerView | null; deliver: Record<string, unknown>;
}): Promise<string> {
  const r = await c.queryObject<{ id: string }>(
    `SELECT public.handback_open($1, $2, $3, $4, $5, $6::uuid, $7, $8::jsonb, $9::jsonb, $10::jsonb)::text AS id`,
    [h.item.owner_sub, h.item.kind, String(h.item.id), h.item.revision ?? null, h.purpose, h.jobId, h.state,
     JSON.stringify({ ...h.record, verdict_id: h.verdictId }), h.ownerView ? JSON.stringify(h.ownerView) : null, JSON.stringify(h.deliver ?? {})],
  );
  return r.rows[0].id;
}

/** The door's body, validated: a refusal names why (400). Seed content, callbacks, inlet refs, on-behalf subjects, a
 *  query or options are refused outright - a derived request carries nothing a caller chose to put on the job. */
export const DOOR_REFUSED_KEYS = ["seed_sources", "callback", "inlet_ref", "on_behalf_of", "query", "options", "thread_id", "refinery_id"];

export function parseDoorBody(body: unknown): { item: PersonalItem; purpose: Purpose; deliver: Record<string, unknown>; run: DerivedRun } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "bad body" };
  const b = body as Record<string, unknown>;
  const bad = DOOR_REFUSED_KEYS.filter((k) => k in b);
  const it = b.item as Record<string, unknown> | undefined;
  if (it && typeof it === "object") for (const k of DOOR_REFUSED_KEYS) if (k in it && !bad.includes(k)) bad.push(k);
  if (bad.length) return { error: `refused: a derived request carries no ${bad.join(", ")} (seed content is fetched by the service itself)` };
  if (!it || typeof it !== "object") return { error: "item required" };
  const purpose = String(b.purpose ?? "");
  if (!PURPOSES.has(purpose)) return { error: `purpose is one of ${[...PURPOSES].join(", ")}` };
  const kind = String(it.kind ?? "");
  if (!INLET_KINDS.has(kind)) return { error: `item.kind is one of ${[...INLET_KINDS].join(", ")}` };
  const id = String(it.id ?? "").trim();
  if (!id || id.length > 500) return { error: "item.id required (<= 500 chars)" };
  const fields: Record<string, string> = {};
  if (it.fields && typeof it.fields === "object" && !Array.isArray(it.fields)) {
    for (const [k, v] of Object.entries(it.fields as Record<string, unknown>)) {
      if (typeof v !== "string") return { error: `item.fields.${k} is a string` };
      fields[k.slice(0, 64)] = v.slice(0, 20000);
    }
  }
  const links = Array.isArray(it.links) ? it.links : [];
  if (links.some((l) => typeof l !== "string")) return { error: "item.links are strings (urls)" };
  const identity = Array.isArray(it.identity) ? it.identity.filter((x) => typeof x === "string").map(String) : [];
  const deliver = b.deliver && typeof b.deliver === "object" && !Array.isArray(b.deliver) ? b.deliver as Record<string, unknown> : {};
  if (JSON.stringify(deliver).length > 4000) return { error: "deliver is at most 4000 characters of JSON" };
  const rev = it.revision === undefined || it.revision === null ? undefined : Number(it.revision);
  if (rev !== undefined && !Number.isInteger(rev)) return { error: "item.revision is an integer" };
  const run = parseRun(b.run);
  if ("error" in run) return { error: run.error };
  return {
    item: { kind: kind as InletKind, id, revision: rev, owner_sub: String(it.owner_sub ?? ""), fields, links: (links as string[]).slice(0, 50), identity },
    purpose: purpose as Purpose, deliver, run: run.run,
  };
}

/** rw-boundary-digest: the delivery record's body - job ids (uuid), a boolean, and at most two ids (uuid) per job:
 *  the private episode it fed and the shared thread it resolved to. Nothing else reaches the hand-back. */
export interface Delivery { job_id: string; ok: boolean; note: { episode_id?: string; thread_id?: string } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseDeliveries(body: unknown): { deliveries: Delivery[] } | { error: string } {
  const b = body as { deliveries?: unknown } | null;
  if (!b || typeof b !== "object" || !Array.isArray(b.deliveries)) return { error: "deliveries required" };
  if (b.deliveries.length > 500) return { error: "at most 500 deliveries" };
  const out: Delivery[] = [];
  for (const raw of b.deliveries) {
    const d = raw as Record<string, unknown>;
    if (!d || typeof d !== "object" || Array.isArray(d)) return { error: "a delivery is an object" };
    const extra = Object.keys(d).filter((k) => !["job_id", "ok", "episode_id", "thread_id"].includes(k));
    if (extra.length) return { error: `a delivery carries only job_id, ok, episode_id, thread_id` };
    if (typeof d.job_id !== "string" || !UUID.test(d.job_id)) return { error: "job_id is a uuid" };
    if (typeof d.ok !== "boolean") return { error: "ok is a boolean" };
    const note: Delivery["note"] = {};
    for (const k of ["episode_id", "thread_id"] as const) {
      if (d[k] === undefined || d[k] === null) continue;
      if (typeof d[k] !== "string" || !UUID.test(d[k] as string)) return { error: `${k} is a uuid` };
      note[k] = (d[k] as string).toLowerCase();
    }
    out.push({ job_id: d.job_id.toLowerCase(), ok: d.ok, note });
  }
  return { deliveries: out };
}

/** The delivery on the private hand-back (slot 460's SECURITY DEFINER handback_deliver: the caller that opened it
 *  only, a queued row only, the two ids only). True when a hand-back took it. */
export async function recordDelivery(c: Q, d: Delivery, caller: string): Promise<boolean> {
  const r = await c.queryObject<{ ok: boolean }>(`SELECT public.handback_deliver($1::uuid, $2, $3, $4::jsonb) AS ok`,
    [d.job_id, caller, d.ok, JSON.stringify(d.note)]);
  return r.rows[0]?.ok === true;
}
