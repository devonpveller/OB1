// Light / dark: with no choice the system's prefers-color-scheme applies (theme/tokens.css); an
// explicit choice is data-theme on <html>, remembered in localStorage (a per-viewer convenience only).
export type ThemeChoice = "system" | "light" | "dark";
const KEY = "workbench.theme";

export function readTheme(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(choice: ThemeChoice) {
  const el = document.documentElement;
  if (choice === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", choice);
  try {
    if (choice === "system") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch { /* storage may be blocked; the choice still applies for this page */ }
}
