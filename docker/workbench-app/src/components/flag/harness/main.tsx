// DEV-ONLY test harness for "Flag for cleanup" (rwr-flag-buttons): the caller's own flags with the link back that
// `flagBackLink` builds, as Cleanup > Flagged by you (rwr-cleanup) will show them, so a browser test can follow a link the
// builder made. Built into the image ONLY with the build arg FLAG_HARNESS=1 (vite.config.ts); the production build has no
// /flag-harness.html. Not a route of the app: it reads through lib/api.ts like everything else and keeps nothing.
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flagBackLink, readMyFlags, type MyFlag } from "../flag-data";
import "../../../styles.css";

type Row = { flag: MyFlag; href: string | null };

function Harness() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    readMyFlags().then(async (r) => {
      setTotal(r.total);
      setRows(await Promise.all(r.flags.map(async (flag) => ({ flag, href: await flagBackLink(flag.from).catch(() => null) }))));
    }, () => setFailed(true));
  }, []);
  return (
    <main className="screen" data-testid="flag-harness">
      <h1>Flagged by you</h1>
      {failed && <p data-testid="harness-failed">Could not read your flags.</p>}
      {rows && <p data-testid="harness-total">{total}</p>}
      <ul>
        {(rows ?? []).map(({ flag, href }) => (
          <li key={flag.id} data-testid="harness-row" data-kind={flag.item.kind} data-reason={flag.reason}>
            {flag.item.kind} · {flag.reason}{" "}
            {href ? <a href={href} data-testid="harness-backlink">Where you flagged it</a> : <span data-testid="harness-nolink">no link</span>}
          </li>
        ))}
      </ul>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<StrictMode><Harness /></StrictMode>);
