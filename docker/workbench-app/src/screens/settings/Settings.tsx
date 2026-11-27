// Screen: Settings (rwr-settings-shell). One frame for every setting: the privacy stance, the tags legend, a list of
// sections (Yours, and Admin only when the SERVER says this person is an admin) and, for the chosen section, one row per
// setting - what it is, who can see it (its tag), and a control that saves as you go ("Saved"). The sections themselves
// (appearance, defaults, notifications, ...) are later items; this is the frame and whatever keys the registry holds.
// Nothing is kept in the browser: the account holds every value, so another browser shows the same.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import "./settings.css";
import { Link } from "../../shell/Link";
import {
  HIDDEN_SUGGESTIONS, LEGEND, TAG_LABEL, applyPreset, loadLimits, loadLog, loadSettings, numberProblem, resetGroup, resetSetting, saveSetting, sectionsOf, show,
  type Loaded, type LimitGroup, type LogLine, type Section, type Setting,
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

// the highest a number field takes: the registry's max, or the admin's ceiling when that is lower
const maxOf = (r: Setting): number | undefined => {
  const hi = [r.validation?.max, r.ceiling].filter((x): x is number => typeof x === "number");
  return hi.length ? Math.min(...hi) : undefined;
};

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

// The control for one setting. A text or number field saves when you leave it or press Enter; a switch and a choice save
// at once. A value the server refuses is shown with the server's own words and the field goes back to what is stored.
// `epoch` reads which person this screen is for right now: a save answer that lands after the person changed is dropped
// (the earlier person's value is never shown to the next one).
function Field({ row, onRow, onStale, epoch }: { row: Setting; onRow: (r: Setting) => void; onStale: () => void; epoch: () => number }) {
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
    const mine = epoch();
    const r = await run();
    if (mine !== epoch()) return; // the person changed while this was in flight: nothing of it is shown
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
  }, [effective, onRow, onStale, epoch]);

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
      // the server's own rules, in its words, before anything is sent (it judges again, and its answer is the one that counts)
      const why = numberProblem(row, n);
      if (why) { setStatus({ kind: "error", message: `Not saved: ${row.key}: ${why}` }); setDraft(effective === null || effective === undefined ? "" : String(effective)); return; }
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
    // a short fixed list of choices is a set of radio buttons (segmented), never a native <select> (one-picker rule)
    const options = Array.isArray(row.validation?.enum) ? (row.validation.enum as string[]) : [];
    const chosen = row.is_default ? "" : String(row.value);
    const choices: Array<[string, string]> = [["", `Default (${show(row.default)})`], ...options.map((o): [string, string] => [o, o])];
    control = (
      <div role="radiogroup" aria-labelledby={id + "-l"} className="seg" data-testid="control">
        {choices.map(([v, text]) => (
          <label key={v || "default"} className={"seg-o" + (chosen === v ? " on" : "")}>
            <input type="radio" name={id} value={v} checked={chosen === v} disabled={busy}
              onChange={() => (v === "" ? reset() : save(v))} />
            <span>{text}</span>
          </label>
        ))}
      </div>
    );
  } else {
    const num = row.type === "integer" || row.type === "number";
    control = (
      <input id={id} data-testid="control" disabled={busy}
        type={num ? "number" : row.type === "time" ? "time" : "text"}
        min={num ? (row.validation?.min as number | undefined) : undefined}
        max={num ? maxOf(row) : undefined}
        step={row.type === "number" ? "any" : undefined}
        maxLength={row.type === "string" ? (row.validation?.max_len as number | undefined) ?? 200 : undefined}
        value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={onKey} />
    );
  }

  return (
    <div className="srow" data-testid={"setting-" + row.key} data-key={row.key}>
      <div className="s-main">
        <label className="s-label" id={id + "-l"} htmlFor={editable && row.type !== "enum" ? id : undefined}>{row.label}</label>
        {row.help && <p className="meta">{row.help}</p>}
        <p className="meta">{row.is_default ? `Using the default: ${show(row.default)}` : (row.tier === "admin" ? "Set by an admin" : "Set by you")}</p>
        {typeof row.ceiling === "number" && (
          <p className="meta" data-testid={"ceiling-" + row.key}>
            Highest allowed: {row.ceiling}{row.ceiling_phrase ? ` (${row.ceiling_phrase})` : ""}.
            {!row.is_default && typeof row.value === "number" && row.value > row.ceiling ? ` Your saved value is above it, so runs use ${row.ceiling}.` : ""}
          </p>
        )}
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

// Hidden suggestions are app state (a list of identifiers the Library writes as you hide things); here a person sees how many are
// hidden and can show them all again. The count is the stored list's length, never its contents.
function HiddenSuggestions({ row, onRow, onStale, epoch }: { row: Setting; onRow: (r: Setting) => void; onStale: () => void; epoch: () => number }) {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const n = row.is_default || !Array.isArray(row.value) ? 0 : row.value.length;
  const showAgain = async () => {
    setStatus({ kind: "saving" });
    const mine = epoch();
    const r = await resetSetting(row);
    if (mine !== epoch()) return;
    if (r.ok) { onRow(r.row); setStatus({ kind: "saved" }); }
    else if (r.status === 409) { setStatus({ kind: "error", message: "Changed on another browser. Showing the latest value." }); onStale(); }
    else setStatus({ kind: "error", message: `Not saved: ${r.message}` });
  };
  return (
    <div className="srow" data-testid={"setting-" + row.key} data-key={row.key}>
      <div className="s-main">
        <span className="s-label">{row.label}</span>
        <p className="meta" data-testid="hidden-count">{n === 0 ? "None hidden." : `${n} hidden.`}</p>
      </div>
      <div className="s-side">
        <TagChip tag={row.tag} />
        <div className="s-ctl">
          <button type="button" disabled={n === 0 || status.kind === "saving"} onClick={() => void showAgain()} data-testid="hidden-show-again">Show them again</button>
        </div>
        <div className="s-state">
          <span role="status" aria-live="polite" className="saved" data-testid={"saved-" + row.key}>{status.kind === "saved" ? "Saved" : ""}</span>
          {status.kind === "error" && <span role="alert" className="err" data-testid={"error-" + row.key}>{status.message}</span>}
        </div>
      </div>
    </div>
  );
}

const when = (t: string) => t.replace("T", " ").replace(/(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?$/, "");
const showValue = (v: unknown) => (v === null || v === undefined ? "nothing stored" : String(v));

// Admin only: the research limits as named presets, never a number typed in. Each group (how big a run is, how strict it is about
// evidence, how claims are filed) is a set of radio choices; the server writes the preset's values inside their fixed ranges and
// logs the change (who, what, old, new). A person change while a call is in flight drops its answer (epoch).
function LimitsPanel({ epoch }: { epoch: () => number }) {
  const [groups, setGroups] = useState<LimitGroup[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [log, setLog] = useState<LogLine[] | null>(null);
  const [logFailed, setLogFailed] = useState(false);

  const load = useCallback(() => {
    const mine = epoch();
    setFailed(false);
    loadLimits().then((g) => { if (mine === epoch()) setGroups(g); }, () => { if (mine === epoch()) setFailed(true); });
  }, [epoch]);
  useEffect(() => { load(); }, [load]);

  const run = async (g: LimitGroup, preset: string | null) => {
    if (busy) return;
    setBusy(g.group);
    setMsg((m) => ({ ...m, [g.group]: "" }));
    const mine = epoch();
    const r = preset === null ? await resetGroup(g.group) : await applyPreset(g.group, preset);
    if (mine !== epoch()) return; // the person changed: nothing of this answer is shown
    setBusy(null);
    if (r.ok) {
      setGroups((all) => (all ?? []).map((x) => (x.group === g.group ? r.group : x)));
      setMsg((m) => ({ ...m, [g.group]: "Saved" }));
      if (log !== null) showLog();
    } else setMsg((m) => ({ ...m, [g.group]: `Not saved: ${r.message}` }));
  };
  const showLog = () => {
    const mine = epoch();
    setLogFailed(false);
    loadLog().then((l) => { if (mine === epoch()) setLog(l); }, () => { if (mine === epoch()) setLogFailed(true); });
  };
  const label = (k: string) => (groups ?? []).flatMap((g) => g.values).find((v) => v.key === k)?.label ?? k;

  if (failed) return <p className="meta" data-testid="limits-failed">Could not load the research limits. <button type="button" onClick={load}>Try again</button></p>;
  if (groups === null) return <p className="meta" role="status" data-testid="limits-loading">Loading the research limits...</p>;
  return (
    <div data-testid="limits">
      <p className="meta">These are the dials of every research run and of the curator, for everyone. Pick a preset; every change is written to the log below.</p>
      {groups.map((g) => (
        <div className="srow limits-group" key={g.group} data-testid={"limits-" + g.group} data-current={g.current}>
          <div className="s-main">
            <span className="s-label" id={"lg-" + g.group}>{g.label}</span>
            <p className="meta">{g.help}</p>
            <p className="meta" data-testid={"limits-now-" + g.group}>
              {g.current === "custom" ? "In force: values no preset names (a custom setting)." : `In force: ${g.presets.find((p) => p.preset === g.current)?.label ?? g.current}.`}
              {" "}{g.values.map((v) => `${v.label}: ${show(v.value)}${v.is_default ? " (the server's own)" : ""}`).join("; ")}
            </p>
          </div>
          <div className="s-side">
            <TagChip tag="admin_all" />
            <div className="s-ctl">
              <div role="radiogroup" aria-labelledby={"lg-" + g.group} className="seg" data-testid={"limits-choice-" + g.group}>
                {g.presets.map((p) => (
                  <label key={p.preset} className={"seg-o" + (g.current === p.preset ? " on" : "")} title={p.help}>
                    <input type="radio" name={"lg-" + g.group} value={p.preset} checked={g.current === p.preset} disabled={busy !== null}
                      onChange={() => void run(g, p.preset)} data-testid={`preset-${g.group}-${p.preset}`} />
                    <span>{p.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="s-state">
              <span role="status" aria-live="polite" className="saved" data-testid={"limits-saved-" + g.group}>{msg[g.group] === "Saved" ? "Saved" : ""}</span>
              {msg[g.group] && msg[g.group] !== "Saved" && <span role="alert" className="err" data-testid={"limits-error-" + g.group}>{msg[g.group]}</span>}
              <button type="button" className="link" disabled={busy !== null} onClick={() => void run(g, null)} data-testid={"limits-reset-" + g.group}>Use the server's own values</button>
            </div>
          </div>
        </div>
      ))}
      <div className="srow" data-testid="limits-log">
        <div className="s-main">
          <span className="s-label">Who changed what</span>
          {log === null && !logFailed && <p className="meta"><button type="button" onClick={showLog} data-testid="log-show">Show the latest changes</button></p>}
          {logFailed && <p className="meta" role="alert" data-testid="log-failed">Could not read the log. <button type="button" onClick={showLog}>Try again</button></p>}
          {log !== null && log.length === 0 && <p className="meta" data-testid="log-empty">No change has been made yet.</p>}
          {log !== null && log.length > 0 && (
            <ul className="log" data-testid="log-list">
              {log.map((l) => (
                <li key={l.id} data-testid="log-line">
                  {when(l.at)}: {l.actor} {l.action === "clear" ? "went back to the server's own value for" : "set"} {label(l.key)}
                  {l.action === "clear" ? ` (was ${showValue(l.old_value)})` : `: ${showValue(l.old_value)} to ${showValue(l.new_value)}`}
                  {l.preset && l.group ? ` (preset ${l.preset})` : ""}
                </li>
              ))}
            </ul>
          )}
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
  const person = useRef(0); // bumped when the signed-in person changes: an answer to a save made for the earlier one is dropped
  const epoch = useCallback(() => person.current, []);

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
    return () => { turn.current++; person.current++; };
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
                {current.tier === "admin" && current.section === "research" && <LimitsPanel key={current.id} epoch={epoch} />}
                {current.keys.filter(() => !(current.tier === "admin" && current.section === "research")).map((k) => (
                  k.key === HIDDEN_SUGGESTIONS
                    ? <HiddenSuggestions key={k.key} row={k} onRow={onRow} onStale={load} epoch={epoch} />
                    : <Field key={k.key} row={k} onRow={onRow} onStale={load} epoch={epoch} />
                ))}
              </>
            ) : <p className="empty" data-testid="settings-empty">There are no settings to show yet. <Link to="/">Back to Home</Link></p>}
          </div>
        </div>
      )}
    </section>
  );
}
