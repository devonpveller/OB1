// rw-p3b-trust2 (review r-p3b-trust B2): the trust panels' source focus never strands the ledger or the quality
// panel off the workspace's selection. These cases deliberately do NOT reset the trust focus between steps - they
// start from a click in the ledger ("Quality of ..."), exactly the state the review found stuck - and only the
// workspace store is reset per test (resetTrust is never called here).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import "../src/panels";
import { resetState, setState } from "../src/lib/store";
import { ClaimsLedger } from "../src/panels/trust/ClaimsLedger";
import { SourceQualityPanel } from "../src/panels/trust/SourceQualityPanel";
import { getTrust } from "../src/panels/trust/focus";
import { fakeApi, settle } from "./helpers";

const R1 = "d1000000-0000-4000-8000-0000000000a1";
const R2 = "d1000000-0000-4000-8000-0000000000a2";
const W = "b1000000-0000-4000-8000-0000000000c1";
const rollup = (r: string) => ({
  report_id: r, job_id: null, recorded: true, value: 0.5, claims: 1, below_floor: 0, claim_kind: "general_theory", model_version: "m",
  weights: [{ family: "scholarly", weight: 1 }], statement: `Report credibility 0.50 of ${r}; claim kind general_theory, weights scholarly 1.00; model m`,
});
const claimOf = (id: string, syn: string) => ({
  id, text: `claim ${id}`, epistemic_tag: "sourced", status: "active", confidence: 0.7, contradicted: false, grounded: true, synthesis_id: syn,
  edges_by_type: { states: 1 }, sources: [{ source_id: W, edge_type: "states", lifecycle: "active", title: "Web page W", url: null }],
  verdict: "supports", corroborations: 0, contradicted_by_newer: false,
});
const quality = (id: string) => ({
  source_id: id, state: "active", family: "general", claim_kind: null, signals: {}, contradicted_by: [], history: [],
  // a report is corroborated by W, so its quality panel offers "Show its quality" on W
  corroborated_by: id === W ? [] : [{ source_id: W, title: "Web page W", family: "general", relation: "co-grounds a claim", amount: null, claim: "c" }],
  score: { value: 0.4, refinery_scoped: null, version: "v", computed_from: "x" }, factors: [{ name: "general_family_score", value: 0.4, reason: "r" }],
});

function backend() {
  return fakeApi([
    ["GET", /\/workbench\/contract\/reports\/[^/]+\/credibility/, (u) => rollup(u.split("/")[4])],
    ["GET", `/workbench/contract/references/${R1}`, () => ({ state: "active", source: { title: "Report one", content_type: "research_synthesis" } })],
    ["GET", `/workbench/contract/references/${R2}`, () => ({ state: "active", source: { title: "Report two", content_type: "research_synthesis" } })],
    ["GET", `/workbench/contract/references/${W}`, () => ({ state: "active", source: { title: "Web page W", content_type: "web_article" } })],
    ["GET", new RegExp(`claims\\?synthesis_id=${R1}`), () => ({ count: 1, claims: [claimOf("r1c", R1)] })],
    ["GET", new RegExp(`claims\\?synthesis_id=${R2}`), () => ({ count: 1, claims: [claimOf("r2c", R2)] })],
    ["GET", /claims\?source_id=/, (u) => ({ count: 1, claims: [claimOf(`citing-${u.split("=")[1].slice(0, 8)}`, "e1000000-0000-4000-8000-000000000009")] })],
    ["GET", /\/sources\/[^/]+\/quality/, (u) => quality(u.split("/")[4])],
  ]);
}

beforeEach(() => resetState());
afterEach(() => cleanup());

