// research-workbench P3b - the trust panels: the claims ledger, the coverage panel and the source
// quality panel, registered here (one import line in panels/index.ts). Every one is a side panel and
// follows the at-rest rule (shell/Disclosure.tsx).
import { registerNav, registerPanel } from "../../shell/registry";
import { ClaimsLedger } from "./ClaimsLedger";
import { CoveragePanel } from "./CoveragePanel";
import { SourceQualityPanel } from "./SourceQualityPanel";
import "./trust.css";

registerPanel({ id: "claims-ledger", version: 1, title: "Claims ledger", kind: "side", component: ClaimsLedger, position: "below" });
registerNav({ id: "claims-ledger", version: 1, label: "Claims", order: 80, panel: "claims-ledger" });
registerPanel({ id: "coverage", version: 1, title: "Coverage", kind: "side", component: CoveragePanel, position: "right" });
registerNav({ id: "coverage", version: 1, label: "Coverage", order: 81, panel: "coverage" });
registerPanel({ id: "source-quality", version: 1, title: "Source quality", kind: "side", component: SourceQualityPanel, position: "right" });
registerNav({ id: "source-quality", version: 1, label: "Source quality", order: 82, panel: "source-quality" });
