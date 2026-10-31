// research-workbench P3b (rw-p3b-trustpanels) - the trust panels over a fake back end (helpers.ts):
//   A1 the claims ledger: every column on every row; sortable by confidence and by needs-a-look
//   A2 the coverage panel: needs by status counted (never a percent), the topic estimate beside the anchor
//   A3 the source quality panel: both axes, the rolling total with its reasons and its history
//   A4 the report header: the roll-up with the claim-kind weights it used, never a bare number
//   A5 the coverage panel's hub context (thin / contested), for a session and for a document
//   A6 multi-user: the panels name no user - every read is the contract's, scoped by the identity seam
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import "../src/panels";
import { panels } from "../src/shell/registry";
import { resetState, setState } from "../src/lib/store";
import { ClaimsLedger, LEDGER_COLUMNS } from "../src/panels/trust/ClaimsLedger";
import { CoveragePanel } from "../src/panels/trust/CoveragePanel";
import { SourceQualityPanel } from "../src/panels/trust/SourceQualityPanel";
import { ReportHeader } from "../src/panels/trust/ReportHeader";
import { resetTrust, setTrust } from "../src/panels/trust/focus";
import { type LedgerClaim, needsALook, relevanceOf, sortClaims, stanceOf, statusLine } from "../src/panels/trust/logic";
import { fakeApi, S1, S2, settle } from "./helpers";

const JOB = "c1000000-0000-4000-8000-000000000001";
const REPORT = "d1000000-0000-4000-8000-000000000001";
const PATH = "documents/test-doc.md";

const claim = (id: string, over: Partial<LedgerClaim>): LedgerClaim => ({
  id, text: `claim ${id}`, epistemic_tag: "sourced", status: "active", confidence: 0.7, contradicted: false, grounded: true,
  synthesis_id: REPORT, edges_by_type: { states: 1 }, sources: [{ source_id: S1, edge_type: "states", lifecycle: "active", title: "Source one", url: null }],
  verdict: "supports", corroborations: 1, contradicted_by_newer: false, ...over,
});
const CLAIMS = [
  claim("c1", { confidence: 0.9, edges_by_type: { states: 2, corroborates: 1 }, corroborations: 2 }),
  claim("c2", { confidence: 0.3, verdict: "partial", contradicted: true, contradicted_by_newer: true, edges_by_type: { states: 1, contradicts: 1 }, corroborations: 0 }),
  claim("c3", { confidence: 0.6, verdict: null, edges_by_type: { inferred_from: 1 }, corroborations: 0 }),
];
const ROLLUP = {
  report_id: REPORT, job_id: JOB, recorded: true, value: 0.62, claims: 2, below_floor: 1, judged_lines: 3, judged_not_filed: 1,
  claim_kind: "general_theory", model_version: "d15 weights v1 paper p1", weights: [{ family: "scholarly", weight: 1 }, { family: "general", weight: 0.4 }],
  filed: true, not_filed: null, basis: "filing",
  statement: "Report credibility 0.62 - the mean of 2 filed claim total(s), 1 below the claim floor, 1 judged line(s) not filed; claim kind general_theory, weights scholarly 1.00, general 0.40; model d15 weights v1 paper p1",
};
const HUBS = [
  { centre: { slug: "content/tool/t", title: "Tool hub", page_class: "entity", in_degree: 3 }, seeds: [], links: [{ kind: "source", id: S1 }], sources: 1, thin: true, contested: false, contested_claims: [], why: ["1 source page(s) around the centre (thin below 3)", "no contradicted claim grounded here"] },
  { centre: { slug: "content/concept/k", title: "Concept hub", page_class: "entity", in_degree: 5 }, seeds: [], links: [{ kind: "source", id: S2 }], sources: 6, thin: false, contested: true, contested_claims: [{ claim_id: "c2", text: "claim c2" }], why: ["6 source pages around the centre", "1 contradicted claim(s) grounded in this neighbourhood"] },
];
const COVERAGE = {
  session_id: JOB, status: "done", created_at: new Date().toISOString(),
  needs: [{ need: "what is X", status: "answered" }, { need: "how big is X", status: "partial" }, { need: "who makes X", status: "open" }, { need: "when was X", status: "search_failed" }, { need: "why X", status: "answered" }],
  by_status: { answered: 2, partial: 1, open: 1, search_failed: 1 }, gaps: ["who makes X"],
  topic_estimate: "X, its makers and its size", anchor: "tell me about X", anchor_basis: "the session's own question (a root has no other anchor)",
  report_id: REPORT, credibility: ROLLUP, hubs: HUBS,
};
const QUALITY = {
  source_id: S1, state: "active", family: "scholarly", claim_kind: "general_theory", signals: { scholarly: { cited_by: 40 } },
  score: { value: 0.71, refinery_scoped: null, version: "d15 weights v1 paper p1", computed_from: "D15 rolling total for claim kind general_theory: family score (paper score p1) x the weight row" },
  corroborated_by: [{ source_id: S2, title: "Source two", family: "general", relation: "weak corroboration (entailment supports)", amount: 0.05, claim: "claim c1" }],
  contradicted_by: [],
  history: [{ score: 0.66, total: 0.71, claim_kind: "general_theory", model_version: "d15 weights v1 paper p1", computed_at: new Date().toISOString() }],
  factors: [
    { name: "scholarly_family_score", value: 0.66, reason: "paper score p1: 40 citations, authors' works 120, age 2y" },
    { name: "corroboration_received", value: 0.05, reason: "weak corroboration (entailment supports) from Source two" },
    { name: "contradicting_sources", value: 0, reason: "sources contradicting a claim this source grounds (listed in contradicted_by)" },
  ],
};

