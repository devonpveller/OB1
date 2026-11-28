// Cast and voices (rwr-voices), "Mine": the signed-in person's own presenters, teams and formats, with an editor for each, the
// voice picker (Kokoro voices) and speed, a sample play, a "pitch is not available" note, notes that can be moved into the
// profile, and the Untested marker. Everything is for ONE known subject: the screen lives under a key made of the last known
// subject, so a different person on the page drops the lists, the open editor, an unsaved draft, a delete in progress and a
// sample that is playing. A presenter's, team's or format's text is shown here and nowhere else: not in the page title, the URL,
// a toast or the browser storage.
//
// Stored or not shown: every field here is one the server stores (schemas/cast.ts). There is no model route (phase J) and no
// pitch control (the voice engine has none: a plain note says so). Not shown because not built: sharing (rwr-cast-share),
// generating a presenter (rwr-cast-generate) and the audition that clears Untested (rwr-cast-audition).
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { TypedConfirm } from "../../shell/TypedConfirm";
import {
  createFormat, createPresenter, createTeam, createVoice, DEFAULT_ROUTE, deleteFormat, deletePresenter, deleteTeam, deleteVoice, fetchSample, FORMAT_KINDS,
  FORMAT_USES, KOKORO_VOICES, MAX_SEATS, readFormats, readPresenters, readTeams, readVoices, SPEED_MAX, SPEED_MIN, updateFormat, updatePresenter, updateTeam,
  updateVoice, type Format, type Listed, type Presenter, type PresenterFields, type Result, type Team, type Voice,
} from "./voices-data";
import "./voices.css";

type Tab = "presenters" | "teams" | "formats";
const TABS: { key: Tab; label: string; one: string }[] = [
  { key: "presenters", label: "Presenters", one: "presenter" }, { key: "teams", label: "Teams", one: "team" }, { key: "formats", label: "Formats", one: "format" },
];
type Load<T> = { state: "loading" } | { state: "failed" } | { state: "ok"; data: Listed<T> };

export function Voices({ subject, whoAnswered, onRetry = () => window.location.reload() }: { subject: string | null; whoAnswered: boolean; onRetry?: () => void }) {
  const last = useRef<string | null>(null);
  if (subject) last.current = subject;
  const known = subject ?? last.current;
  if (!known) {
    return (
      <div className="screen voices" data-testid="voices">
        <h1 className="sr-only">Cast and voices</h1>
        {whoAnswered
          ? <p className="meta" data-testid="voices-failed-who">Could not tell who you are, so nothing is shown. <button type="button" onClick={onRetry}>Try again</button></p>
          : <p className="meta" role="status" data-testid="voices-waiting">Checking who you are...</p>}
      </div>
    );
  }
  return <VoicesScreen key={known} />;
}

// One list: loads on mount, and again on reload(); a failed RE-read keeps what is on screen (never an empty list).
function useList<T>(read: () => Promise<Listed<T>>): [Load<T>, () => void] {
  const [s, setS] = useState<Load<T>>({ state: "loading" });
  const live = useRef(true);
  const go = useCallback(() => {
    read().then(
      (data) => { if (live.current) setS({ state: "ok", data }); },
      () => { if (live.current) setS((x) => (x.state === "ok" ? x : { state: "failed" })); },
    );
  }, [read]);
  useEffect(() => { live.current = true; go(); return () => { live.current = false; }; }, [go]);
  return [s, go];
}

type Ctx = { voices: Voice[]; presenters: Presenter[]; teams: Team[]; formats: Format[]; reload: () => void };

