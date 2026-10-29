// The reference panel (research-workbench P2b): the selected reference with its neighbourhood and
// quality. Selecting a chip FOCUSES it on that record; everything it shows is computed relative to
// that reference, never to the document:
//   the chunk +- N around the pinned chunk, the quote highlighted (chunkContext)
//   the neighbour strip by relationship depth around the reference's source page (neighbours)
//   the total quality with its why (quality - P3a's rolling total and its factors)
//   see all citations of this source: the user documents that link it (the listing's links)
//   a drill-down stack with its trail, and jump-and-return to where the reference was selected
// Actions follow the at-rest rule: none until a leaf is selected; inject and transclude act on the
// selected chunk (or the text selected inside it) and put the reference at the editor's cursor.
import { useEffect, useMemo, useState } from "react";
import { C, D, get, post, q } from "../../lib/api";
import { getState, setState, useWorkspace, type SelectedReference } from "../../lib/store";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";

interface Focus {
  title: string;
  state: string;
  source_id: string;
  reference_id: string | null;
  pinned: number | null;
  current: number | null;
  chunk_idx: number | null;
  quote: string;
}

type Crumb = { kind: "reference"; ref: SelectedReference; label: string } | { kind: "page"; slug: string; label: string };

async function focusOf(r: SelectedReference): Promise<Focus> {
  if (r.reference_id) {
    const x = await get(`${C}/references/${q(r.reference_id)}`);
    const rec = x.record ?? {};
    return {
      title: x.source?.title ?? x.held?.title ?? "reference", state: x.state, source_id: rec.source_id,
      reference_id: rec.id, pinned: rec.pinned_revision ?? null, current: x.version ?? null,
      chunk_idx: rec.chunk_idx ?? null, quote: rec.selectors?.quote?.exact ?? "",
    };
  }
  const x = await get(`${C}/references/${q(r.source_id)}`);
  return {
    title: x.source?.title ?? x.held?.title ?? r.source_id, state: x.state, source_id: r.source_id, reference_id: null,
    pinned: null, current: x.version ?? null, chunk_idx: r.chunk_idx ?? 0, quote: "",
  };
}

function highlight(text: string, quote: string) {
  const at = quote ? text.indexOf(quote) : -1;
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark>{quote}</mark>{text.slice(at + quote.length)}</>;
}