function backend(extra: any[] = []) {
  return fakeApi([
    ...extra,
    ["GET", `/workbench/contract/sessions/${JOB}/coverage`, () => COVERAGE],
    ["GET", "/workbench/contract/documents/coverage", () => ({ path: PATH, computed_at: new Date().toISOString(), hubs: HUBS, sessions: [{ id: JOB, status: "done", created_at: new Date().toISOString(), by_status: COVERAGE.by_status, credibility: ROLLUP.statement }] })],
    ["GET", `/workbench/contract/reports/${REPORT}/credibility`, () => ROLLUP],
    ["GET", /\/workbench\/contract\/claims\?synthesis_id=/, () => ({ count: CLAIMS.length, claims: CLAIMS })],
    ["GET", /\/workbench\/contract\/claims\?source_id=/, () => ({ count: 2, claims: [CLAIMS[0], claim("c9", { synthesis_id: "e1000000-0000-4000-8000-000000000009" })] })],
    ["GET", `/workbench/contract/sources/${S1}/quality`, () => QUALITY],
    ["GET", `/workbench/contract/references/${S1}`, () => ({ state: "active", source: { title: "Source one" } })],
  ]);
}

beforeEach(() => {
  resetState();
  resetTrust();
});
afterEach(() => cleanup());

const open = async (el: Element | null) => {
  await act(async () => { fireEvent.click(el as HTMLElement); await settle(); });
};

