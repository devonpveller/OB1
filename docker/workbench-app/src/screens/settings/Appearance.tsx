// Settings > Appearance (rwr-appearance): light / dark / follow device, accent colour, density, text size, saved themes and
// "Workbench default", with a live preview. Every choice is applied to the whole page at once and kept with the account
// (lib/appearance.ts), so it follows the person to every device. Built from the approved mockup (draft 5, Settings >
// Appearance): the same labels and descriptions, and a radio group wherever the mockup had a short list (never a native
// <select>: one-picker rule). The start screen row is the frame's own generic row, passed in as children.
import { useId, useRef, useState } from "react";
import { TagChip } from "./TagChip";
import { resetSetting, type Setting } from "./settings-data";
import {
  ACCENTS, DENSITIES, appearanceEpoch, SAVED_CAP, TEXT_SIZES, THEMES, DEFAULT_LOOK, NAME_MAX,
  applySavedTheme, chooseLook, deleteSavedTheme, resetToWorkbenchDefault, saveTheme, useAppearance,
  type Look, type SavedTheme,
} from "../../lib/appearance";

const label = (id: string, list: readonly { id: string; label: string }[]) => list.find((x) => x.id === id)?.label ?? id;
const sizeLabel = (s: string) => `${s} px` + (s === DEFAULT_LOOK.textSize ? " (default)" : "");
export const lookSummary = (l: Look) =>
  [label(l.theme, THEMES), label(l.accent, ACCENTS), label(l.density, DENSITIES), `${l.textSize} px`].join(" · ");

function Choice({ name, value, text, checked, disabled, onPick, children }:
  { name: string; value: string; text: string; checked: boolean; disabled: boolean; onPick: () => void; children?: React.ReactNode }) {
  return (
    <label className={"seg-o" + (checked ? " on" : "")}>
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={onPick} />
      {children}
      <span>{text}</span>
    </label>
  );
}

function Row({ row, stored, children, help, id }: { row: Setting | undefined; stored: boolean; children: React.ReactNode; help?: React.ReactNode; id: string }) {
  if (!row) return null;
  return (
    <div className="srow" data-testid={"setting-" + row.key} data-key={row.key}>
      <div className="s-main">
        <span className="s-label" id={id}>{row.label}</span>
        {row.help && <p className="meta">{row.help}</p>}
        {help}
        <p className="meta">{stored ? "Set by you" : `Using the default: ${row.default === null || row.default === undefined ? "none" : String(row.default)}`}</p>
      </div>
      <div className="s-side">
        <TagChip tag={row.tag} />
        <div className="s-ctl">{children}</div>
      </div>
    </div>
  );
}

