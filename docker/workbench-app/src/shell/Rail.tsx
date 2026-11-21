// The left menu: Everywhere (teal), the Last / Locked document slot (amber), Housekeeping (grey).
import { ROUTES, OVERVIEW_PATH, activeMenuPath, type Group } from "../routes";
import type { DocRef } from "../lib/state";
import { countText, type ShellData } from "../lib/shell-data";
import type { ThemeChoice } from "../lib/theme";
import { Link } from "./Link";

const dot: Record<Group, string> = { everywhere: "dot", housekeeping: "hdot" };

function countOf(path: string, d: ShellData): string | null {
  if (path === "/research" && d.running !== undefined) return countText(d.running, "running");
  if (path === "/imports" && d.failedJobs !== undefined) return countText(d.failedJobs, "failed");
  if (path === "/cleanup" && d.cleanup !== undefined) return countText(d.cleanup, "to review");
  return null;
}

function Item({ path, label, group, current, d }: { path: string; label: string; group: Group; current: string | null; d: ShellData }) {
  const on = current === path;
  const c = countOf(path, d);
  return (
    <Link to={path} className={"nav" + (on ? " on" : "")} aria-current={on ? "page" : undefined} data-testid={`nav-${path === "/" ? "home" : path.slice(1)}`}>
      <span className={dot[group]} aria-hidden="true" />
      <span className="nav-label">{label}</span>
      {c && <span className="count" data-testid={`count-${path.slice(1)}`}>{c}</span>}
    </Link>
  );
}

export function Rail({ path, d, locked, last, theme, onTheme }:
  { path: string; d: ShellData; locked: DocRef | null; last: DocRef | null; theme: ThemeChoice; onTheme: () => void }) {
  const current = activeMenuPath(path);
  const slot = locked ?? last;
  const section = (g: Group) => ROUTES.filter((r) => r.inMenu && r.group === g);
  return (
    <nav className="rail" aria-label="Main" data-testid="rail">
      <div className="sec" id="sec-everywhere">Everywhere</div>
      {section("everywhere").map((r) => <Item key={r.path} path={r.path} label={r.label} group="everywhere" current={current} d={d} />)}
      <div className={"sec" + (locked ? " sec-doc" : "")} data-testid="doc-slot-title">{locked ? "Locked document" : "Last document"}</div>
      {slot
        ? <Link to={"/documents/" + encodeURIComponent(slot.id)} className={"nav don" + (path === "/documents/" + slot.id.replace(/\//g, "%2F") ? " on" : "")} data-testid="doc-slot"><span className="ddot" aria-hidden="true" /><span className="nav-title" title={slot.title}>{slot.title}</span></Link>
        : <div className="nav none" data-testid="doc-slot-empty">No document opened yet</div>}
      <div className="sec">Housekeeping</div>
      {section("housekeeping").map((r) => <Item key={r.path} path={r.path} label={r.label} group="housekeeping" current={current} d={d} />)}
      <div className="rail-foot">
        <Link to={OVERVIEW_PATH} className={"nav quiet" + (current === OVERVIEW_PATH ? " on" : "")} aria-current={current === OVERVIEW_PATH ? "page" : undefined} data-testid="nav-overview">What moved where</Link>
        <button type="button" data-testid="theme" onClick={onTheme}>Colours: {theme}</button>
      </div>
    </nav>
  );
}