describe("A1: the claims ledger", () => {
  it("every row carries every column: tag, verdict, stance bar from the edge types, corroboration, contradicted-by-newer, confidence", async () => {
    backend();
    setTrust({ session: JOB, report: REPORT });
    const { container } = render(<ClaimsLedger params={{}} />);
    await act(async () => settle(10));
    const head = [...container.querySelectorAll("[data-testid=ledger-columns] [data-col]")].map((e) => (e as HTMLElement).dataset.col);
    expect(head).toEqual([...LEDGER_COLUMNS]);
    const rows = [...container.querySelectorAll(".ws-ledger-row")];
    expect(rows.length).toBe(3);
    for (const r of rows) {
      for (const col of LEDGER_COLUMNS) expect(r.querySelector(`[data-col="${col}"]`), `${(r as HTMLElement).dataset.claim}: column ${col}`).toBeTruthy();
    }
    const c2 = container.querySelector('[data-claim="c2"]')!;
    expect(c2.querySelector('[data-col="tag"]')!.textContent).toBe("sourced");
    expect(c2.querySelector('[data-col="verdict"]')!.textContent).toBe("partial");
    expect(c2.querySelector('[data-col="corroboration"]')!.textContent).toBe("+0");
    expect(c2.querySelector('[data-col="contradicted by newer"]')!.textContent).toBe("contradicted by newer");
    expect(c2.querySelector('[data-col="confidence"]')!.textContent).toBe("0.30");
    const bar = c2.querySelector("[data-testid=stance-bar]") as HTMLElement;
    expect([bar.dataset.supports, bar.dataset.contradicts, bar.dataset.mentions]).toEqual(["1", "1", "0"]);
    const c1bar = container.querySelector('[data-claim="c1"] [data-testid=stance-bar]') as HTMLElement;
    expect([c1bar.dataset.supports, c1bar.dataset.contradicts]).toEqual(["3", "0"]);
    expect(container.querySelector('[data-claim="c3"] [data-col="verdict"]')!.textContent).toBe("not judged");
  });

  it("sorts by needs-a-look (default, most first) and by confidence (high first, then low first)", async () => {
    backend();
    setTrust({ session: JOB, report: REPORT });
    const { container } = render(<ClaimsLedger params={{}} />);
    await act(async () => settle(10));
    const order = () => [...container.querySelectorAll(".ws-ledger-row")].map((e) => (e as HTMLElement).dataset.claim);
    expect(order()).toEqual(["c2", "c3", "c1"]);
    await open(container.querySelector('[data-sort="confidence"]'));
    expect(order()).toEqual(["c1", "c3", "c2"]);
    await open(container.querySelector('[data-sort="confidence"]'));
    expect(order()).toEqual(["c2", "c3", "c1"]);
    await open(container.querySelector('[data-sort="needs-a-look"]'));
    expect(order()).toEqual(["c2", "c3", "c1"]);
  });

  it("the pure parts: stance from edge types, needs-a-look reasons, both sort orders", () => {
    expect(stanceOf({ states: 2, corroborates: 1, contradicts: 1, inferred_from: 2 })).toEqual({ supports: 3, contradicts: 1, mentions: 2, total: 6 });
    const look = needsALook(CLAIMS[1]);
    expect(look.reasons).toEqual(expect.arrayContaining(["contradicted by something newer", "contradicted", "entailment partial", "no corroborating source"]));
    expect(needsALook(CLAIMS[0]).score).toBe(0);
    expect(sortClaims(CLAIMS, "confidence").map((c) => c.id)).toEqual(["c1", "c3", "c2"]);
    expect(sortClaims(CLAIMS, "confidence", false).map((c) => c.id)).toEqual(["c2", "c3", "c1"]);
    expect(sortClaims(CLAIMS, "needs-a-look").map((c) => c.id)).toEqual(["c2", "c3", "c1"]);
  });
});

describe("A2 / A4 / A5: the coverage panel of a session", () => {
  it("needs by status counted (never a percent), the topic estimate beside the anchor, the report header with its weights, the hubs", async () => {
    const { log } = backend();
    const { container } = render(<CoveragePanel params={{ session_id: JOB }} />);
    await act(async () => settle(10));
    expect(container.querySelector("[data-testid=status-line]")!.textContent).toBe("2 answered · 1 partial · 1 open · 1 search failed");
    expect(container.textContent, "a percent anywhere in the panel").not.toMatch(/%/);
    const est = container.querySelector("[data-testid=estimate]")!;
    expect(est.querySelector("[data-testid=topic-estimate]")!.textContent).toBe("X, its makers and its size");
    expect(est.querySelector("[data-testid=anchor]")!.textContent).toBe("tell me about X");
    const statuses = [...container.querySelectorAll("[data-need-status]")].map((e) => (e as HTMLElement).dataset.needStatus);
    expect(statuses).toEqual(["answered", "partial", "open", "search_failed", "answered"]);
    // A4: the report header carries the roll-up WITH the weights
    const header = container.querySelector("[data-testid=report-header]")!;
    expect(header.querySelector("[data-testid=rollup-statement]")!.textContent).toContain("weights scholarly 1.00, general 0.40");
    expect([...header.querySelectorAll("[data-family]")].map((r) => r.textContent)).toEqual(["scholarly1.00", "general0.40"]);
    // A5: the hubs the session touches, thin / contested
    const hubs = [...container.querySelectorAll("[data-hub]")].map((e) => (e as HTMLElement).dataset.hub);
    expect(hubs).toEqual(["content/tool/t", "content/concept/k"]);
    expect(container.querySelector('[data-leaf="hub:content/tool/t"] .ws-badge-thin')).toBeTruthy();
    expect(container.querySelector('[data-leaf="hub:content/concept/k"] .ws-badge-contested')).toBeTruthy();
    await open(container.querySelector('[data-leaf="hub:content/concept/k"] .ws-leaf-label'));
    expect(container.textContent).toContain("contested: claim c2");
    // A6: the one read is the contract's coverage of the session - no user named anywhere
    expect(log.map((r) => r.url)).toContain(`/workbench/contract/sessions/${JOB}/coverage`);
    for (const r of log) expect(r.url, "a panel names no user").not.toMatch(/[?&](sub|user|owner|subject|owner_sub)=/i);
  });

  it("statusLine counts every status, unknown ones too, and never prints a percent", () => {
    expect(statusLine({ answered: 3 })).toBe("3 answered · 0 partial · 0 open · 0 search failed");
    expect(statusLine({ answered: 1, weird: 2 })).toBe("1 answered · 0 partial · 0 open · 0 search failed · 2 weird");
  });

  it("a report with no recorded roll-up says so in words - never a bare number", () => {
    const { container } = render(<ReportHeader rollup={{ ...ROLLUP, recorded: false, value: null, weights: [], statement: "Report credibility: not recorded for this report (its run predates the D15 roll-up, or no research job filed it)" }} />);
    expect(container.textContent).toMatch(/not recorded/);
    expect(container.textContent).not.toMatch(/^\s*\d+(\.\d+)?\s*$/);
  });
});

