import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./panels";
import { Shell } from "./shell/Shell";
import { setState } from "./lib/store";
import { loadOwner } from "./lib/owner";
import { loadMe, needsSignIn } from "./lib/auth";
import { SignIn } from "./shell/Identity";
import { applyTheme, readTheme } from "./shell/TitleBar";
import "./styles.css";

// ?doc=<documents/...> opens a document (a link into the workspace from anywhere)
const doc = new URLSearchParams(location.search).get("doc");
if (doc) setState({ documentPath: doc });

// rw-identity: signed in first (with sign-in configured, nothing renders before it); then whose
// workspace it is (the identity seam), then their layout and theme
loadMe().then(async (me) => {
  const root = createRoot(document.getElementById("root")!);
  if (needsSignIn(me)) {
    root.render(<SignIn here={location.pathname + location.search} />);
    return;
  }
  await loadOwner();
  applyTheme(readTheme());
  root.render(
    <StrictMode>
      <Shell />
    </StrictMode>,
  );
});
