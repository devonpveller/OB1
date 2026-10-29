// The standard title bar (operator 2026-09-25 19:51): Settings, Theme, the notifications bell and the
// universal "+". The bell is the ONE notifications surface (it replaced the P1b strip; nothing about
// research status is routed outside the front end).
import { useState } from "react";
import { Bell } from "./Bell";
import { UniversalPlus } from "./Plus";
import { clearLayout, defaultLayout } from "./dock";
import { ownedKey } from "../lib/owner";
import { IdeaSchedule } from "./IdeaSchedule";

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
  const [settings, setSettings] = useState(false);
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
      <button type="button" className="ws-tb-btn" data-testid="theme" aria-label="theme" onClick={toggle}>
        {theme === "dark" ? "Light" : "Dark"}
      </button>
      <button type="button" className="ws-tb-btn" data-testid="settings" aria-expanded={settings} onClick={() => setSettings(!settings)}>
        Settings
      </button>
      {settings && (
        <div className="ws-popover ws-settings" role="dialog" aria-label="settings">
          <button type="button" onClick={() => { clearLayout(); defaultLayout(); setSettings(false); }}>Reset the layout</button>
          <p className="ws-muted">The layout is kept in this browser.</p>
          <IdeaSchedule />
        </div>
      )}
    </header>
  );
}

