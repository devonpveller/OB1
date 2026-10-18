# archive/skeptic - the Skeptic tier, retired by research-workbench P3a (D10)

Archived 2026-10-17 by `rw-p3a-entail`. Not imported by anything; not shipped (the image copies
only the top-level `*.ts`), not type-checked or tested (`deno.json` excludes `archive/`).

| File | Was | Retired because | Replaced by |
|---|---|---|---|
| `skeptic.ts` | the Phase 2 "Skeptic" defensive gate: an adversarial judge over the whole synthesis that downgraded weak/refuted claims (`SKEPTIC_SYS`, `parseSkepticResult`, `applyDowngrades`, `deriveRequeries`); wired in `harness.ts` behind `SKEPTIC_ENABLED` (default off, never enabled in prod - 01-OPEN-ITEMS D10) and recorded as `result.skeptic` | D10 (operator, 2026-09-25): the per-claim entailment stage is the target; the Skeptic is archived design, kept as ideas | `entailment.ts` - one verdict per cited line against the text it cites, fail-closed |
| `skeptic.test.ts` | its unit tests | as above | the Skeptic's recorded downgrades are a regression fixture, `fixtures/skeptic-regression.json` (its own `applyDowngrades` output, recorded before archiving); `entailment.test.ts` proves the entailment stage reproduces each one byte for byte |

What was removed with it: the `SKEPTIC_ENABLED` flag and the step that read it (`harness.ts`), the
`skeptic` field of `RunResult` and of `research_jobs.result` (`index.ts`). `SKEPTIC_REGATHER_MAX`
(named in `skeptic.ts`'s header) was reserved and never read. The design idea kept for later is
`deriveRequeries`: a negated query per refuted claim, so gathering is not only confirmatory.

To run the archived tests by hand: `deno test --no-config --allow-read archive/skeptic/skeptic.test.ts` (from this directory).
