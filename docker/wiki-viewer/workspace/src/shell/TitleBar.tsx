// The standard title bar (operator 2026-09-25 19:51): Settings, Theme, the notifications bell and the
// universal "+". The bell is the ONE notifications surface (it replaced the P1b strip; nothing about
// research status is routed outside the front end).
// rw-settings-store (operator 2026-11-03): Settings opens the Settings PANEL in the dock, like every other
// panel (panels/settings/SettingsPanel.tsx) - the floating popover is gone.
import { useState } from "react";
import { Bell } from "./Bell";
import { UniversalPlus } from "./Plus";
import { openPanel } from "./dock";
import { ownedKey } from "../lib/owner";
import { AccountMenu } from "./Identity";

const THEME_KEY = () => ownedKey("ws.theme"); // per user

export function readTheme(): string {
  try {
    return localStorage.getItem(THEME_KEY()) ?? "light";
  } catch {
    return "light";
  }
}

export function applyTheme(t: string) {
  document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem(THEME_KEY(), t);
  } catch { /* not kept */ }
}

export function TitleBar() {
  const [theme, setTheme] = useState(readTheme());
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  };
  return (
    <header className="ws-titlebar" role="banner">
      <span className="ws-brand">Workspace</span>
      <span className="ws-spacer" />
      <UniversalPlus />
      <Bell />
      <AccountMenu />
      <button type="button" className="ws-tb-btn" data-testid="theme" aria-label="theme" onClick={toggle}>
        {theme === "dark" ? "Light" : "Dark"}
      </button>
      <button type="button" className="ws-tb-btn" data-testid="settings" onClick={() => openPanel("settings")}>
        Settings
      </button>
    </header>
  );
}

