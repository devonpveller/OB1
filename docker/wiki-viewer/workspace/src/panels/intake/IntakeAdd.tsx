// The panel's add (research-workbench P5a, rw-p5a-intake; ingestion brainstorm 2026-09-25, agreed 19:59): the ONE
// add every inlet enters - POST /workbench/intake/add. Nothing typed beyond the link: a link, a picked file or a
// dropped one. The research service fetches the link (its proxy-bound fetch); the source lands HELD in an idea
// refinery, never admitted on arrival and never a watch proposal.
//   general     (the title bar's "+"): asks which existing refinery it joins - it creates none
//   contextual  (inside a refinery, or a document): has it - `refineryId` (the refinery open) or `path` (the
//               document, whose refinery it is)
// Declared content types: web page, PDF, YouTube transcript (GET /workbench/intake/content-types); a file is a
// PDF or a saved web page. The add names no user: the server's identity seam decides whose it is.
import { useEffect, useState } from "react";
import { C, get, postForm, q } from "../../lib/api";
import { openPanel } from "../../shell/dock";

interface Refinery {
  id: string;
  title: string;
  status: string;
}
interface CType {
  key: string;
  label: string;
  link: boolean;
  file: boolean;
}

export const I = "/workbench/intake";

export function IntakeAdd(props: { refineryId?: string | null; path?: string | null; onAdded?: (jobId: string) => void; testId?: string }) {
  const contextual = !!(props.refineryId || props.path);
  const [refineries, setRefineries] = useState<Refinery[] | null>(null);
  const [rid, setRid] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [types, setTypes] = useState<CType[]>([]);
  const [type, setType] = useState("");
  const [msg, setMsg] = useState("");
  const [over, setOver] = useState(false);
  useEffect(() => {
    let live = true;
    get(`${I}/content-types`).then((r) => live && setTypes(r.content_types ?? [])).catch(() => {});
    if (!contextual) {
      get(`${C}/ideas?limit=200`).then((r) => live && setRefineries((r.ideas ?? []).filter((i: Refinery) => i.status !== "archived")))
        .catch(() => live && setRefineries([]));
    }
    return () => {
      live = false;
    };
  }, [contextual]);

  const add = async (picked?: File | null) => {
    const f = picked ?? file;
    setMsg("");
    const fd = new FormData();
    if (f) fd.append("file", f);
    else fd.append("url", url.trim());
    if (props.refineryId) fd.append("refinery_id", props.refineryId);
    else if (props.path) fd.append("path", props.path);
    else fd.append("refinery_id", rid);
    if (type) fd.append("content_type", type);
    try {
      const r = await postForm(`${I}/add`, fd);
      setMsg(`added: ${f ? f.name : url.trim()} - fetching, then held in the refinery (see Intake)`);
      setUrl("");
      setFile(null);
      props.onAdded?.(r.job_id);
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  };
  const needsRefinery = !contextual && !rid;
  const tid = props.testId ?? (contextual ? "intake-add-here" : "intake-add");
  if (!contextual && refineries && refineries.length === 0) {
    return <p className="ws-muted" data-testid={`${tid}-none`}>No idea refinery yet: open a document's refinery first, then add links to it.</p>;
  }
  return (
    <form
      className={`ws-intake-add${over ? " ws-drop-over" : ""}`}
      data-testid={tid}
      data-contextual={contextual ? "1" : "0"}
      onSubmit={(e) => { e.preventDefault(); if (!needsRefinery && (url.trim() || file)) add(); }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer?.files?.[0];
        const link = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain") || "";
        if (needsRefinery) return setMsg("choose the refinery it joins first");
        if (f) add(f);
        else if (/^https?:\/\//i.test(link.trim())) { setUrl(link.trim()); }
      }}
    >
      {!contextual && (
        <label>
          Which refinery does it join?
          <select value={rid} onChange={(e) => setRid(e.target.value)} required data-testid={`${tid}-refinery`}>
            <option value="">choose an existing refinery</option>
            {(refineries ?? []).map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
          </select>
        </label>
      )}
      <input type="url" placeholder="paste a link (web page, PDF or YouTube video) or drop one here" value={url}
        onChange={(e) => { setUrl(e.target.value); setFile(null); }} data-testid={`${tid}-url`} />
      <input type="file" accept="application/pdf,.pdf,.html,.htm" data-testid={`${tid}-file`}
        onChange={(e) => { setFile(e.target.files?.[0] ?? null); setUrl(""); }} />
      {types.length > 0 && (
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="content type" data-testid={`${tid}-type`}>
          <option value="">any of: {types.map((t) => t.label).join(", ")}</option>
          {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      )}
      <button type="submit" disabled={needsRefinery || (!url.trim() && !file)}>Add to the refinery</button>
      <button type="button" className="ws-linkish" onClick={() => openPanel("intake")}>Intake</button>
      {msg && <p className="ws-muted" data-testid={`${tid}-msg`}>{msg}</p>}
    </form>
  );
}

export const intakeJobUrl = (kind: string, id: string) => `${I}/jobs/${q(kind)}/${q(id)}`;
