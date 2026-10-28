import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./panels";
import { Shell } from "./shell/Shell";
import { setState } from "./lib/store";
import { loadOwner } from "./lib/owner";
import { applyTheme, readTheme } from "./shell/TitleBar";
import "./styles.css";

// ?doc=<documents/...> opens a document (a link into the workspace from anywhere)
const doc = new URLSearchParams(location.search).get("doc");
if (doc) setState({ documentPath: doc });

// the user's own workspace: who it is first (the identity seam), then their layout and theme
loadOwner().then(() => {
  applyTheme(readTheme());
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Shell />
    </StrictMode>,
  );
});
