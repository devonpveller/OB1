// Screen: Settings (rwr-settings-shell). One frame for every setting: the privacy stance, the tags legend, a list of
// sections (Yours, and Admin only when the SERVER says this person is an admin) and, for the chosen section, one row per
// setting - what it is, who can see it (its tag), and a control that saves as you go ("Saved"). The sections themselves
// (appearance, defaults, notifications, ...) are later items; this is the frame and whatever keys the registry holds.
// Nothing is kept in the browser: the account holds every value, so another browser shows the same.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import "./settings.css";
import { Link } from "../../shell/Link";
import {
  LEGEND, TAG_LABEL, loadSettings, resetSetting, saveSetting, sectionsOf, show,
  type Loaded, type Section, type Setting,
} from "./settings-data";

type Mode = { state: "loading" } | { state: "failed" } | { state: "ok"; data: Loaded };

function TagChip({ tag }: { tag: string | null }) {
  const known = tag !== null && tag in TAG_LABEL;
  return (
    <span className={"tag tag-" + (known ? tag : "none")} data-testid="tag" data-tag={tag ?? "none"}>
      {known ? TAG_LABEL[tag!] : "No tag"}
    </span>
  );
}

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

// The control for one setting. A text or number field saves when you leave it or press Enter; a switch and a choice save
// at once. A value the server refuses is shown with the server's own words and the field goes back to what is stored.
function Field({ row, onRow, onStale }: { row: Setting; onRow: (r: Setting) => void; onStale: () => void }) {
  const id = useId();
  const effective = row.is_default ? row.default : row.value;
  const [draft, setDraft] = useState(effective === null || effective === undefined ? "" : String(effective));
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const editable = row.editable && ["boolean", "integer", "number", "time", "enum", "string"].includes(row.type);

  // the stored value changed under us (a reload, a save): the field shows it
  useEffect(() => {
    setDraft(effective === null || effective === undefined ? "" : String(effective));
  }, [row.version, row.is_default]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = useCallback(async (run: () => Promise<Awaited<ReturnType<typeof saveSetting>>>) => {
    setStatus({ kind: "saving" });
    const r = await run();
    if (r.ok) {
      onRow(r.row);
      setStatus({ kind: "saved" });
    } else if (r.status === 409) {
      setStatus({ kind: "error", message: "Changed on another browser. Showing the latest value." });
      onStale();
    } else {
      setStatus({ kind: "error", message: `Not saved: ${r.message}` });
      setDraft(effective === null || effective === undefined ? "" : String(effective));
    }
  }, [effective, onRow, onStale]);

  const save = (value: unknown) => void apply(() => saveSetting(row, value));
  const reset = () => void apply(() => resetSetting(row));
  const busy = status.kind === "saving";

  const commit = () => {
    if (busy) return;
    const t = draft.trim();
    if (t === (effective === null || effective === undefined ? "" : String(effective))) return;
    if (t === "") { if (!row.is_default) reset(); else setDraft(""); return; }
    if (row.type === "integer" || row.type === "number") {
      const n = Number(t);
      if (!Number.isFinite(n)) { setStatus({ kind: "error", message: "Not saved: enter a number." }); return; }
      save(n);
    } else save(t);
  };
  const onKey = (e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); commit(); } };

  let control: React.ReactNode;
  if (!editable) {
    control = <span className="ro" data-testid="readonly">{show(effective)}{row.is_default ? " (default)" : ""}</span>;
  } else if (row.type === "boolean") {
    control = (
      <input id={id} type="checkbox" checked={effective === true} disabled={busy} data-testid="control"
        onChange={(e) => save(e.target.checked)} />
    );
  } else if (row.type === "enum") {
    const options = Array.isArray(row.validation?.enum) ? (row.validation.enum as string[]) : [];
    control = (
      <select id={id} value={row.is_default ? "" : String(row.value)} disabled={busy} data-testid="control"
        onChange={(e) => (e.target.value === "" ? reset() : save(e.target.value))}>
        <option value="">Default ({show(row.default)})</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else {
    const num = row.type === "integer" || row.type === "number";
    control = (
      <input id={id} data-testid="control" disabled={busy}
        type={num ? "number" : row.type === "time" ? "time" : "text"}
        min={num ? (row.validation?.min as number | undefined) : undefined}
        max={num ? (row.validation?.max as number | undefined) : undefined}
        step={row.type === "number" ? "any" : undefined}
        maxLength={row.type === "string" ? (row.validation?.max_len as number | undefined) ?? 200 : undefined}
        value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={onKey} />
    );
  }

  return (
    <div className="srow" data-testid={"setting-" + row.key} data-key={row.key}>
      <div className="s-main">
        <label className="s-label" htmlFor={editable ? id : undefined}>{row.label}</label>
        {row.help && <p className="meta">{row.help}</p>}
        <p className="meta">{row.is_default ? `Using the default: ${show(row.default)}` : (row.tier === "admin" ? "Set by an admin" : "Set by you")}</p>
      </div>
      <div className="s-side">
        <TagChip tag={row.tag} />
        <div className="s-ctl">{control}</div>
        <div className="s-state">
          <span role="status" aria-live="polite" className="saved" data-testid={"saved-" + row.key}>
            {status.kind === "saving" ? "Saving..." : status.kind === "saved" ? "Saved" : ""}
          </span>
          {status.kind === "error" && <span role="alert" className="err" data-testid={"error-" + row.key}>{status.message}</span>}
          {editable && !row.is_default && !busy && <button type="button" className="link" onClick={reset}>Back to default</button>}
        </div>
      </div>
    </div>
  );
}

// `subject` is who the shell says is on the page: the screen reads once that is known, and again for a different person
// (the earlier person's answer, if it lands late, is dropped, never shown to the next one).
export function Settings({ subject = null, whoAnswered = true }: { subject?: string | null; whoAnswered?: boolean }) {
  const [mode, setMode] = useState<Mode>({ state: "loading" });
  const [sel, setSel] = useState<string | null>(null);
  const turn = useRef(0);

  const load = useCallback(() => {
    const mine = ++turn.current;
    loadSettings().then(
      (data) => { if (mine === turn.current) setMode({ state: "ok", data }); },
      () => { if (mine === turn.current) setMode({ state: "failed" }); },
    );
  }, []);
  useEffect(() => {
    if (!whoAnswered) return;
    setMode({ state: "loading" });
    setSel(null);
    load();
    return () => { turn.current++; };
  }, [subject, whoAnswered, load]);

  const onRow = useCallback((r: Setting) => {
    setMode((m) => m.state !== "ok" ? m : {
      state: "ok",
      data: {
        ...m.data,
        user: m.data.user.map((s) => (s.key === r.key ? r : s)),
        shared: m.data.shared.map((s) => (s.key === r.key ? r : s)),
      },
    });
  }, []);

  const data = mode.state === "ok" ? mode.data : null;
  const yours: Section[] = data ? sectionsOf("user", data.user) : [];
  const admins: Section[] = data && data.admin ? sectionsOf("admin", data.shared) : [];
  const all = [...yours, ...admins];
  const current = all.find((s) => s.id === sel) ?? all[0] ?? null;

  return (
    <section className="screen settings" data-testid="settings" aria-labelledby="h-settings">
      <h1 id="h-settings">Settings</h1>

      <div className="card stance" data-testid="stance">
        <h2>Who can see your settings</h2>
        <p>
          Your own settings are kept with your account on this server, so every browser you sign in on shows the same values.
          They are shown only to you. Every setting below says who can see it with a tag, explained here.
        </p>
        <p>
          Some settings are one value for everybody. An admin changes those, they are marked as such, and they appear on this
          screen only for an admin.
        </p>
        <ul className="legend" data-testid="legend" aria-label="What each tag means">
          {LEGEND.map((l) => (
            <li key={l.tag} data-testid={"legend-" + l.tag}><span className={"tag tag-" + l.tag}>{l.label}</span> <span className="meta">{l.means}</span></li>
          ))}
        </ul>
      </div>

      {mode.state === "loading" && <p className="meta" role="status" data-testid="settings-loading">Loading your settings...</p>}
      {mode.state === "failed" && (
        <p className="meta" data-testid="settings-failed">Could not load your settings. <button type="button" onClick={() => { setMode({ state: "loading" }); load(); }}>Try again</button></p>
      )}

      {data && (
        <div className="frame-s">
          <nav className="snav" aria-label="Settings sections" data-testid="snav">
            <h2 className="gh">Yours</h2>
            <ul>
              {yours.map((s) => (
                <li key={s.id}>
                  <button type="button" data-testid={"sec-" + s.id} aria-current={current?.id === s.id ? "page" : undefined} onClick={() => setSel(s.id)}>{s.title}</button>
                </li>
              ))}
            </ul>
            {admins.length > 0 && (
              <>
                <h2 className="gh" data-testid="admin-heading">Admin only</h2>
                <ul>
                  {admins.map((s) => (
                    <li key={s.id}>
                      <button type="button" data-testid={"sec-" + s.id} aria-current={current?.id === s.id ? "page" : undefined} onClick={() => setSel(s.id)}>{s.title}</button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </nav>
          <div className="card spanel" data-testid="spanel" aria-labelledby="h-section">
            {current ? (
              <>
                <h2 id="h-section" data-testid="section-title">{current.title}</h2>
                {current.tier === "admin" && <p className="meta">These settings are one value for everybody.</p>}
                {current.keys.map((k) => (
                  <Field key={k.key} row={k} onRow={onRow} onStale={load} />
                ))}
              </>
            ) : <p className="empty" data-testid="settings-empty">There are no settings to show yet. <Link to="/">Back to Home</Link></p>}
          </div>
        </div>
      )}
    </section>
  );
}
