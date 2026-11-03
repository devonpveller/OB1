// The Settings panel (research-workbench rw-settings-store, plan 08 PD3; operator 2026-11-03: "it should just be a
// panel like everything else"). A regular workspace panel - opened from the title bar's Settings button into the
// dock, dockable and kept in the layout like every other - replacing the old floating popover. It is the one place
// a user changes their own settings and an admin the shared ones:
//   * the layout: "Reset the layout" (the action the popover held)
//   * Start research on my ideas - the idea-research schedule, moved in unchanged (IdeaSchedule.tsx)
//   * My idea refinery / My digest and podcast - the user tier: GET/PUT/DELETE /workbench/settings[/:key],
//     always the signed-in subject's own (the workbench decides whose; this panel sends no user)
//   * Admin - shown only when the workbench says this user is an admin: the shared settings
//     (/workbench/settings/admin), research tuning listed read-only
// Side-panel at-rest rule (D1): every section opens on its summary; nothing actionable shows until one is opened.
import { type ReactNode, useEffect, useState } from "react";
import { ApiError, api, get, q } from "../../lib/api";
import { clearLayout, defaultLayout } from "../../shell/dock";
import { registerPanel, type PanelProps } from "../../shell/registry";
import { IdeaSchedule } from "./IdeaSchedule";

export const S = "/workbench/settings";

export interface Setting {
  key: string;
  tier: "user" | "admin";
  type: string;
  section: string;
  position: number;
  label: string;
  help: string;
  default: unknown;
  env: string | null;
  read_by: string;
  validation: Record<string, unknown>;
  editable: boolean;
  value: unknown;
  is_default: boolean;
  version: number;
  resolved?: { path: string | null; reachable?: boolean; via: string };
}
interface Team {
  id: string;
  name: string;
  presenters?: { name: string }[];
}

const errText = (e: unknown) => e instanceof ApiError ? String(e.body?.error ?? e.message) : String((e as Error).message);
const show = (v: unknown) => v === null || v === undefined ? "none" : typeof v === "object" ? JSON.stringify(v) : String(v);

function Section(p: { id: string; title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ws-disclosure ws-settings-section" data-section={p.id} data-open={open ? "1" : "0"}>
      <button type="button" className="ws-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ws-caret">{open ? "▾" : "▸"}</span> {p.title}
      </button>
      {open && <div className="ws-settings-body">{p.children}</div>}
    </div>
  );
}

// One setting: its control, Save and "Use the default". `url` is where it is written (mine, or the admin tier).
function Field(p: { s: Setting; url: string; teams?: Team[]; onSaved: (s: Setting) => void }) {
  const { s } = p;
  const initial = s.value ?? s.default;
  const [draft, setDraft] = useState<string>(s.type === "destination" ? JSON.stringify(initial ?? {}) : initial === null || initial === undefined ? "" : String(initial));
  const [msg, setMsg] = useState("");
  useEffect(() => {
    const v = s.value ?? s.default;
    setDraft(s.type === "destination" ? JSON.stringify(v ?? {}) : v === null || v === undefined ? "" : String(v));
  }, [s.value, s.default, s.type]);
  const parse = (): unknown => {
    if (s.type === "boolean") return draft === "true";
    if (s.type === "integer") return draft.trim() === "" ? NaN : Number(draft);
    if (s.type === "number") return draft.trim() === "" ? NaN : Number(draft);
    if (s.type === "destination") return JSON.parse(draft);
    return draft;
  };
  const save = async () => {
    let value: unknown;
    try {
      value = parse();
    } catch {
      setMsg("not valid JSON");
      return;
    }
    try {
      const r = await api<Setting>("PUT", `${p.url}/${q(s.key)}`, { value });
      p.onSaved(r.data);
      setMsg("saved - read on the service's next run");
    } catch (e) {
      setMsg(errText(e));
    }
  };
  const reset = async () => {
    try {
      const r = await api<Setting>("DELETE", `${p.url}/${q(s.key)}`);
      p.onSaved(r.data);
      setMsg("back to the default");
    } catch (e) {
      setMsg(errText(e));
    }
  };
  const id = `set-${s.key}`;
  const v = s.validation ?? {};
  let control: ReactNode;
  if (!s.editable) {
    control = <output data-field={s.key}>{show(s.value ?? s.default)}</output>;
  } else if (s.type === "boolean") {
    control = <input id={id} data-field={s.key} type="checkbox" checked={draft === "true"} onChange={(e) => setDraft(e.target.checked ? "true" : "false")} />;
  } else if (s.type === "integer" || s.type === "number") {
    control = (
      <input id={id} data-field={s.key} type="number" step={s.type === "integer" ? 1 : 0.01}
        min={v.min as number | undefined} max={v.max as number | undefined} value={draft} onChange={(e) => setDraft(e.target.value)} />
    );
  } else if (s.type === "time") {
    control = <input id={id} data-field={s.key} type="time" value={draft} onChange={(e) => setDraft(e.target.value)} />;
  } else if (v.ref === "podcast_team") {
    control = (
      <select id={id} data-field={s.key} value={draft} onChange={(e) => setDraft(e.target.value)}>
        <option value="">{s.env ? `(the default: ${s.env})` : "(none)"}</option>
        {(p.teams ?? []).map((t) => (
          <option key={t.id} value={t.id}>{t.name}{t.presenters?.length ? ` - ${t.presenters.map((x) => x.name).join(", ")}` : ""}</option>
        ))}
        {draft && !(p.teams ?? []).some((t) => t.id === draft || t.name === draft) && <option value={draft}>{draft}</option>}
      </select>
    );
  } else {
    control = <input id={id} data-field={s.key} value={draft} onChange={(e) => setDraft(e.target.value)} />;
  }
  return (
    <div className="ws-setting" data-setting={s.key} data-default={s.is_default ? "1" : "0"}>
      <label htmlFor={id}>{s.label}</label>{" "}{control}
      {s.editable && (
        <>
          {" "}<button type="button" data-action="save-setting" data-key={s.key} onClick={save}
            disabled={v.ref === "podcast_team" && draft === ""}>Save</button>
          {!s.is_default && <button type="button" data-action="reset-setting" data-key={s.key} onClick={reset}>Use the default</button>}
        </>
      )}
      {s.help && <p className="ws-muted">{s.help}</p>}
      <p className="ws-muted" data-testid={`setting-default-${s.key}`}>
        {s.is_default ? "Using the default" : "Yours"}: default {show(s.default)}{s.env ? ` (the service's ${s.env} may override it)` : ""}. Read by {s.read_by}.
        {s.resolved && <> Resolves to {s.resolved.path ?? "nothing"}{s.resolved.reachable === false ? " (not reachable from the workbench)" : ""}.</>}
      </p>
      {msg && <p className="ws-muted" data-testid={`setting-msg-${s.key}`}>{msg}</p>}
    </div>
  );
}

