import { useState } from "react";
import { applyTheme, readTheme, type ThemeChoice } from "./lib/theme";
import { useRoute } from "./lib/router";

const NEXT: Record<ThemeChoice, ThemeChoice> = { system: "light", light: "dark", dark: "system" };

// The empty frame: it says what it is and shows the route it was opened at. No screen yet.
export function App() {
  const route = useRoute();
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  return (
    <div className="frame">
      <header className="frame-bar">
        <h1>Research workbench</h1>
        <button type="button" data-testid="theme" onClick={() => { const n = NEXT[theme]; applyTheme(n); setTheme(n); }}>
          Colours: {theme}
        </button>
      </header>
      <main className="frame-main">
        <p data-testid="what">This is the new workbench app: an empty frame. Its screens arrive in later steps.</p>
        <p>You opened <code data-testid="route">{route.path}</code></p>
      </main>
    </div>
  );
}
