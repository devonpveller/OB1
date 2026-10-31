// The session stream (contract stream(): `event: snapshot` / `card` / `end`), read through fetch so it
// goes through the same /workbench door as every other call. A test replaces the opener
// (setStreamOpener) to drive a panel event by event.
export interface StreamMessage {
  event: string;
  data: any;
}
export type StreamOpener = (url: string, on: (m: StreamMessage) => void) => () => void;

const fetchOpener: StreamOpener = (url, on) => {
  const ctl = new AbortController();
  (async () => {
    const r = await fetch(url, { credentials: "same-origin", signal: ctl.signal });
    if (!r.ok || !r.body) return;
    const rd = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
        const raw = /^data: (.*)$/m.exec(block)?.[1] ?? "";
        try {
          on({ event, data: JSON.parse(raw) });
        } catch { /* not json: ignored */ }
      }
    }
  })().catch(() => { /* closed or aborted */ });
  return () => ctl.abort();
};

let opener: StreamOpener = fetchOpener;
export function setStreamOpener(o: StreamOpener | null) {
  opener = o ?? fetchOpener;
}
export function openStream(url: string, on: (m: StreamMessage) => void) {
  return opener(url, on);
}
