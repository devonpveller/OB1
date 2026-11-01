// The intake and queue panel (research-workbench P5a, rw-p5a-intake): every import, add, chunking, extraction and
// entity job, each a state machine with its phase and ONE primary action - cancel while it waits or runs, retry
// once it failed or was cancelled, open once it ended well. Over GET /workbench/intake/jobs (the import queue
// as jobs(state) answers it, the user's adds, and the chunk / extract / entity worker queues); polls while
// anything is still loading. Per user (07-MULTI-USER): the server answers the signed-in subject's jobs only;
// this panel sends no user of its own. The panel's add (IntakeAdd) is the same one the title bar's "+" and a
// refinery or document use.
import { useEffect, useMemo, useState } from "react";
import { get, post } from "../../lib/api";
import { setState } from "../../lib/store";
import { Disclosure, type Leaf } from "../../shell/Disclosure";
import { registerNav, registerPanel, type PanelProps } from "../../shell/registry";
import { I, IntakeAdd, intakeJobUrl } from "./IntakeAdd";

export interface IntakeJob {
  kind: "import" | "add" | "chunk" | "extract" | "entity";
  id: string;
  status: string;
  state: "loading" | "current";
  created_at: string;
  updated_at: string;
  detail: {
    phase: string;
    actions: ("retry" | "cancel")[];
    primary: "retry" | "cancel" | "open" | "wait";
    title?: string;
    url?: string | null;
    filename?: string | null;
    error?: string | null;
    origin?: string;
    refinery_id?: string | null;
    doc_path?: string | null;
    held_source_id?: string | null;
    source_id?: string | null;
    thought_id?: number;
    content_type?: string | null;
  };
}

export const KIND_LABEL: Record<IntakeJob["kind"], string> = {
  import: "import", add: "add", chunk: "chunking", extract: "extraction", entity: "entities",
};
export const POLL_MS = 3000;

export function jobName(j: IntakeJob): string {
  const d = j.detail;
  return d.title || d.url || d.filename || (d.thought_id !== undefined ? `thought ${d.thought_id}` : "") || d.source_id || j.id;
}

export function IntakePanel(_p: PanelProps) {
  const [jobs, setJobs] = useState<IntakeJob[]>([]);
  const [msg, setMsg] = useState("");
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  useEffect(() => {
    let live = true;
    get(`${I}/jobs?limit=100`).then((r) => live && setJobs(r.jobs ?? [])).catch((e) => live && setMsg(String((e as Error).message)));
    return () => {
      live = false;
    };
  }, [tick]);
  const loading = jobs.some((j) => j.state === "loading");
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(refresh, POLL_MS);
    return () => clearTimeout(t);
  }, [loading, jobs]);

  const act = async (j: IntakeJob, what: "retry" | "cancel") => {
    try {
      await post(`${intakeJobUrl(j.kind, j.id)}/${what}`);
      setMsg(`${what === "retry" ? "retrying" : "cancelled"}: ${jobName(j)}`);
    } catch (e) {
      setMsg(String((e as Error).message));
    }
    refresh();
  };

  const leaves = useMemo<Leaf[]>(() => jobs.map((j) => ({
    key: `${j.kind}:${j.id}`,
    label: <span data-job={`${j.kind}:${j.id}`} data-phase={j.detail.phase}>{KIND_LABEL[j.kind]}: {jobName(j)}</span>,
    badges: [j.detail.phase, ...(j.detail.origin === "owui" ? ["from OWUI"] : [])],
    detail: <span>{j.detail.error ? `${j.detail.error}. ` : ""}{j.detail.primary === "wait" ? "running - it finishes or fails on its own" : ""}</span>,
  })), [jobs]);

  const actions = (l: Leaf) => {
    const j = jobs.find((x) => `${x.kind}:${x.id}` === l.key);
    if (!j) return null;
    const btn = (what: "retry" | "cancel") => (
      <button key={what} type="button" data-action={what} className={j.detail.primary === what ? "ws-primary" : ""} onClick={() => act(j, what)}>
        {what === "retry" ? "Retry" : "Cancel"}
      </button>
    );
    return (
      <>
        {j.detail.actions.map(btn)}
        {j.detail.primary === "open" && j.detail.held_source_id && (
          <button type="button" data-action="open" className="ws-primary"
            onClick={() => setState({ reference: { reference_id: null, source_id: j.detail.held_source_id!, chunk_idx: 0 } })}>Open</button>
        )}
        {j.detail.primary === "open" && !j.detail.held_source_id && j.detail.source_id && (
          <button type="button" data-action="open" className="ws-primary"
            onClick={() => setState({ reference: { reference_id: null, source_id: j.detail.source_id!, chunk_idx: 0 } })}>Open</button>
        )}
      </>
    );
  };

  const failed = jobs.filter((j) => j.detail.actions.includes("retry")).length;
  const running = jobs.filter((j) => j.state === "loading").length;
  return (
    <div className="ws-side ws-intake">
      <IntakeAdd onAdded={refresh} testId="intake-panel-add" />
      <Disclosure
        testId="intake-disclosure"
        summary={<span data-testid="intake-summary">intake: {jobs.length} job(s), {running} running, {failed} to retry</span>}
        leaves={leaves}
        actions={actions}
        empty="no import, add or queue job"
      />
      {msg && <p className="ws-muted" data-testid="intake-msg">{msg}</p>}
    </div>
  );
}

registerPanel({ id: "intake", version: 1, title: "Intake", kind: "side", component: IntakePanel, position: "right" });
registerNav({ id: "intake", version: 1, label: "Intake", order: 55, panel: "intake" });
