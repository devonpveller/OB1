// Settings > Notifications (rwr-notify-prefs): which kinds of notification show in your bell. One row per kind: an on / off
// switch for "In the workbench", and an "Email" column that is shown DISABLED ("needs a mail service": no mail is sent, there is
// no email setting to store). "Sign-in from a new device" is reserved and always on, and says so honestly ("Not detected yet": nothing on this server detects a new device
// or can post that event today): its switch is shown on and disabled, and the SERVER
// refuses an off anyway (its registry row is an enum of "on" only). Every value is the account's, read from the registry list
// the frame already holds and written through the frame's own versioned save (saveSetting): nothing is kept in the browser.
// `epoch` reads which person this screen is for right now: an answer that lands after the person changed is dropped, so an
// earlier person's save never writes into, or shows in, the next person's list (checked again after the await, before any state).
import { useCallback, useId, useRef, useState } from "react";
import { saveSetting, show, TAG_LABEL, type Setting } from "./settings-data";

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

const MAIL_NOTE = "Needs a mail service";

function Row({ row, onRow, onStale, epoch }: { row: Setting; onRow: (r: Setting) => void; onStale: () => void; epoch: () => number }) {
  const id = useId();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const busyRef = useRef(false); // a second click before the first save's render finds the switch still enabled
  // what the server says is stored (else its default), exactly: a value that is not a boolean is not "on"
  const effective = row.is_default ? row.default : row.value;
  const locked = row.type === "enum"; // the sign-in row: the registry offers "on" only
  const editable = row.editable && row.type === "boolean";

  const toggle = useCallback(async (next: boolean) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setStatus({ kind: "saving" });
    const mine = epoch();
    const r = await saveSetting(row, next);
    busyRef.current = false;
    if (mine !== epoch()) return; // the person changed while this was in flight: nothing of it is shown or merged
    if (r.ok) {
      onRow(r.row);
      setStatus({ kind: "saved" });
    } else if (r.status === 409) {
      setStatus({ kind: "error", message: "Changed on another browser. Showing the latest value." });
      onStale();
    } else {
      setStatus({ kind: "error", message: `Not saved: ${r.message}` });
    }
  }, [row, onRow, onStale, epoch]);

  const busy = status.kind === "saving";
  const tag = row.tag !== null && row.tag in TAG_LABEL ? row.tag : null;
  let control: React.ReactNode;
  if (locked) {
    control = (
      <span className="np-on">
        <input type="checkbox" checked disabled aria-label={`${row.label}: in the workbench, always on`} data-testid="control" data-locked="true" readOnly />
        <span className="meta" data-testid="always-on">Always on</span>
        <span className="meta" data-testid="not-detected">Not detected yet: needs sign-in tracking</span>
      </span>
    );
  } else if (editable) {
    control = (
      <input type="checkbox" checked={effective === true} disabled={busy} aria-label={`${row.label}: in the workbench`} data-testid="control"
        onChange={(e) => void toggle(e.target.checked)} />
    );
  } else {
    control = <span className="ro" data-testid="readonly">{show(effective)}</span>;
  }

  return (
    <div className="srow np-row" data-testid={"setting-" + row.key} data-key={row.key}>
      <div className="s-main">
        <span className="s-label" id={id + "-l"}>{row.label}</span>
        {row.help && <p className="meta">{row.help}</p>}
      </div>
      <div className="s-side np-cols">
        <div className="np-col">
          <span className="np-h">In the workbench</span>
          {control}
        </div>
        <div className="np-col" data-testid={"email-" + row.key}>
          <span className="np-h">Email</span>
          <span className="np-mail">
            <input type="checkbox" checked={false} disabled readOnly aria-label={`Email for ${row.label}: ${MAIL_NOTE}`} data-testid="email-control" />
            <span className="meta" data-testid="email-note">{MAIL_NOTE}</span>
          </span>
        </div>
        {tag && <span className={"tag tag-" + tag} data-testid="tag" data-tag={tag}>{TAG_LABEL[tag]}</span>}
        <div className="s-state">
          <span role="status" aria-live="polite" className="saved" data-testid={"saved-" + row.key}>
            {status.kind === "saving" ? "Saving..." : status.kind === "saved" ? "Saved" : ""}
          </span>
          {status.kind === "error" && <span role="alert" className="err" data-testid={"error-" + row.key}>{status.message}</span>}
        </div>
      </div>
    </div>
  );
}

export function Notifications({ rows, onRow, onStale, epoch }: { rows: Setting[]; onRow: (r: Setting) => void; onStale: () => void; epoch: () => number }) {
  return (
    <div data-testid="notifications">
      <p className="meta">
        Choose which kinds of notification show in your bell. Only you see these choices; other people's bells are not changed.
        Sign-in from a new device is reserved and always on, but it is not detected yet: this server does not track sign-in devices, so no such alert is sent today. Email is not available yet: no mail is sent.
      </p>
      {rows.map((r) => (
        <Row key={r.key} row={r} onRow={onRow} onStale={onStale} epoch={epoch} />
      ))}
    </div>
  );
}
