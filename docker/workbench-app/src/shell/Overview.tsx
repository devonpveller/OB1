// Screen 0, "What moved where": static content from the approved Overview mockup. No reads.
import { Link } from "./Link";

type Need = "nothing" | "a document" | "upkeep";
const ROWS: [string, string, Need][] = [
  ["Search", "The search bar on every screen (Ctrl K)", "nothing"],
  ["Documents, Document", "Documents, and the document view", "nothing"],
  ["Sessions, Research flow, Timeline", "Research (tree, then by date)", "nothing"],
  ["Room, Scoped chat", "Chat (scope picker)", "nothing"],
  ["Ideas, Idea, Context graph", "Ideas", "nothing"],
  ["Claims ledger, Source quality, Page graph, Reference", "Library (a source or claim opens its detail)", "nothing"],
  ["(none)", "Podcasts", "nothing"],
  ["References, Hubs, Coverage", "Inside the document: References, Topics, Coverage", "a document"],
  ["Refinery", "Inside the document: Refine (when it came from an idea)", "a document"],
  ["Properties, History, Export", "Inside the document: Details, History, Export", "a document"],
  ["Queue research, Gap session", "\"Research this\" in the document toolbar and on selected text", "a document"],
  ["Intake", "Housekeeping, Imports", "upkeep"],
  ["Trail, Cleanup", "Housekeeping, Removals and trail, Cleanup", "upkeep"],
  ["Settings", "Housekeeping, Settings", "upkeep"],
];

export function Overview() {
  return (
    <section className="screen" data-testid="overview">
      <h1>What moved where</h1>
      <p className="lead">Things that work on their own live in the left menu (teal). Tools that only make sense inside a document live inside the document (amber). Upkeep goes to Housekeeping (grey).</p>
      <div className="card">
        <table>
          <caption className="sr-only">Every panel of the old workspace and where it goes</caption>
          <thead><tr><th scope="col">Today</th><th scope="col">Goes to</th><th scope="col">Needs</th></tr></thead>
          <tbody>
            {ROWS.map(([from, to, need]) => (
              <tr key={from}>
                <td>{from}</td><td>{to}</td>
                <td><span className={"chip " + (need === "a document" ? "chip-doc" : need === "upkeep" ? "chip-up" : "chip-all")}>{need}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p><Link to="/">Back to Home</Link></p>
    </section>
  );
}
