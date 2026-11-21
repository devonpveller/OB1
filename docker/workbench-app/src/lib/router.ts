// A path router: the URL is the state (/documents/x is a deep link the server answers with the index).
// No library; later items add the real route table. parseRoute is pure so it is unit-tested.
import { useEffect, useState } from "react";

export type Route = { path: string; segments: string[] };

export function parseRoute(pathname: string): Route {
  let p = pathname.split(/[?#]/)[0] || "/";
  try { p = decodeURIComponent(p); } catch { /* keep the raw path */ }
  const segments = p.split("/").filter(Boolean);
  return { path: "/" + segments.join("/"), segments };
}

export function navigate(to: string) {
  window.history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return route;
}
