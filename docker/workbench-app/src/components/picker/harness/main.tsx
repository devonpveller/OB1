// DEV-ONLY test harness for the picker (rwr-picker): the picker alone on a page, so a browser test can drive it
// without any screen. Built into the image ONLY when the build arg PICKER_HARNESS=1 (vite.config.ts); the
// production build has no /picker-harness.html. Not a route of the app and not a second picker: it mounts
// ItemPicker. Query: ?mode=single|multi &scope=library|document|mine &linked=1 &q=<text> &mine=0 &refinery=<id>
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ItemPicker, type MineSearch, type PickerItem, type PickerScope } from "..";
import { api } from "../../../lib/api";
import { applyTheme, readTheme } from "../../../lib/theme";
import "../../../styles.css";

const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") === "single" ? "single" : "multi";
const SCOPES: PickerScope[] = [
  { kind: "library" },
  { kind: "document", label: "Upgrading the workstation CPU", topics: ["Workstation hardware", "Cooling"], refineryId: params.get("refinery") },
  { kind: "library+mine" },
];
const start = ({ document: SCOPES[1], mine: SCOPES[2] } as Record<string, PickerScope>)[params.get("scope") ?? ""] ?? SCOPES[0];

// The own-thoughts search does not exist on the real back end yet (rwr-own-thoughts-search-api). The lab's stub
// answers this path per identity; against a real workbench it 404s and the picker shows its error line.
const mineSearch: MineSearch | undefined = params.get("mine") === "0" ? undefined : async (q) => {
  const r = await api<{ results?: PickerItem[] }>("GET", `/workbench/__lab/mine?q=${encodeURIComponent(q)}`);
  return r.data.results ?? [];
};

function Harness() {
  const [out, setOut] = useState<PickerItem[] | null>(null);
  const [theme, setTheme] = useState(readTheme());
  return (
    <main style={{ padding: 16 }}>
      <button type="button" data-testid="theme" onClick={() => { const n = theme === "dark" ? "light" : "dark"; applyTheme(n); setTheme(n); }}>Colours: {theme}</button>
      <ItemPicker
        mode={mode}
        title="Pick items"
        subtitle="test harness"
        scope={start}
        scopes={SCOPES}
        alreadyLinked={params.get("linked") === "1" ? new Set(["source:s-alpha"]) : undefined}
        mineSearch={mineSearch}
        initialQuery={params.get("q") ?? ""}
        debounceMs={50}
        onConfirm={setOut}
        onCancel={() => setOut([])}
      />
      <pre data-testid="result">{out ? JSON.stringify(out.map((i) => `${i.kind}:${i.id}`)) : ""}</pre>
    </main>
  );
}
applyTheme(readTheme());
createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
