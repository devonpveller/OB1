// "Flag for cleanup" (rwr-flag-buttons): the one button and dialog that flags a reference, a claim or a source for
// cleanup from where the person is reading it. A screen mounts <FlagForCleanup item from subject what/> and nothing else:
// the reference / claim / source it names, where it was flagged FROM (a document, or a source) and who is signed in.
//
// The rules this keeps (each has a test):
//  - the dialog says, before anything is sent, that nothing changes until it is decided (and who can see the flag);
//  - the reasons are exactly the four of flag-data.ts, as radio buttons (never a drop-down list); none is chosen for the person;
//  - a flag changes nothing about the item, so there is nothing to undo: one flag per item, person and document for as long as
//    the page lives (after it is made the button gives way to a line that says so and links to Cleanup, also when the drawer is
//    closed and opened again), never two by a double click;
//  - the dialog, its draft (reason, note) and an answer still in flight belong to ONE person and ONE item: when the person
//    on the page changes without a reload (the shell resets the state: a new epoch) or a different item is named, everything
//    is dropped, and an answer that arrives later changes nothing and toasts nothing;
//  - the request is sent only when the person who opened the dialog is still the one signed in (as a document save is);
//  - words shown are fixed sentences: the server's text, a title and the note are never shown back, in a toast or an error
//    (a missing item and another person's are one sentence); nothing is kept in the browser.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { isSamePerson } from "../../screens/document-editor/editor-data";
import { stateEpoch, subscribeState } from "../../lib/state";
import { Link } from "../../shell/Link";
import { useToast } from "../../shell/Toast";
import { CONTROL, flagItem, NOTE_MAX, REASONS, type FlagFrom, type FlagItem, type ReasonKey } from "./flag-data";
import "./flag.css";

// What this page has flagged, for the person and document it was flagged from: the drawer (and so the component) is closed and
// reopened freely, and a second flag of the same thing from the same place is almost always a slip (the server does not
// dedupe). Memory only - a page load, or a different person (the key holds the state epoch and subject) starts afresh.
const flagged = new Set<string>();

export type FlagProps = {
  item: FlagItem;
  from: FlagFrom;
  subject: string | null;       // who is signed in (null until the shell knows: nothing is offered)
  what: string;                 // "this reference", "this claim", "this source": words for the dialog, never a title
  label?: string;               // the button's words (default "Flag for cleanup")
};

export const NOTHING_CHANGES = "Nothing changes until it is decided.";
const MSG = {
  gone: "That item is not available any more, so nothing was flagged.",
  // the reason and the note are fixed by the dialog (a list, a cap, no control characters), so a refusal is about where it was made from
  refused: "The flag was not accepted. The document it was made from could not be used, so nothing was flagged.",
  failed: "The flag could not be sent. Nothing was flagged. Try again.",
  control: "The note cannot hold control characters. Remove them and try again.",
  changed: "The person signed in changed, so nothing was sent.",
} as const;

export function FlagForCleanup(p: FlagProps) {
  const epoch = useSyncExternalStore(subscribeState, stateEpoch);
  if (!p.subject) return null;
  // one person, one item, one place it was flagged from: any change remounts, dropping the open dialog, the draft and any
  // request in flight
  const key = [epoch, p.subject, p.item.kind, p.item.id, p.from.kind, p.from.ref].join("|");
  return <Flagger key={key} memo={key} {...p} subject={p.subject} />;
}

function Flagger({ item, from, subject, what, memo, label = "Flag for cleanup" }: FlagProps & { subject: string; memo: string }) {
  const toast = useToast();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReasonKey | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(() => flagged.has(memo));
  const live = useRef(true);
  const head = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const wasOpen = useRef(false);
  // focus follows the dialog: into it when it opens, back to the button (enabled again by then) when it is closed
  useEffect(() => {
    if (open) head.current?.focus();
    else if (wasOpen.current) opener.current?.focus();
    wasOpen.current = open;
  }, [open]);

  // closing (Cancel, Escape) discards the draft: the next open starts empty
  const close = () => { setOpen(false); setProblem(null); setReason(null); setNote(""); };
  const send = async () => {
    if (!reason || sending) return;
    if (CONTROL.test(note)) { setProblem(MSG.control); return; }
    setSending(true); setProblem(null);
    if (!(await isSamePerson(subject))) { if (live.current) { setSending(false); setProblem(MSG.changed); } return; }
    const out = await flagItem(item, reason, note, from);
    if (!live.current) return; // a different person or item took the page: nothing more happens
    setSending(false);
    if (out.kind === "flagged") {
      flagged.add(memo); setOpen(false); setDone(true); setNote(""); setReason(null);
      toast({ message: "Flagged for cleanup. It is under Cleanup, Flagged by you." }); // no title, no note, no id
    } else setProblem(MSG[out.kind]);
  };

  if (done) {
    return (
      <p className="flag-done meta" data-testid="flag-done" role="status">
        You flagged {what} for cleanup. <Link to="/cleanup" data-testid="flag-cleanup-link">See it in Cleanup</Link>
      </p>
    );
  }
  return (
    <div className="flag" data-testid="flag" data-item-kind={item.kind}>
      <button type="button" className="btn sm" ref={opener} data-testid="flag-open" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen(true)} disabled={open}>{label}</button>
      {open && (
        <div className="flag-dlg" role="dialog" aria-modal="false" aria-labelledby={uid + "t"} aria-describedby={uid + "d"} data-testid="flag-dialog"
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); if (!sending) close(); } }}>
        <form className="flag-form" data-testid="flag-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <h3 id={uid + "t"} tabIndex={-1} ref={head} className="flag-title">Flag {what} for cleanup</h3>
          <p id={uid + "d"} className="flag-promise" data-testid="flag-promise">
            {NOTHING_CHANGES} Flagging does not remove, hide or change {what}; it only puts it on your list under Cleanup. Only you and admins can see your flag.
          </p>
          <fieldset className="flag-reasons" data-testid="flag-reasons">
            <legend>Why</legend>
            {REASONS.map((r) => (
              <label key={r.key} className={"flag-reason" + (reason === r.key ? " on" : "")}>
                <input type="radio" name={uid + "r"} value={r.key} checked={reason === r.key} onChange={() => setReason(r.key)}
                  data-testid={`flag-reason-${r.key}`} />
                <span>{r.label}</span>
              </label>
            ))}
          </fieldset>
          <label className="flag-note" htmlFor={uid + "n"}>Note (optional)</label>
          <textarea id={uid + "n"} data-testid="flag-note" rows={3} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)}
            autoComplete="off" />
          {problem && <p className="flag-problem" role="alert" data-testid="flag-problem">{problem}</p>}
          <div className="flag-actions">
            <button type="button" className="btn sm" onClick={close} disabled={sending} data-testid="flag-cancel">Cancel</button>
            <button type="submit" className="btn sm pri" disabled={!reason || sending} data-testid="flag-send">{sending ? "Flagging..." : "Flag it"}</button>
          </div>
        </form>
        </div>
      )}
    </div>
  );
}