function VoicesScreen() {
  const [tab, setTab] = useState<Tab>("presenters");
  const [vs, reloadV] = useList(readVoices);
  const [ps, reloadP] = useList(readPresenters);
  const [ts, reloadT] = useList(readTeams);
  const [fs, reloadF] = useList(readFormats);
  const [sel, setSel] = useState<string | null>(null); // a row id, "new", or null = the first row
  const [nonce, setNonce] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);
  const reload = useCallback(() => { reloadV(); reloadP(); reloadT(); reloadF(); }, [reloadV, reloadP, reloadT, reloadF]);

  const all = [vs, ps, ts, fs];
  const loading = ps.state === "loading" && !all.some((x) => x.state === "failed");
  const failed = all.some((x) => x.state === "failed");
  const ok = (l: Load<any>) => (l.state === "ok" ? l.data.rows : []);
  const ctx: Ctx = { voices: ok(vs), presenters: ok(ps), teams: ok(ts), formats: ok(fs), reload };
  const cur = tab === "presenters" ? ps : tab === "teams" ? ts : fs;
  const rows: { id: string; name: string; meta: string[] }[] = tab === "presenters"
    ? ctx.presenters.map((p) => ({ id: p.id, name: p.name, meta: [p.role || "no role", "Untested", p.teams.length ? `in ${p.teams.length} team${p.teams.length === 1 ? "" : "s"}` : "in no team"] }))
    : tab === "teams"
      ? ctx.teams.map((t) => ({ id: t.id, name: t.name, meta: [`${t.members.length} presenter${t.members.length === 1 ? "" : "s"} and you`, t.formats.length ? `${t.formats.length} format${t.formats.length === 1 ? "" : "s"}` : "no formats"] }))
      : ctx.formats.map((f) => ({ id: f.id, name: f.name, meta: [FORMAT_KINDS.find((k) => k.key === f.kind)?.label ?? f.kind, f.isDefault ? "your default" : "", f.teamName].filter(Boolean) }));
  const openId = sel === "new" ? "new" : sel && rows.some((r) => r.id === sel) ? sel : rows[0]?.id ?? null;
  const total = cur.state === "ok" ? cur.data.total : 0;
  const one = TABS.find((t) => t.key === tab)!.one;

  const [flash, setFlash] = useState<string | null>(null); // the row just saved: its editor opens with the "Saved" line
  const choose = (id: string | null) => { setConfirming(null); setFlash(null); setSel(id); };
  const onSaved = (id: string) => { setConfirming(null); setFlash(id); setSel(id); reload(); };
  const onGone = () => { setConfirming(null); setFlash(null); setSel(null); reload(); };
  const pRow = ctx.presenters.find((p) => p.id === openId), tRow = ctx.teams.find((t) => t.id === openId), fRow = ctx.formats.find((f) => f.id === openId);
  // a row just made is opened once the lists have been read again (until then there is nothing to open)
  const waiting = openId !== null && openId !== "new" && !(tab === "presenters" ? pRow : tab === "teams" ? tRow : fRow);

  return (
    <div className="screen voices" data-testid="voices">
      <div className="voices-head">
        <h1>Cast and voices</h1>
        <span className="meta">Mine: only you see your presenters, teams and formats. What you save here is what the next episode uses.</span>
      </div>
      {loading && <p className="meta" role="status" data-testid="voices-loading">Loading your cast...</p>}
      {failed && (
        <p className="meta" data-testid="voices-failed">Could not load all of your cast. <button type="button" onClick={() => { setConfirming(null); reload(); }}>Try again</button></p>
      )}
      {!loading && (
        <>
          <div role="tablist" aria-label="What to edit" className="vtabs">
            {TABS.map((t) => {
              const l = t.key === "presenters" ? ps : t.key === "teams" ? ts : fs;
              return (
                <button key={t.key} type="button" role="tab" id={"tab-" + t.key} aria-selected={tab === t.key} aria-controls="vpanel" data-testid={"tab-" + t.key}
                  className={"vtab" + (tab === t.key ? " on" : "")} onClick={() => { setTab(t.key); choose(null); }}>
                  {t.label}{l.state === "ok" ? ` ${l.data.total}` : ""}
                </button>
              );
            })}
          </div>
          <div id="vpanel" role="tabpanel" aria-labelledby={"tab-" + tab} className="vgrid">
            <nav className="card vlist" aria-label={`Your ${tab}`} data-testid={"list-" + tab}>
              <button type="button" className="btn pri" data-testid="new" disabled={confirming !== null && confirming === openId}
                onClick={() => { choose("new"); setNonce((n) => n + 1); }}>New {one}</button>
              {cur.state === "ok" && rows.length === 0 && <p className="empty" data-testid={"voices-empty-" + tab}>You have no {tab} yet. Make one with New {one}.</p>}
              {cur.state === "ok" && cur.data.total > rows.length && <p className="meta">Showing {rows.length} of {cur.data.total}.</p>}
              <ul className="plain">
                {rows.map((r) => (
                  <li key={r.id}>
                    <button type="button" className={"vrow" + (r.id === openId ? " isel" : "")} aria-current={r.id === openId ? "true" : undefined}
                      data-testid="row" data-id={r.id} onClick={() => choose(r.id)}>
                      <span className="row-name">{r.name}</span>
                      <span className="meta">{r.meta.map((m, i) => (m === "Untested" ? <span key={i} className="pill untested-pill">Untested</span> : <span key={i}>{(i ? " · " : "") + m}</span>))}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="vedit">
              {cur.state === "ok" && openId === null && <p className="meta">Pick one from the list, or make a new {one}.</p>}
              {cur.state === "ok" && waiting && <p className="meta" role="status">Opening...</p>}
              {cur.state === "ok" && openId !== null && !waiting && tab === "presenters" && (
                <PresenterEditor key={"p:" + openId + ":" + (openId === "new" ? nonce : "")} row={pRow ?? null} ctx={ctx} flash={flash === openId}
                  confirming={confirming} setConfirming={setConfirming} onSaved={onSaved} onGone={onGone} />
              )}
              {cur.state === "ok" && openId !== null && !waiting && tab === "teams" && (
                <TeamEditor key={"t:" + openId + ":" + (openId === "new" ? nonce : "")} row={tRow ?? null} ctx={ctx} flash={flash === openId}
                  confirming={confirming} setConfirming={setConfirming} onSaved={onSaved} onGone={onGone} />
              )}
              {cur.state === "ok" && openId !== null && !waiting && tab === "formats" && (
                <FormatEditor key={"f:" + openId + ":" + (openId === "new" ? nonce : "")} row={fRow ?? null} ctx={ctx} flash={flash === openId}
                  confirming={confirming} setConfirming={setConfirming} onSaved={onSaved} onGone={onGone} />
              )}
              {total === 0 && cur.state === "ok" && openId === null && null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------------
type EditorProps<T> = { row: T | null; ctx: Ctx; flash: boolean; confirming: string | null; setConfirming: (t: string | null) => void; onSaved: (id: string) => void; onGone: () => void };

// the footer every editor shares: Save (off until something changed), the saved line, the error line, and a typed Delete
function Footer({ target, canSave, saving, saved, error, onSave, onDelete, isNew, confirming, setConfirming, word, what, hint }:
  { target: string; canSave: boolean; saving: boolean; saved: boolean; error: string; onSave: () => void; onDelete: () => void; isNew: boolean; confirming: string | null; setConfirming: (t: string | null) => void; word: string; what: string; hint?: string }) {
  return (
    <div className="vfoot">
      <div className="vfoot-row">
        <button type="button" className="btn pri" data-testid="save" disabled={!canSave || saving || confirming === target} onClick={onSave}>{saving ? "Saving..." : isNew ? "Create" : "Save"}</button>
        {!isNew && <button type="button" className="danger" data-testid="delete" disabled={confirming === target || saving} onClick={() => setConfirming(target)}>Delete {what}</button>}
        {saved && <span className="saved" role="status" data-testid="saved">Saved</span>}
      </div>
      {hint && <p className="meta" data-testid="save-hint">{hint}</p>}
      {error && <p className="note-err" role="alert" data-testid="form-error">{error}</p>}
      {confirming === target && (
        <TypedConfirm key={target} target={target} word={word} prompt={`Delete this ${what} for good? This cannot be undone.`} confirmLabel={`Delete ${what}`}
          onCancel={() => setConfirming(null)} onConfirm={onDelete} />
      )}
    </div>
  );
}

// the draft of a form: its changes, reset when the saved row it came from changes
function useDraft<D extends Record<string, any>>(base: D): [D, (patch: Partial<D>) => void, boolean, (d: D) => void] {
  const [draft, setDraft] = useState<D>(base);
  const baseRef = useRef(base);
  useEffect(() => {
    if (JSON.stringify(baseRef.current) !== JSON.stringify(base)) { baseRef.current = base; setDraft(base); }
  }, [base]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseRef.current);
  return [draft, (p) => setDraft((d) => ({ ...d, ...p })), dirty, (d) => { baseRef.current = d; setDraft(d); }];
}

function Field({ label, value, onChange, area, rows = 3, max, type = "text", hint, step, min, mx }:
  { label: string; value: string; onChange: (v: string) => void; area?: boolean; rows?: number; max?: number; type?: string; hint?: string; step?: string; min?: number; mx?: number }) {
  const hid = useId();
  return (
    <div className="f">
      <label>
        <span className="f-label">{label}</span>
        {area
          ? <textarea value={value} rows={rows} maxLength={max} onChange={(e) => onChange(e.target.value)} aria-describedby={hint ? hid : undefined} />
          : <input type={type} value={value} maxLength={max} step={step} min={min} max={mx} onChange={(e) => onChange(e.target.value)} aria-describedby={hint ? hid : undefined} />}
      </label>
      {hint && <span className="meta" id={hid}>{hint}</span>}
    </div>
  );
}

// ---- presenters ---------------------------------------------------------------------------------------------------------------
type PD = {
  name: string; role: string; personality: string; backstory: string; language: string; focus: string; stance: string; tone: string; speakingStyle: string;
  notes: string; promptMode: string; systemPrompt: string; voice: string; speed: string;
};
const pdOf = (p: Presenter | null): PD => ({
  name: p?.name ?? "", role: p?.role ?? "", personality: p?.personality ?? "", backstory: p?.backstory ?? "", language: p?.language ?? "en-US", focus: p?.focus ?? "",
  stance: p?.stance ?? "", tone: p?.tone ?? "", speakingStyle: p?.speakingStyle ?? "", notes: p?.notes ?? "", promptMode: p?.promptMode ?? "built",
  systemPrompt: p?.systemPrompt ?? "", voice: p?.voice.voice ?? "af_heart", speed: String(p?.voice.speed ?? 1),
});
const speedValid = (s: string) => { const n = Number(s); return s.trim() !== "" && Number.isFinite(n) && n >= SPEED_MIN && n <= SPEED_MAX; };
const FIELD_OF: Record<string, keyof PD> = {
  name: "name", role: "role", personality: "personality", backstory: "backstory", language: "language", focus: "focus", stance: "stance", tone: "tone",
  speaking_style: "speakingStyle", notes: "notes", system_prompt_mode: "promptMode", system_prompt: "systemPrompt",
};

function PresenterEditor({ row, ctx, flash, confirming, setConfirming, onSaved, onGone }: EditorProps<Presenter>) {
  const isNew = row === null;
  const base = pdOf(row);
  const [d, set, dirty, rebase] = useDraft<PD>(base);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(flash);
  const [error, setError] = useState("");
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const edit = (p: Partial<PD>) => { set(p); setSaved(false); setError(""); };

  const own = d.promptMode === "own";
  const speedOk = speedValid(d.speed);
  const voiceChanged = isNew || d.voice !== base.voice || d.speed !== base.speed;
  const canSave = dirty && d.name.trim() !== "" && speedOk && (!own || d.systemPrompt.trim() !== "" || true);
  const link = row ? ctx.voices.find((v) => v.id === row.voice.id) : undefined;
  const sharedLink = !!row && !!link && link.usedBy.some((u) => u.id !== row.id);

  const bodyOf = (): PresenterFields => {
    const b: Record<string, string> = {};
    for (const [k, f] of Object.entries(FIELD_OF)) if (isNew ? d[f] !== "" && !(k === "language" && d[f] === "en-US") && !(k === "system_prompt_mode" && d[f] === "built") : d[f] !== base[f]) b[k] = d[f];
    if (isNew && d.language !== "en-US") b.language = d.language;
    return b as PresenterFields;
  };

  async function save() {
    // an existing presenter's voice link is found in the voices list: without it a shared link cannot be told from its own, and nothing
    // would be written, so refuse the voice or speed change instead of showing "Saved"
    if (!isNew && voiceChanged && !link) { setSaved(false); setError("The voices could not be loaded, so the voice and speed cannot be changed now. Press Try again at the top, then save again."); return; }
    setSaving(true); setError(""); setSaved(false);
    const speed = Number(d.speed);
    const route = row?.voice.route ?? ctx.voices[0]?.route ?? DEFAULT_ROUTE;
    let res: Result<Presenter>;
    let note = "";
    if (isNew) {
      const v = await createVoice({ route, voice: d.voice, speed });
      if (!v.ok || !v.row) { done(v.ok ? "Could not set up the voice. Try again." : v.message); return; }
      res = await createPresenter({ ...bodyOf(), name: d.name, voice_id: v.row.id });
      if (!res.ok) await deleteVoice(v.row.id); // nothing is left behind
    } else {
      let voiceId: string | undefined;
      let newLink: string | undefined;
      if (voiceChanged && sharedLink) {
        const v = await createVoice({ route, voice: d.voice, speed });
        if (!v.ok || !v.row) { done(v.ok ? "Could not set up the voice. Try again." : v.message); return; }
        voiceId = newLink = v.row.id;
      }
      const body: PresenterFields = { ...bodyOf(), ...(voiceId ? { voice_id: voiceId } : {}) };
      res = Object.keys(body).length ? await updatePresenter(row!.id, body) : { ok: true, message: "Saved.", row: row! };
      if (!res.ok && newLink) await deleteVoice(newLink);
      if (res.ok && voiceChanged && !sharedLink && link) {
        const u = await updateVoice(link.id, { voice: d.voice, speed });
        if (!u.ok) note = " The other changes are saved, but the voice was not changed: " + u.message;
      }
    }
    if (!live.current) return;
    if (!res.ok) { done(res.message); return; }
    setSaving(false);
    if (note) { setError(note.trim()); }
    else setSaved(true);
    rebase(pdOf({ ...(res.row as Presenter), voice: { ...(res.row as Presenter).voice, voice: note ? base.voice : d.voice, speed: note ? Number(base.speed) : speed } }));
    onSaved(res.row!.id);
  }
  function done(message: string) { if (live.current) { setSaving(false); setError(message); } }

  async function remove() {
    setConfirming(null);
    setSaving(true); setError("");
    const r = await deletePresenter(row!.id);
    if (!r.ok) { done(r.message); return; }
    // its own voice link goes with it, unless another presenter uses it (best effort: the presenter is already gone)
    if (link && link.usedBy.length === 1) await deleteVoice(link.id);
    if (live.current) setSaving(false);
    onGone();
  }

  return (
    <section className="card vform" data-testid="editor" aria-label={isNew ? "New presenter" : "Presenter"}>
      <div className="vform-top">
        <h2 data-testid="editor-name">{isNew ? "New presenter" : row!.name}</h2>
        {!isNew && <span className="pill untested-pill" data-testid="untested">Untested</span>}
      </div>
      {!isNew && <p className="meta">Untested: no practice run has been done with this presenter yet. The audition arrives in a later step.</p>}
      {!isNew && row!.origin === "on-capture" && <p className="meta">Came from an Open Notebook capture.</p>}
      <Field label="Name" value={d.name} onChange={(v) => edit({ name: v })} max={120} />
      <Field label="Language" value={d.language} onChange={(v) => edit({ language: v })} max={20} hint="A language tag such as en-US." />

      <fieldset className="radios">
        <legend>How the presenter is written for the show</legend>
        <label className="opt"><input type="radio" name="mode" checked={!own} onChange={() => edit({ promptMode: "built" })} /> Built from the fields</label>
        <label className="opt"><input type="radio" name="mode" checked={own} onChange={() => edit({ promptMode: "own" })} /> My own prompt</label>
      </fieldset>
      {own ? (
        <>
          <p className="meta" data-testid="own-note">With your own prompt the show uses only this text to describe the presenter (and their name and voice). The profile fields are kept but not used.</p>
          <Field label="System prompt" value={d.systemPrompt} onChange={(v) => edit({ systemPrompt: v })} area rows={6} max={8000} />
        </>
      ) : (
        <>
          <Field label="Role" value={d.role} onChange={(v) => edit({ role: v })} max={500} />
          <Field label="Personality" value={d.personality} onChange={(v) => edit({ personality: v })} area max={4000} />
          <Field label="Backstory" value={d.backstory} onChange={(v) => edit({ backstory: v })} area rows={4} max={8000} />
          <Field label="Focus" value={d.focus} onChange={(v) => edit({ focus: v })} max={1000} hint="What they pay attention to." />
          <Field label="Stance" value={d.stance} onChange={(v) => edit({ stance: v })} max={1000} hint="The position they argue from." />
          <Field label="Tone" value={d.tone} onChange={(v) => edit({ tone: v })} max={500} />
          <Field label="Speaking style" value={d.speakingStyle} onChange={(v) => edit({ speakingStyle: v })} max={1000} />
        </>
      )}

      <div className="f">
        <Field label="Notes (only you see these)" value={d.notes} onChange={(v) => edit({ notes: v })} area max={4000}
          hint="Your own notes, for example what to change after the last episode. The show does not read them." />
        {!own && (
          <button type="button" data-testid="notes-to-profile" disabled={d.notes.trim() === ""}
            onClick={() => edit({ backstory: (d.backstory.trim() ? d.backstory.trimEnd() + "\n\n" : "") + d.notes.trim(), notes: "" })}>Add notes to the profile</button>
        )}
      </div>

      <VoiceSection d={d} edit={edit} saved={base} voiceId={row?.voice.id ?? null} unsaved={voiceChanged} speedOk={speedOk} />

      {!isNew && (
        <div className="f" data-testid="grounded">
          <span className="f-label">Grounded in</span>
          {row!.grounded.length === 0 ? <span className="meta">No links.</span> : (
            <ul className="plain">
              {row!.grounded.map((g, i) => <li key={i}>{g.label}{g.kind === "topic" ? " (a topic)" : ""}{g.private && <span className="pill"> private to you</span>}</li>)}
            </ul>
          )}
          <span className="meta">These links are kept with the presenter. They are not used by the show yet.</span>
        </div>
      )}
      {!isNew && row!.teams.length > 0 && <p className="meta">In {row!.teams.map((t) => t.name).join(", ")}.</p>}

      <Footer target={row?.id ?? "new"} canSave={canSave} saving={saving} saved={saved} error={error} onSave={save} onDelete={remove} isNew={isNew}
        confirming={confirming} setConfirming={setConfirming} word="delete" what="presenter"
        hint={!speedOk ? undefined : d.name.trim() === "" && dirty ? "A presenter needs a name." : undefined} />
    </section>
  );
}

function VoiceSection({ d, edit, saved, voiceId, unsaved, speedOk }: { d: PD; edit: (p: Partial<PD>) => void; saved: PD; voiceId: string | null; unsaved: boolean; speedOk: boolean }) {
  const listed = KOKORO_VOICES.some((g) => g.ids.includes(d.voice));
  const groups = listed ? KOKORO_VOICES : [{ group: "Current voice", ids: [d.voice] }, ...KOKORO_VOICES];
  return (
    <fieldset className="radios voice" data-testid="voice-picker">
      <legend>Voice</legend>
      {groups.map((g) => (
        <div key={g.group} className="vgroup">
          <span className="meta">{g.group}</span>
          <div className="vopts">
            {g.ids.map((id) => (
              <label key={id} className="opt"><input type="radio" name="voice" checked={d.voice === id} onChange={() => edit({ voice: id })} /> {id}</label>
            ))}
          </div>
        </div>
      ))}
      <div className="f">
        <Field label="Speed" type="number" step="0.05" min={SPEED_MIN} mx={SPEED_MAX} value={d.speed} onChange={(v) => edit({ speed: v })} />
        {!speedOk && <span className="note-err" role="alert" data-testid="speed-error">Speed is between {SPEED_MIN} and {SPEED_MAX}.</span>}
      </div>
      <p className="meta" data-testid="pitch-note">Pitch is not available on this voice engine.</p>
      <Sample voiceId={voiceId} blocked={unsaved || voiceId === null || !speedOk} />
      {saved.voice === "" && null}
    </fieldset>
  );
}

// Play sample: asks the workbench's sample route for the SAVED voice (the sample is of a stored voice link, so an unsaved choice
// has to be saved first) and plays what comes back. Every outcome is said in a sentence; nothing looks like it played unless it did.
function Sample({ voiceId, blocked }: { voiceId: string | null; blocked: boolean }) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const [msg, setMsg] = useState("");
  const audio = useRef<{ a: HTMLAudioElement; url: string } | null>(null);
  const live = useRef(true);
  const stop = useCallback(() => {
    const cur = audio.current;
    audio.current = null;
    if (cur) { try { cur.a.pause(); } catch { /* already stopped */ } URL.revokeObjectURL(cur.url); }
  }, []);
  useEffect(() => { live.current = true; return () => { live.current = false; stop(); }; }, [stop]);

  async function play() {
    if (blocked || voiceId === null || state === "loading") return;
    stop(); setMsg(""); setState("loading");
    const r = await fetchSample(voiceId);
    if (!live.current) return;
    if (!r.ok) { setState("idle"); setMsg(r.message); return; }
    const url = URL.createObjectURL(r.blob);
    const a = new Audio(url);
    audio.current = { a, url };
    a.onended = () => { if (audio.current?.a === a) { stop(); if (live.current) setState("idle"); } };
    a.onerror = () => { if (audio.current?.a === a) { stop(); if (live.current) { setState("idle"); setMsg("The sample could not be played in this browser."); } } };
    try { await a.play(); if (live.current) setState("playing"); } catch { stop(); if (live.current) { setState("idle"); setMsg("The browser did not allow the sample to play."); } }
  }
  return (
    <div className="sample">
      <button type="button" data-testid="sample-play" disabled={blocked || state === "loading"} onClick={play}>
        {state === "loading" ? "Getting the sample..." : state === "playing" ? "Play again" : "Play sample"}
      </button>
      {blocked && voiceId !== null && <span className="meta" data-testid="sample-hint">Save to hear the new voice.</span>}
      {blocked && voiceId === null && <span className="meta" data-testid="sample-hint">Save to hear this voice.</span>}
      {msg && <span className="note-err" role="status" data-testid="sample-msg">{msg}</span>}
    </div>
  );
}

// ---- teams -------------------------------------------------------------------------------------------------------------------
type TD = { name: string; description: string; order: string[] }; // order: presenter ids, with "you" for the user's seat
const YOU = "you";
const tdOf = (t: Team | null): TD => {
  const order = (t?.members ?? []).map((m) => m.presenterId);
  const seat = t ? Math.min(t.userSeat, order.length) : order.length;
  order.splice(seat, 0, YOU);
  return { name: t?.name ?? "", description: t?.description ?? "", order };
};

function TeamEditor({ row, ctx, flash, confirming, setConfirming, onSaved, onGone }: EditorProps<Team>) {
  const isNew = row === null;
  const [d, set, dirty, rebase] = useDraft<TD>(tdOf(row));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(flash);
  const [error, setError] = useState("");
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const edit = (p: Partial<TD>) => { set(p); setSaved(false); setError(""); };
  const nameOf = (id: string) => ctx.presenters.find((p) => p.id === id)?.name ?? "(a presenter)";
  const move = (i: number, by: number) => {
    const o = d.order.slice(); const j = i + by;
    if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]];
    edit({ order: o });
  };
  const add = (id: string) => {
    const o = d.order.slice();
    if (o[o.length - 1] === YOU) o.splice(o.length - 1, 0, id); else o.push(id);
    edit({ order: o });
  };
  const members = d.order.filter((x) => x !== YOU);
  const full = d.order.length >= MAX_SEATS;
  const free = ctx.presenters.filter((p) => !d.order.includes(p.id));
  const canSave = dirty && d.name.trim() !== "" && members.length >= 1;

  async function save() {
    setSaving(true); setError(""); setSaved(false);
    const user_seat = d.order.indexOf(YOU);
    const res = isNew
      ? await createTeam({ name: d.name, description: d.description, members, user_seat })
      : await updateTeam(row!.id, { name: d.name, description: d.description, members, user_seat });
    if (!live.current) return;
    setSaving(false);
    if (!res.ok) { setError(res.message); return; }
    rebase(tdOf(res.row as Team));
    setSaved(true);
    onSaved(res.row!.id);
  }
  async function remove() {
    setConfirming(null); setSaving(true); setError("");
    const r = await deleteTeam(row!.id);
    if (!live.current) return;
    setSaving(false);
    if (!r.ok) { setError(r.message); return; }
    onGone();
  }

  return (
    <section className="card vform" data-testid="editor" aria-label={isNew ? "New team" : "Team"}>
      <div className="vform-top"><h2 data-testid="editor-name">{isNew ? "New team" : row!.name}</h2></div>
      <Field label="Name" value={d.name} onChange={(v) => edit({ name: v })} max={120} />
      <Field label="Description" value={d.description} onChange={(v) => edit({ description: v })} area max={2000} />
      <div className="f">
        <span className="f-label" id="order-label">Speaking order</span>
        <ol className="order" data-testid="team-order" aria-labelledby="order-label">
          {d.order.map((id, i) => {
            const nm = id === YOU ? "You" : nameOf(id);
            return (
              <li key={id} className={id === YOU ? "you" : ""}>
                <span className="seat-no">{i + 1}</span>
                <span className="seat-name">{nm}</span>
                {id === YOU && <span className="meta">your seat</span>}
                <span className="seat-btns">
                  <button type="button" aria-label={`Move ${nm} up`} disabled={i === 0} onClick={() => move(i, -1)}>Up</button>
                  <button type="button" aria-label={`Move ${nm} down`} disabled={i === d.order.length - 1} onClick={() => move(i, 1)}>Down</button>
                  {id !== YOU && <button type="button" aria-label={`Take ${nm} out`} onClick={() => edit({ order: d.order.filter((x) => x !== id) })}>Take out</button>}
                </span>
              </li>
            );
          })}
        </ol>
        <span className="meta" data-testid="seat-count">{d.order.length} of {MAX_SEATS} seats, yours included.</span>
        {full && <span className="meta" data-testid="seat-full">A team has at most {MAX_SEATS} seats, yours included.</span>}
      </div>
      <div className="f">
        <span className="f-label">Add a presenter</span>
        {free.length === 0 ? <span className="meta">All of your presenters are in this team.</span> : (
          <ul className="plain addlist">
            {free.map((p) => <li key={p.id}><button type="button" aria-label={`Add ${p.name}`} disabled={full} onClick={() => add(p.id)}>Add {p.name}</button></li>)}
          </ul>
        )}
      </div>
      {!isNew && row!.formats.length > 0 && <p className="meta">Formats of this team: {row!.formats.map((f) => f.name).join(", ")}.</p>}
      <Footer target={row?.id ?? "new"} canSave={canSave} saving={saving} saved={saved} error={error} onSave={save} onDelete={remove} isNew={isNew}
        confirming={confirming} setConfirming={setConfirming} word="delete" what="team" hint={dirty && members.length < 1 ? "A team needs at least one presenter." : undefined} />
    </section>
  );
}

// ---- formats -----------------------------------------------------------------------------------------------------------------
type FD = { name: string; description: string; teamId: string; briefing: string; segments: string; language: string; scriptRoute: string; kind: string; useFor: string[]; isDefault: boolean };
const fdOf = (f: Format | null): FD => ({
  name: f?.name ?? "", description: f?.description ?? "", teamId: f?.teamId ?? "", briefing: f?.briefing ?? "", segments: String(f?.segments ?? 3), language: f?.language ?? "en-US",
  scriptRoute: f?.scriptRoute ?? "", kind: f?.kind ?? "conversation", useFor: FORMAT_USES.map((u) => u.key).filter((k) => f?.useFor.includes(k)), isDefault: f?.isDefault ?? false,
});

function FormatEditor({ row, ctx, flash, confirming, setConfirming, onSaved, onGone }: EditorProps<Format>) {
  const isNew = row === null;
  const base = fdOf(row);
  const [d, set, dirty, rebase] = useDraft<FD>(base);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(flash);
  const [error, setError] = useState("");
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const edit = (p: Partial<FD>) => { set(p); setSaved(false); setError(""); };
  const seg = Number(d.segments);
  const segOk = Number.isInteger(seg) && seg >= 1 && seg <= 50;
  const canSave = dirty && d.name.trim() !== "" && d.teamId !== "" && segOk;
  const kinds = FORMAT_KINDS.some((k) => k.key === d.kind) ? FORMAT_KINDS : [...FORMAT_KINDS, { key: d.kind, label: d.kind, meaning: "" }];

  async function save() {
    setSaving(true); setError(""); setSaved(false);
    const b: Record<string, unknown> = {};
    const map: [keyof FD, string, (v: any) => unknown][] = [
      ["name", "name", (v) => v], ["description", "description", (v) => v], ["teamId", "team_id", (v) => v], ["briefing", "briefing", (v) => v], ["segments", "segments", (v) => Number(v)],
      ["language", "language", (v) => v], ["scriptRoute", "script_route", (v) => v], ["kind", "kind", (v) => v], ["useFor", "use_for", (v) => v], ["isDefault", "is_default", (v) => v],
    ];
    for (const [k, wire, f] of map) {
      if (isNew ? (d[k] !== "" && !(Array.isArray(d[k]) && (d[k] as string[]).length === 0) && !(k === "isDefault" && !d[k]) && !(k === "scriptRoute" && d[k] === "")) : JSON.stringify(d[k]) !== JSON.stringify(base[k])) b[wire] = f(d[k]);
    }
    const res = isNew ? await createFormat(b as any) : await updateFormat(row!.id, b as any);
    if (!live.current) return;
    setSaving(false);
    if (!res.ok) { setError(res.message); return; }
    rebase(fdOf(res.row as Format));
    setSaved(true);
    onSaved(res.row!.id);
  }
  async function remove() {
    setConfirming(null); setSaving(true); setError("");
    const r = await deleteFormat(row!.id);
    if (!live.current) return;
    setSaving(false);
    if (!r.ok) { setError(r.message); return; }
    onGone();
  }

  return (
    <section className="card vform" data-testid="editor" aria-label={isNew ? "New format" : "Format"}>
      <div className="vform-top"><h2 data-testid="editor-name">{isNew ? "New format" : row!.name}</h2></div>
      <Field label="Name" value={d.name} onChange={(v) => edit({ name: v })} max={120} />
      <Field label="Description" value={d.description} onChange={(v) => edit({ description: v })} area max={2000} />
      <fieldset className="radios">
        <legend>Team</legend>
        {ctx.teams.length === 0 && <span className="meta">You have no teams yet: make a team first.</span>}
        {ctx.teams.map((t) => <label key={t.id} className="opt"><input type="radio" name="team" checked={d.teamId === t.id} onChange={() => edit({ teamId: t.id })} /> {t.name}</label>)}
      </fieldset>
      <fieldset className="radios">
        <legend>Kind</legend>
        {kinds.map((k) => <label key={k.key} className="opt" title={k.meaning}><input type="radio" name="kind" checked={d.kind === k.key} onChange={() => edit({ kind: k.key })} /> {k.label}</label>)}
        <span className="meta">{kinds.find((k) => k.key === d.kind)?.meaning}</span>
      </fieldset>
      <fieldset className="radios">
        <legend>Use it for</legend>
        {FORMAT_USES.map((u) => (
          <label key={u.key} className="opt"><input type="checkbox" checked={d.useFor.includes(u.key)}
            onChange={(e) => edit({ useFor: FORMAT_USES.map((x) => x.key).filter((k) => (k === u.key ? e.target.checked : d.useFor.includes(k))) })} /> {u.label}</label>
        ))}
        <span className="meta">Leave all off to use it for anything.</span>
      </fieldset>
      <label className="opt"><input type="checkbox" checked={d.isDefault} onChange={(e) => edit({ isDefault: e.target.checked })} /> Make this my default format</label>
      <Field label="Briefing" value={d.briefing} onChange={(v) => edit({ briefing: v })} area rows={4} max={8000} />
      <Field label="Segments" type="number" step="1" min={1} mx={50} value={d.segments} onChange={(v) => edit({ segments: v })} />
      <Field label="Language" value={d.language} onChange={(v) => edit({ language: v })} max={20} />
      <Field label="Script model route" value={d.scriptRoute} onChange={(v) => edit({ scriptRoute: v })} max={100}
        hint="The name of the model that writes the script, as the gateway knows it. Leave blank for the server's default." />
      <Footer target={row?.id ?? "new"} canSave={canSave} saving={saving} saved={saved} error={error} onSave={save} onDelete={remove} isNew={isNew}
        confirming={confirming} setConfirming={setConfirming} word="delete" what="format" hint={dirty && d.teamId === "" ? "Choose the team this format uses." : undefined} />
    </section>
  );
}