describe("A5: the coverage panel of a document", () => {
  it("lists the hubs the document touches and the user's own sessions; focusing one shows its coverage", async () => {
    const { log } = backend();
    setState({ documentPath: PATH });
    const { container } = render(<CoveragePanel params={{}} />);
    await act(async () => settle(10));
    expect(container.querySelector(".ws-leaves"), "at rest: the summary only").toBeNull();
    await open(container.querySelector(".ws-summary"));
    expect([...container.querySelectorAll("[data-hub]")].length).toBe(2);
    const s = container.querySelector(`[data-session="${JOB}"]`)!;
    expect(s.textContent).toContain("2 answered · 1 partial · 1 open · 1 search failed");
    await open(container.querySelector(`[data-leaf="session:${JOB}"] .ws-leaf-label`));
    await open(container.querySelector("[data-action=focus-session]"));
    await act(async () => settle(10));
    expect(container.querySelector("[data-testid=topic-estimate]")).toBeTruthy();
    expect(log.map((r) => r.url)).toContain(`/workbench/contract/documents/coverage?path=${encodeURIComponent(PATH)}`);
  });
});

describe("A3: the source quality panel", () => {
  it("both axes, the rolling total with its reasons, its history", async () => {
    backend();
    setTrust({ source: S1 });
    const { container } = render(<SourceQualityPanel params={{}} />);
    await act(async () => settle(10));
    const legit = container.querySelector("[data-testid=axis-legitimacy]")!;
    expect(legit.textContent).toContain("scholarly family score 0.66");
    expect(legit.textContent).toContain("paper score p1");
    const rel = container.querySelector("[data-testid=axis-relevance]")!;
    expect(rel.textContent).toContain("grounds 2 claim(s) across 2 run(s)");
    expect(container.querySelector("[data-testid=rolling-total]")!.textContent).toContain("rolling total 0.71");
    await open(container.querySelector('[data-leaf="total"] .ws-leaf-label'));
    const reasons = [...container.querySelectorAll("[data-testid=total-reasons] [data-factor]")].map((e) => (e as HTMLElement).dataset.factor);
    expect(reasons).toEqual(["scholarly_family_score", "corroboration_received", "contradicting_sources"]);
    await open(container.querySelector('[data-leaf="history"] .ws-leaf-label'));
    expect(container.querySelectorAll("[data-testid=history-list] li").length).toBe(1);
  });

  it("with a session in focus the relevance axis reads against that run", async () => {
    backend();
    setTrust({ source: S1, session: JOB, report: REPORT });
    const { container } = render(<SourceQualityPanel params={{}} />);
    await act(async () => settle(10));
    expect(container.querySelector("[data-testid=axis-relevance]")!.textContent).toBe("relevance for the rungrounds 1 of the focused run's 3 claim(s)");
    expect(relevanceOf([CLAIMS[0]], { report_id: REPORT, claims: 3 }).claims).toBe(1);
  });
});

describe("registration", () => {
  it("the three trust panels are registered side panels", () => {
    const ids = panels().filter((p) => p.kind === "side").map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["claims-ledger", "coverage", "source-quality"]));
  });
});
