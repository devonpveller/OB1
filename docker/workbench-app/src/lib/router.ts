// A path router: the URL is the state (/documents/x is a deep link the server answers with the index).
// No library; later items add the real route table. parseRoute is pure so it is unit-tested.
import { useEffect, useState } from "react";

// `segments` are decoded one by one AFTER the split, so an encoded slash (%2F, in a document path) stays inside its
// segment; `path` re-encodes only that slash, so route matching (which splits `path`) sees the same segments.
// A segment that does not decode (a malformed %-escape) makes the route `bad`: the screen says "no such screen".
export type Route = { path: string; segments: string[]; bad?: boolean };

export function parseRoute(pathname: string): Route {
  const raw = (pathname.split(/[?#]/)[0] || "/").split("/").filter(Boolean);
  const segments: string[] = [];
  let bad = false;
  for (const r of raw) {
    try { segments.push(decodeURIComponent(r)); } catch { segments.push(r); bad = true; }
  }
  const path = "/" + segments.map((x) => x.replace(/\//g, "%2F")).join("/");
  return bad ? { path, segments, bad } : { path, segments };
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