function UserSection(p: { section: string; settings: Setting[]; teams: Team[]; onSaved: (s: Setting) => void; extra?: ReactNode }) {
  const mine = p.settings.filter((s) => s.section === p.section).sort((a, b) => a.position - b.position);
  return (
    <div data-testid={`settings-${p.section}`}>
      {mine.map((s) => <Field key={s.key} s={s} url={S} teams={p.teams} onSaved={p.onSaved} />)}
      {mine.length === 0 && <p className="ws-muted">Nothing to set here yet.</p>}
      {p.extra}
    </div>
  );
}

function AdminSection() {
  const [rows, setRows] = useState<Setting[] | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let live = true;
    get<{ settings: Setting[] }>(`${S}/admin`).then((r) => live && setRows(r.settings)).catch((e) => live && setMsg(errText(e)));
    return () => {
      live = false;
    };
  }, []);
  const saved = (n: Setting) => setRows((rs) => (rs ?? []).map((r) => r.key === n.key ? { ...r, ...n } : r));
  if (!rows) return <p className="ws-muted" data-testid="settings-admin-msg">{msg || "loading"}</p>;
  const editable = rows.filter((r) => r.editable);
  const tuning = rows.filter((r) => !r.editable);
  return (
    <div data-testid="settings-admin">
      <p className="ws-muted">Shared by everyone: only an admin changes these.</p>
      {editable.map((s) => <Field key={s.key} s={s} url={`${S}/admin`} onSaved={saved} />)}
      <table className="ws-settings-tuning" data-testid="settings-research-tuning">
        <caption>Research tuning (read-only here; each service's env is where it is set)</caption>
        <thead><tr><th>Setting</th><th>Default</th><th>Env</th><th>Read by</th></tr></thead>
        <tbody>
          {tuning.map((s) => (
            <tr key={s.key} data-setting={s.key}><td>{s.label}</td><td>{show(s.value ?? s.default)}</td><td>{s.env ?? ""}</td><td>{s.read_by}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SettingsPanel(_p: PanelProps) {
  const [settings, setSettings] = useState<Setting[]>([]);
  const [admin, setAdmin] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let live = true;
    get<{ admin: boolean; settings: Setting[] }>(S)
      .then((r) => {
        if (!live) return;
        setSettings(r.settings ?? []);
        setAdmin(r.admin === true);
      })
      .catch((e) => live && setMsg(errText(e)));
    // the user's own podcast teams, for the team choice (the contract's teams(): the caller's only)
    get<{ teams: Team[] }>("/workbench/contract/teams").then((r) => live && setTeams(r.teams ?? [])).catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const saved = (n: Setting) => setSettings((ss) => ss.map((s) => s.key === n.key ? { ...s, ...n } : s));
  return (
    <div className="ws-settings" data-testid="settings-panel">
      <div className="ws-settings-layout">
        <button type="button" data-testid="reset-layout" onClick={() => { clearLayout(); defaultLayout(); }}>Reset the layout</button>
        <p className="ws-muted">The layout is kept in this browser.</p>
      </div>
      <Section id="schedule" title="Start research on my ideas">
        <IdeaSchedule />
      </Section>
      <Section id="refinery" title="My idea refinery">
        <UserSection section="refinery" settings={settings} teams={teams} onSaved={saved} />
      </Section>
      <Section id="digest" title="My digest and podcast">
        <UserSection section="digest" settings={settings} teams={teams} onSaved={saved}
          extra={<p className="ws-muted" data-testid="settings-archive-note">The podcast archive destination is shared by everyone{admin ? ": set it under Admin." : " and set by an admin."}</p>} />
      </Section>
      {admin && (
        <Section id="admin" title="Admin: shared settings">
          <AdminSection />
        </Section>
      )}
      {msg && <p className="ws-muted" data-testid="settings-msg">{msg}</p>}
    </div>
  );
}

// opened from the title bar (no left-nav entry: Settings is not a research area)
registerPanel({ id: "settings", version: 1, title: "Settings", kind: "side", component: SettingsPanel, position: "right" });
