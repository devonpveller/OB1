// The link hover popover (D12 parity item 3), and the chip preview (acceptance 2: a chip broken out
// of a transclusion still previews on hover - at ITS pin - and jumps the reference panel). The
// preview is fetched when the user hovers - opening one - never when a document opens.
import { useEffect, useState } from "react";
import { C, get, q } from "../../lib/api";
import { setState } from "../../lib/store";
import { openPanel } from "../../shell/dock";

export interface PopoverState {
  anchor: DOMRect;
  target: { kind: string; id: string };
  loading: boolean;
}

export interface Preview {
  title: string;
  text: string;
  meta: string;
  source_id?: string;
  reference_id?: string;
  chunk_idx?: number | null;
}

export async function previewOf(t: { kind: string; id: string }): Promise<Preview> {
  if (t.kind === "reference") {
    const r = await get(`${C}/references/${q(t.id)}`);
    const rec = r.record ?? {};
    return {
      title: r.source?.title ?? r.held?.title ?? "reference",
      text: rec.selectors?.quote?.exact ?? "",
      meta: `pinned at revision ${rec.pinned_revision}${r.state === "updated" ? ` - revision ${r.version} exists` : ""}`,
      source_id: rec.source_id, reference_id: rec.id, chunk_idx: rec.chunk_idx ?? null,
    };
  }
  if (t.kind === "source" || t.kind === "report") {
    const r = await get(`${C}/references/${q(t.id)}`);
    return { title: r.source?.title ?? r.held?.title ?? t.id, text: r.source?.excerpt ?? r.held?.excerpt ?? "", meta: `${r.state}`, source_id: t.id };
  }
  if (t.kind === "page") {
    const r = await get(`${C}/neighbours?id=${q(t.id)}&depth=1&limit=1`);
    const root = r.nodes?.[0];
    return { title: root?.title ?? t.id, text: "", meta: root ? `${root.page_class} - ${root.state}` : "no such page yet" };
  }
  return { title: t.id, text: "", meta: t.kind };
}

export function Popover(props: { state: PopoverState; onClose: () => void; load: (t: { kind: string; id: string }) => Promise<Preview> }) {
  const [p, setP] = useState<Preview | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setP(null);
    props.load(props.state.target).then((x) => live && setP(x)).catch((e) => live && setErr(String((e as Error).message)));
    return () => {
      live = false;
    };
  }, [props.state.target.kind, props.state.target.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const style = { position: "fixed" as const, left: props.state.anchor.left, top: props.state.anchor.bottom + 6, zIndex: 50 };
  const jump = () => {
    if (!p?.source_id) return;
    setState({ reference: { reference_id: p.reference_id ?? null, source_id: p.source_id, chunk_idx: p.chunk_idx ?? null } });
    openPanel("reference");
    props.onClose();
  };
  return (
    <div className="ws-popover ws-link-popover" style={style} data-testid="popover" onMouseLeave={props.onClose}>
      {!p && !err && <span className="ws-muted">loading ...</span>}
      {err && <span className="ws-muted">{err}</span>}
      {p && (
        <>
          <strong>{p.title}</strong>
          <div className="ws-muted">{p.meta}</div>
          {p.text && <blockquote>{p.text}</blockquote>}
          {p.source_id && <button type="button" data-testid="popover-jump" onClick={jump}>Open in the reference panel</button>}
        </>
      )}
    </div>
  );
}
