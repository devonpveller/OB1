// The hub context of the open document (D1, settled 2026-09-25 17:45): the topic neighbourhoods its
// outbound links fall into, COMPUTED from the graph on read (GET /workbench/documents/hub-context),
// each named by its computed centre, marked thin or contested. The document is an authored focus onto
// hubs, never a hub; nothing here is stored.
import { useEffect, useMemo, useState } from "react";
import { D, get, post, q } from "../../lib/api";
import { useWorkspace } from "../../lib/store";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";

interface Hub {
  centre: { slug: string; title: string; page_class: string | null };
  seeds: string[];
  links: { kind: string; id: string }[];
  sources: number;
  thin: boolean;
  contested: boolean;
  why: string[];
}

export function HubsPanel(_p: PanelProps) {
  const path = useWorkspace((s) => s.documentPath);
  const rev = useWorkspace((s) => s.documentRev);
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (!path) return;
    get(`${D}/hub-context?path=${q(path)}`).then((r) => setHubs(r.hubs)).catch((e) => setMsg(String((e as Error).message)));
  }, [path, rev]);
  const leaves = useMemo<Leaf[]>(() => hubs.map((h) => ({
    key: h.centre.slug,
    label: <span data-hub={h.centre.slug}>{h.centre.title}</span>,
    badges: [...(h.thin ? ["thin"] : []), ...(h.contested ? ["contested"] : [])],
    detail: <ul className="ws-why">{h.why.map((w) => <li key={w}>{w}</li>)}<li>{h.links.length} of the document's links fall here</li></ul>,
  })), [hubs]);
  const queue = async (h: Hub, kind: "research" | "gap") => {
    const r = await post(`${D}/research`, {
      path, kind, query: kind === "gap" ? `What is thin or contested around ${h.centre.title}?` : `More on ${h.centre.title}`,
    });
    setMsg(`${kind} queued (${r.job_id.slice(0, 8)})`);
  };
  if (!path) return <div className="ws-side ws-muted">Open a document to see the hubs it touches.</div>;
  return (
    <div className="ws-side ws-hubs">
      <Disclosure
        testId="hubs-disclosure"
        summary={<span>touches {hubs.length} hub{hubs.length === 1 ? "" : "s"} (computed now)</span>}
        leaves={leaves}
        actions={(l) => {
          const h = hubs.find((x) => x.centre.slug === l.key)!;
          return (
            <>
              <a data-action="open-centre" href={`/${h.centre.slug}`} target="_blank" rel="noopener">Open the centre page</a>
              <button type="button" data-action="research" onClick={() => queue(h, "research")}>Queue research here</button>
              <button type="button" data-action="gap" onClick={() => queue(h, "gap")}>Open a gap session</button>
            </>
          );
        }}
        empty="the document links nothing in the graph yet"
      />
      {msg && <p className="ws-muted">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "hubs", version: 1, title: "Hubs", kind: "side", component: HubsPanel, position: "right" });
registerNav({ id: "hubs", version: 1, label: "Hubs", order: 40, panel: "hubs" });
