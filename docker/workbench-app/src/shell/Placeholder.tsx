import type { RouteDef } from "../routes";
import { Link } from "./Link";

// A screen that is not built yet says so plainly, with what it will be and the phase that builds it.
export function Placeholder({ def }: { def: RouteDef }) {
  return (
    <section className="screen" data-testid="placeholder" data-phase={def.phase}>
      <h1>{def.label}</h1>
      <div className="card soon">
        <p className="soon-line" data-testid="coming">This screen is coming in phase {def.phase}.</p>
        <p>{def.will}</p>
        {def.path !== "/" && <Link to="/">Back to Home</Link>}
      </div>
    </section>
  );
}

export function NotFound({ path }: { path: string }) {
  return (
    <section className="screen" data-testid="not-found">
      <h1>No such screen</h1>
      <div className="card soon">
        <p>There is nothing at <code>{path}</code>.</p>
        <Link to="/">Back to Home</Link>
      </div>
    </section>
  );
}
