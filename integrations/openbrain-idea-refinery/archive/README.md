# Archived (research-workbench P4a, rw-p4a-trees, 2026-10-26)

| file | why retired | replacement |
|---|---|---|
| `test-e2e.sh` | The IR.1/IR.2 rollout gate. It asserts the nightly owed-research drain (`POST /run?wait=1` summary `selected/succeeded/delivered_pending`, `ideas_owed_research`) that P4a removed, and it breaks the lab rules (a non-internal network, a published port 18091). Not run since P4a. | On-demand engagement is tested in `../../research-service/trees.e2e.test.ts` T6 (lab runner `run-trees-e2e.ps1`); the brainstorm guard in `../test-operators-guard.ts`. |