export function ReferencePanel(_p: PanelProps) {
  const selected = useWorkspace((s) => s.reference);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [chunks, setChunks] = useState<{ idx: number; content: string; is_target: boolean }[]>([]);
  const [strip, setStrip] = useState<{ id: string; title: string; page_class: string; distance: number }[]>([]);
  const [quality, setQuality] = useState<{ value: number | null; factors: { name: string; value: number; reason: string }[] } | null>(null);
  const [cites, setCites] = useState<{ path: string; title: string }[]>([]);
  const [depth, setDepth] = useState(1);
  const [window_, setWindow] = useState(1);
  const [trail, setTrail] = useState<Crumb[]>([]);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!selected) return;
    let live = true;
    setMsg("");
    focusOf(selected).then((f) => {
      if (!live) return;
      setFocus(f);
      setTrail((t) => t.length && t[t.length - 1].kind === "reference" && (t[t.length - 1] as any).ref === selected
        ? t : [...t.slice(-8), { kind: "reference", ref: selected, label: f.title }]);
    }).catch((e) => live && setMsg(String((e as Error).message)));
    return () => {
      live = false;
    };
  }, [selected]);

  useEffect(() => {
    if (!focus?.source_id) return;
    let live = true;
    const sid = focus.source_id;
    // the strip is relative to THIS reference: its source's page and that page's neighbours
    get(`${C}/neighbours?id=${q(`content/source/${sid}`)}&depth=${depth}&limit=40`)
      .then((r) => live && setStrip(r.nodes.filter((n: any) => n.distance > 0))).catch(() => live && setStrip([]));
    get(`${C}/sources/${q(sid)}/quality`).then((r) => live && setQuality({ value: r.score?.value ?? null, factors: r.factors ?? [] }))
      .catch(() => live && setQuality(null));
    get(`${D}/citations?source_id=${q(sid)}`).then((r) => live && setCites(r.documents)).catch(() => live && setCites([]));
    if (focus.chunk_idx !== null) {
      get(`${C}/chunks/${q(`${sid}:${focus.chunk_idx}`)}/context?window=${window_}`).then((r) => live && setChunks(r.chunks)).catch(() => live && setChunks([]));
    } else setChunks([]);
    return () => {
      live = false;
    };
  }, [focus, depth, window_]);

  const leaves = useMemo<Leaf[]>(() => {
    if (!focus) return [];
    return [
      ...chunks.map((c) => ({
        key: `chunk:${c.idx}`, badges: c.is_target ? ["pinned chunk"] : [],
        label: <span className="ws-chunk" data-chunk={c.idx}>{focus.quote && c.is_target ? highlight(c.content, focus.quote) : c.content}</span>,
      })),
      ...(quality ? [{
        key: "quality", label: <span>quality {quality.value === null ? "n/a" : quality.value.toFixed(2)}</span>,
        detail: <ul className="ws-why">{quality.factors.map((f) => <li key={f.name}>{f.name}: {String(f.value)} - {f.reason}</li>)}</ul>,
      }] : []),
      ...strip.map((n) => ({ key: `nbr:${n.id}`, label: <span className="ws-nbr" data-neighbour={n.id}>{n.title}</span>, badges: [`depth ${n.distance}`, n.page_class] })),
      ...cites.map((d) => ({ key: `cite:${d.path}`, label: <span>cited in {d.title || d.path}</span> })),
    ];
  }, [focus, chunks, quality, strip, cites]);

  const place = async (form: "chip" | "transclusion", leaf: Leaf) => {
    const ed = getState().editor;
    if (!ed || !focus) return setMsg("open the document in the editor to place a reference at its cursor");
    const idx = Number(leaf.key.split(":")[1]);
    const chunk = chunks.find((c) => c.idx === idx);
    const sel = window.getSelection()?.toString() ?? "";
    const exact = sel && chunk?.content.includes(sel) ? sel : chunk?.content ?? "";
    const r = await post(`${D}/references`, { path: ed.path, source_id: focus.source_id, exact, chunk_idx: idx, form });
    ed.insertAtCursor(r.insert);
    setMsg(form === "chip" ? "cited at the cursor" : "transcluded at the cursor");
  };

  const repin = async () => {
    const ed = getState().editor;
    if (!ed || !focus?.reference_id) return;
    const r = await post(`${D}/references/${focus.reference_id}/repin?path=${q(ed.path)}`);
    const old = `{{ref:${focus.reference_id}}}`;
    // only THIS transclusion: its opening marker carries the old id; chips broken out of it keep theirs
    const doc = getState().editor;
    const ok = doc?.replaceText(`${old}${focus.quote}{{/ref}}`, r.insert);
    setMsg(ok ? "re-pinned to the current revision" : "no transclusion of this reference to re-pin (a chip stays frozen to its pin)");
  };

  const actions = (leaf: Leaf) => {
    if (leaf.key.startsWith("chunk:")) {
      return (
        <>
          <button type="button" data-action="inject" onClick={() => place("chip", leaf)}>Inject at cursor</button>
          <button type="button" data-action="transclude" onClick={() => place("transclusion", leaf)}>Transclude at cursor</button>
          {focus?.reference_id && focus.current !== null && focus.pinned !== null && focus.current > focus.pinned && (
            <button type="button" data-action="repin" onClick={repin}>Re-pin this transclusion</button>
          )}
        </>
      );
    }
    if (leaf.key.startsWith("nbr:")) {
      const slug = leaf.key.slice(4);
      const m = /^content\/source\/(.+)$/.exec(slug);
      return (
        <button
          type="button"
          data-action="drill"
          onClick={() => {
            if (m) setState({ reference: { reference_id: null, source_id: m[1], chunk_idx: 0 } });
            else {
              setTrail((t) => [...t, { kind: "page", slug, label: slug }]);
              window.open(`/${slug}`, "_blank");
            }
          }}
        >
          {m ? "Drill down" : "Open the page"}
        </button>
      );
    }
    if (leaf.key.startsWith("cite:")) return <button type="button" data-action="open-doc" onClick={() => setState({ documentPath: leaf.key.slice(5) })}>Open the document</button>;
    return null;
  };

  if (!selected) return <div className="ws-side ws-muted">Select a citation in a document to focus this panel on it.</div>;
  const back = trail.length > 1 ? trail[trail.length - 2] : null;
  return (
    <div className="ws-side ws-reference" data-focus={focus?.reference_id ?? focus?.source_id ?? ""}>
      <div className="ws-trail" aria-label="trail">
        {trail.map((c, i) => <span key={i} className="ws-crumb">{c.label}</span>)}
        {back && back.kind === "reference" && (
          <button type="button" data-testid="trail-back" onClick={() => { setTrail((t) => t.slice(0, -2)); setState({ reference: back.ref }); }}>back</button>
        )}
        {selected.from && (
          <button type="button" data-testid="return" onClick={() => {
            const ed = getState().editor;
            if (ed && ed.path === selected.from!.path) ed.focusAt(selected.from!.pos);
            else setState({ documentPath: selected.from!.path });
          }}>return to the document</button>
        )}
      </div>
      <div className="ws-controls">
        <label>depth <input type="number" min={1} max={3} value={depth} onChange={(e) => setDepth(Number(e.target.value) || 1)} /></label>
        <label>chunks +- <input type="number" min={0} max={5} value={window_} onChange={(e) => setWindow(Number(e.target.value) || 0)} /></label>
      </div>
      <Disclosure
        testId="reference-disclosure"
        open
        summary={focus
          ? <span><strong>{focus.title}</strong> {focus.pinned !== null ? `- pinned at revision ${focus.pinned}` : ""} {focus.state === "updated" ? <span className="ws-badge">updated</span> : null}</span>
          : "loading ..."}
        leaves={leaves}
        actions={actions}
      />
      {msg && <p className="ws-muted" data-testid="reference-msg">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "reference", version: 1, title: "Reference", kind: "side", component: ReferencePanel, position: "right", defaultOpen: true });
registerNav({ id: "reference", version: 1, label: "Reference", order: 20, panel: "reference" });
