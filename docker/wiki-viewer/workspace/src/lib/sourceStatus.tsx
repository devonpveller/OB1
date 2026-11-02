// Suppression status wherever a source is listed (research-workbench P8a-1, D5). A source is in one
// lifecycle state - active, suppressed, unlinked, erased - or held (in a refinery, before it folds in).
// Every panel that lists a source shows the state it is in when it is not plainly active: as a
// Disclosure badge (statusBadges) or inline (SourceStatus). A panel whose list does not carry the state
// asks for it in one batch through the contract (POST /contract/source-states, useSourceStates) - shared
// knowledge only: a held source or an unknown id is simply absent from the answer.
import { useEffect, useState } from "react";
import { C, post } from "./api";
import "./sourceStatus.css";

export interface SourceState {
  id: string;
  url: string | null;
  lifecycle: string;
  tombstone_id: string | null;
}

// the states that are shown: everything but plain active (and the record state "current")
export function shownStatus(lifecycle: string | null | undefined): string | null {
  if (!lifecycle || lifecycle === "active" || lifecycle === "current") return null;
  return lifecycle;
}

// Disclosure badges for a listed source: [] when active, [state] otherwise (the badge's class is
// ws-badge-<state>, so suppressed reads ws-badge-suppressed)
export function statusBadges(lifecycle: string | null | undefined): string[] {
  const s = shownStatus(lifecycle);
  return s ? [s] : [];
}

export function SourceStatus({ lifecycle }: { lifecycle: string | null | undefined }) {
  const s = shownStatus(lifecycle);
  if (!s) return null;
  return <span className={`ws-badge ws-status ws-badge-${s}`} data-lifecycle={s} title={`this source is ${s}`}>{s}</span>;
}

// The state of the sources a panel lists, by id and by URL, fetched in one call whenever the set changes.
export function useSourceStates(ids: string[], urls: string[] = []) {
  const wantIds = [...new Set(ids.filter(Boolean))].sort().slice(0, 200);
  const wantUrls = [...new Set(urls.filter(Boolean))].sort().slice(0, 200);
  const key = JSON.stringify([wantIds, wantUrls]);
  const [states, setStates] = useState<{ byId: Record<string, SourceState>; byUrl: Record<string, SourceState> }>({ byId: {}, byUrl: {} });
  useEffect(() => {
    if (!wantIds.length && !wantUrls.length) {
      setStates({ byId: {}, byUrl: {} });
      return;
    }
    let live = true;
    post(`${C}/source-states`, { ids: wantIds, urls: wantUrls })
      .then((r) => live && setStates({ byId: r?.by_id ?? {}, byUrl: r?.by_url ?? {} }))
      .catch(() => live && setStates({ byId: {}, byUrl: {} }));
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return states;
}