export function Appearance({ rows, onRow, children }: { rows: Setting[]; onRow: (r: Setting) => void; children?: React.ReactNode }) {
  const ap = useAppearance();
  const gid = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const by = (k: string) => rows.find((r) => r.key === k);
  const startRow = by("ui.start_screen");
  const { look, saved, stored } = ap;
  const full = saved.length >= SAVED_CAP;

  const busyRef = useRef(false); // a second Enter before the first save's render finds the button still enabled
  const run = async (f: () => Promise<unknown>) => { if (busyRef.current) return; busyRef.current = true; setBusy(true); try { await f(); } finally { busyRef.current = false; setBusy(false); } };
  const pick = (patch: Partial<Look>) => void chooseLook(patch);
  const resetAll = () => void run(async () => {
    // startRow is the row of the person who pressed the button; if the person changes while the look keys are being
    // reset, the start-screen DELETE (versioned for them) must not go out under the next person's identity
    const mine = appearanceEpoch();
    await resetToWorkbenchDefault();
    if (mine !== appearanceEpoch()) return;
    if (startRow && !startRow.is_default) {
      const r = await resetSetting(startRow);
      if (mine !== appearanceEpoch()) return; // answered for the earlier person: nothing of it is merged into the next one's list
      if (r.ok) onRow(r.row);
    }
  });
  const save = () => void run(async () => { const r = await saveTheme(name); if (r.ok) setName(""); });
  const mean = (list: readonly { id: string; means: string }[], id: string) => list.find((x) => x.id === id)?.means;

  return (
    <div data-testid="appearance" className="appearance">
      <p className="meta">How the workbench looks for you. The screens themselves have a fixed layout.</p>

      <div className="box ap-preview-box">
        <div className="ap-preview" data-testid="ap-preview" aria-label="Preview of your choices" role="group">
          <div className="ap-p-title">Upgrading the workstation CPU</div>
          <div className="ap-p-meta">Edited 2 h ago · 6 sources</div>
          <div className="ap-p-btns"><span className="ap-p-primary">Start research</span><span className="ap-p-sec">Open</span></div>
        </div>
        <p className="meta ap-p-note">Live preview. Changes apply to your workbench only, on every device you sign in on.</p>
      </div>

      <Row row={by("ui.theme")} stored={stored.theme} id={gid + "-theme"} help={<p className="meta" data-testid="ap-theme-means">{mean(THEMES, look.theme)}</p>}>
        <div role="radiogroup" aria-labelledby={gid + "-theme"} className="seg" data-testid="ap-theme">
          {THEMES.map((t) => <Choice key={t.id} name={gid + "-theme"} value={t.id} text={t.label} checked={look.theme === t.id} disabled={false} onPick={() => pick({ theme: t.id })} />)}
        </div>
      </Row>

      <Row row={by("ui.accent")} stored={stored.accent} id={gid + "-accent"}>
        <div role="radiogroup" aria-labelledby={gid + "-accent"} className="seg" data-testid="ap-accent">
          {ACCENTS.map((a) => (
            <Choice key={a.id} name={gid + "-accent"} value={a.id} text={a.label} checked={look.accent === a.id} disabled={false} onPick={() => pick({ accent: a.id })}>
              <span className="ap-swatch" data-accent={a.id} aria-hidden="true" />
            </Choice>
          ))}
        </div>
      </Row>

      <Row row={by("ui.density")} stored={stored.density} id={gid + "-density"} help={<p className="meta">{mean(DENSITIES, look.density)}</p>}>
        <div role="radiogroup" aria-labelledby={gid + "-density"} className="seg" data-testid="ap-density">
          {DENSITIES.map((d) => <Choice key={d.id} name={gid + "-density"} value={d.id} text={d.label} checked={look.density === d.id} disabled={false} onPick={() => pick({ density: d.id })} />)}
        </div>
      </Row>

      <Row row={by("ui.text_size")} stored={stored.textSize} id={gid + "-size"}>
        <div role="radiogroup" aria-labelledby={gid + "-size"} className="seg" data-testid="ap-size">
          {TEXT_SIZES.map((s) => <Choice key={s} name={gid + "-size"} value={s} text={sizeLabel(s)} checked={look.textSize === s} disabled={false} onPick={() => pick({ textSize: s })} />)}
        </div>
      </Row>

      {children}

      <Row row={by("ui.saved_themes")} stored={saved.length > 0} id={gid + "-saved"}>
        <div className="ap-saved">
          <p className="meta" data-testid="ap-count" role="status">{saved.length} of {SAVED_CAP} saved</p>
          {saved.length > 0 && (
            <ul className="ap-list" aria-labelledby={gid + "-saved"}>
              {saved.map((t: SavedTheme) => (
                <li key={t.name} data-testid="saved-theme" data-name={t.name}>
                  <span className="ap-name">{t.name}</span>
                  <span className="meta ap-sum">{lookSummary(t.look)}</span>
                  <span className="ap-acts">
                    <button type="button" disabled={busy} aria-label={`Apply ${t.name}`} onClick={() => void run(() => applySavedTheme(t.name))}>Apply</button>
                    <button type="button" disabled={busy} aria-label={`Delete ${t.name}`} onClick={() => void run(() => deleteSavedTheme(t.name))}>Delete</button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="ap-new">
            <label className="ap-name-l" htmlFor={gid + "-name"}>Name for this theme</label>
            <input id={gid + "-name"} type="text" value={name} maxLength={NAME_MAX} disabled={busy || full} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }} />
            <button type="button" disabled={busy || full} onClick={save}>Save as theme</button>
          </div>
          {full && <p className="meta">You can keep {SAVED_CAP} saved themes. Delete one to save another.</p>}
        </div>
      </Row>

      <div className="srow" data-testid="ap-default-row">
        <div className="s-main">
          <span className="s-label">Workbench default</span>
          <p className="meta">Puts the theme, accent, density, text size and start screen back to the defaults. Your saved themes stay.</p>
        </div>
        <div className="s-side"><div className="s-ctl"><button type="button" disabled={busy} onClick={resetAll}>Workbench default</button></div></div>
      </div>

      <div className="s-state" aria-live="polite">
        {ap.error && <span role="alert" className="err" data-testid="ap-error">{ap.error}</span>}
      </div>
    </div>
  );
}