describe("B2: the trust focus follows the workspace selection", () => {
  it("'Quality of W' on a report-scoped ledger keeps the ledger on the report; selecting another report moves both panels", async () => {
    const api = backend();
    setState({ reference: { reference_id: null, source_id: R1, chunk_idx: 0 } });
    const led = render(<ClaimsLedger params={{}} />);
    const qual = render(<SourceQualityPanel params={{}} />);
    await act(async () => settle(15));
    expect(led.container.querySelector('[data-claim="r1c"]'), "the ledger lists report one's claims").toBeTruthy();
    // the user opens the row and clicks "Quality of Web page W"
    // a report-scoped ledger opens on its leaves (the report is its focus); open it if it is not
    if (led.container.querySelector("[data-testid=ledger-disclosure]")?.getAttribute("data-open") !== "1") {
      await act(async () => { fireEvent.click(led.container.querySelector(".ws-summary")!); await settle(); });
    }
    await act(async () => { fireEvent.click(led.container.querySelector('[data-leaf="r1c"] .ws-leaf-label')!); await settle(); });
    await act(async () => { fireEvent.click(led.container.querySelector("[data-action=source-quality]")!); await settle(15); });
    expect(getTrust().source).toBe(W);
    expect(qual.container.querySelector("[data-source]")?.getAttribute("data-source"), "the quality panel shows W").toBe(W);
    expect(led.container.querySelector('[data-claim="r1c"]'), "the ledger's own row action does not re-scope the ledger").toBeTruthy();
    expect(led.container.querySelector("[data-scope]")?.getAttribute("data-scope")).toBe("synthesis_id");
    // now the user opens ANOTHER report in the reference panel: both panels follow it
    await act(async () => { setState({ reference: { reference_id: null, source_id: R2, chunk_idx: 0 } }); await settle(15); });
    expect(getTrust().source, "a new workspace selection clears the trust source focus").toBeNull();
    expect(led.container.querySelector('[data-claim="r2c"]'), "the ledger follows the newly selected report").toBeTruthy();
    expect(led.container.querySelector("[data-testid=report-header]")?.textContent).toContain(R2);
    expect(qual.container.querySelector("[data-source]")?.getAttribute("data-source"), "the quality panel follows it too").toBe(R2);
    expect(api.log.some((r) => r.url.startsWith(`/workbench/contract/claims?synthesis_id=${R2}`))).toBe(true);
  });

  it("'Show its quality' in the quality panel moves only the quality panel, until the selection changes", async () => {
    backend();
    setState({ reference: { reference_id: null, source_id: R1, chunk_idx: 0 } });
    const led = render(<ClaimsLedger params={{}} />);
    const qual = render(<SourceQualityPanel params={{}} />);
    await act(async () => settle(15));
    // left over from the previous test? the store reset changed the selection, so the trust focus was cleared
    expect(getTrust().source).toBeNull();
    expect(qual.container.querySelector("[data-source]")?.getAttribute("data-source")).toBe(R1);
    // the quality panel's corroborating source W: select its leaf, click "Show its quality"
    await act(async () => { fireEvent.click(qual.container.querySelector(`[data-leaf="src:${W}:c"] .ws-leaf-label`)!); await settle(); });
    await act(async () => { fireEvent.click(qual.container.querySelector("[data-action=focus-source]")!); await settle(15); });
    expect(getTrust().source).toBe(W);
    expect(qual.container.querySelector("[data-source]")?.getAttribute("data-source"), "the quality panel moved to W").toBe(W);
    expect(led.container.querySelector('[data-claim="r1c"]'), "the ledger stays on the selected report").toBeTruthy();
    expect(led.container.querySelector("[data-scope]")?.getAttribute("data-scope")).toBe("synthesis_id");
    // a new selection in the reference panel wins over the earlier pick
    await act(async () => { setState({ reference: { reference_id: null, source_id: R2, chunk_idx: 0 } }); await settle(15); });
    expect(getTrust().source).toBeNull();
    expect(qual.container.querySelector("[data-source]")?.getAttribute("data-source")).toBe(R2);
    expect(led.container.querySelector('[data-claim="r2c"]')).toBeTruthy();
    // and a plain web page selected scopes the ledger by source_id
    await act(async () => { setState({ reference: { reference_id: null, source_id: W, chunk_idx: 0 } }); await settle(15); });
    expect(led.container.querySelector("[data-scope]")?.getAttribute("data-scope"), "a plain source scopes by source_id").toBe("source_id");
  });
});
