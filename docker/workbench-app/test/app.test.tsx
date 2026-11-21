// The frame, the router, the colour tokens and the one fetch door.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { App } from "../src/App";
import { parseRoute, navigate } from "../src/lib/router";
import { api, raw, setFetcher, requestLog, clearRequestLog, isWorkbenchUrl, ApiError } from "../src/lib/api";
import config from "../vite.config";
import { applyTheme, readTheme } from "../src/lib/theme";

beforeEach(() => {
  cleanup();
  clearRequestLog();
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
  window.history.pushState({}, "", "/");
});

describe("the frame", () => {
  it("says what it is and shows the route; on mount it makes no request at all", () => {
    const seen: string[] = [];
    setFetcher(async (u) => { seen.push(u); return new Response("{}"); });
    window.history.pushState({}, "", "/documents/x");
    render(<App />);
    expect(screen.getByTestId("what").textContent).toMatch(/empty frame/);
    expect(screen.getByTestId("route").textContent).toBe("/documents/x");
    expect(seen).toEqual([]);
    expect(requestLog()).toEqual([]);
  });
  it("follows navigation", () => {
    render(<App />);
    act(() => navigate("/research"));
    expect(screen.getByTestId("route").textContent).toBe("/research");
  });
});

describe("the router", () => {
  it("parses paths", () => {
    expect(parseRoute("/")).toEqual({ path: "/", segments: [] });
    expect(parseRoute("/documents/x?y=1#z")).toEqual({ path: "/documents/x", segments: ["documents", "x"] });
    expect(parseRoute("//a///b/")).toEqual({ path: "/a/b", segments: ["a", "b"] });
    expect(parseRoute("/a%20b")).toEqual({ path: "/a b", segments: ["a b"] });
  });
});

describe("the fetch door: same-origin /workbench/* only (asserted over the request log)", () => {
  it("logs and sends a /workbench/ request, same-origin credentials", async () => {
    let init: RequestInit | undefined;
    setFetcher(async (_u, i) => { init = i; return new Response(JSON.stringify({ a: 1 }), { status: 200 }); });
    const r = await api("GET", "/workbench/workspace/whoami");
    expect(r.data).toEqual({ a: 1 });
    expect(init?.credentials).toBe("same-origin");
    await raw("/workbench/export/x");
    expect(requestLog().map((x) => x.url)).toEqual(["/workbench/workspace/whoami", "/workbench/export/x"]);
    expect(requestLog().every((x) => x.url.startsWith("/workbench/"))).toBe(true);
  });
  it("refuses everything else before any request is made", async () => {
    const sent: string[] = [];
    setFetcher(async (u) => { sent.push(u); return new Response("{}"); });
    const bad = ["https://evil.example/workbench/x", "//evil.example/workbench/x", "/other", "/workbench", "workbench/x",
      "/workbench/../admin", "/workbench/%2e%2e/admin", "/workbench/..%2fadmin", "/workbench/a\\b", "/workbench/%5c", "http://localhost/workbench/x"];
    for (const u of bad) {
      expect(isWorkbenchUrl(u), u).toBe(false);
      await expect(api("GET", u)).rejects.toBeInstanceOf(ApiError);
      await expect(raw(u)).rejects.toBeInstanceOf(ApiError);
    }
    expect(sent).toEqual([]);
    expect(requestLog()).toEqual([]);
  });
  // rwr-app-scaffold round 2 (tester Case 3): fetch() strips ASCII tab / CR / LF from a URL BEFORE it
  // resolves dot-segments, so a guard that reads the raw string can pass "/workbench/.\t./admin" while the
  // browser requests /admin. The guard refuses control characters, space and backslash outright and judges
  // the RESOLVED URL; the log holds the resolved path, i.e. what leaves.
  it("refuses tab / CR / LF-split dot-segments and their encodings (the browser strips the raw ones)", async () => {
    const sent: string[] = [];
    setFetcher(async (u) => { sent.push(u); return new Response("{}"); });
    const bad = ["/workbench/.\t./admin", "/workbench/.\n./admin", "/workbench/\t../admin", "/workbench/..\n/admin",
      "/workbench/x/.\r./.\r./admin", "/workbench/%2e\t%2e/admin",
      "/workbench/.%09./admin", "/workbench/.%0a./admin", "/workbench/.%0d./admin", "/workbench/%2e%09%2e/admin",
      "/workbench/%09../admin", "/workbench/..%0a/admin", "/workbench/a b", "/workbench/a%20b/../../admin", "/workbench/a/./b",
      "/workbench/%25%252e%252e/../admin", "/workbench/a%25b/%252e%252e/%252e%252e/admin", "/workbench/%252e%252e/admin", "/workbench/100%25%0a",
      "/workbench/\u0000x", "/workbench/%00", "/workbench/x\u007f", "/workbench/%7f"];
    for (const u of bad) {
      expect(isWorkbenchUrl(u), JSON.stringify(u)).toBe(false);
      await expect(api("GET", u)).rejects.toBeInstanceOf(ApiError);
      await expect(raw(u)).rejects.toBeInstanceOf(ApiError);
    }
    expect(sent).toEqual([]);
    expect(requestLog()).toEqual([]);
  });
  // rwr-app-scaffold round 3 (tester attempt 2, Case 13b): real ids and note paths hold spaces and a literal %.
  // rwr-app-scaffold round 4 (reviewer 1): a path still changing after the 6 decode passes is refused.
  it("refuses '..' encoded 6, 7 and 8 times (too deeply encoded) as it refuses depths 1-5", async () => {
    const sent: string[] = [];
    setFetcher(async (u) => { sent.push(u); return new Response("{}"); });
    let s = "%2e%2e";
    for (let n = 1; n <= 8; n++) {
      const u = "/workbench/" + s + "/admin";
      expect(isWorkbenchUrl(u), "depth " + n).toBe(false);
      await expect(api("GET", u)).rejects.toBeInstanceOf(ApiError);
      s = s.replace(/%/g, "%25");
    }
    expect(sent).toEqual([]);
  });
  it("accepts real id and note-path shapes: %20, a decoded space, a literal % as %25", async () => {
    const sent: string[] = [];
    setFetcher(async (u) => { sent.push(u); return new Response("{}"); });
    const enc = encodeURIComponent;
    const good = ["/workbench/notes/Research/My%20Note.md", "/workbench/notes/" + "a/100% done.md".split("/").map(enc).join("/"),
      "/workbench/sources/src%20abc", "/workbench/notebooks/thread%201%2F2", "/workbench/ideas/id%201/draft", "/workbench/notes/a%20b",
      "/workbench/notes/50%25.md", "/workbench/notes/a/%25%20", "/workbench/documents/file?path=My%20Doc.md", "/workbench/search?q=hello%20world%20..%2Fx",
      "/workbench/nav?folder=Research%2FMy%20Notes", "/workbench/notes/a/..hidden.md", "/workbench/notes/a/b.md", "/workbench/contract/documents/doc%3A1",
      "/workbench/notes/a/caf%C3%A9.md", "/workbench/notes/a/x%2Fy", "/workbench/sources/3f2c0a9e-1111-4222-8333-444455556666"];
    for (const u of good) {
      expect(isWorkbenchUrl(u), u).toBe(true);
      await api("GET", u);
    }
    expect(sent).toEqual(good);
    expect(requestLog().map((x) => x.url)).toEqual(good);
  });
  it("what is sent and logged is the RESOLVED path, always under /workbench/", async () => {
    const sent: string[] = [];
    setFetcher(async (u) => { sent.push(u); return new Response("{}"); });
    await api("GET", "/workbench/a/b?x=1#frag");
    await api("GET", "/workbench/documents/x%2Fy?q=%2e%2e");
    for (const u of sent) expect(new URL(u, location.origin).pathname.startsWith("/workbench/"), u).toBe(true);
    expect(requestLog().map((x) => x.url)).toEqual(sent);
    expect(sent[0]).toBe("/workbench/a/b?x=1");
    expect(requestLog()[0].url).toBe("/workbench/a/b?x=1");
    expect(isWorkbenchUrl("/workbench/")).toBe(true);
    expect(isWorkbenchUrl("/workbench/..foo/x")).toBe(true);
  });
  it("turns a non-2xx into an ApiError carrying the body", async () => {
    setFetcher(async () => new Response(JSON.stringify({ error: "nope" }), { status: 403 }));
    await expect(api("GET", "/workbench/x")).rejects.toMatchObject({ status: 403, message: "nope" });
  });
});

describe("light and dark tokens", () => {
  const css = readFileSync("src/theme/tokens.css", "utf8");
  it("carries the approved light values", () => {
    for (const v of ["#f6f5f1", "#0f6e6e", "#b06a00"]) expect(css.toLowerCase()).toContain(v);
    expect(css).toContain("IBM Plex Sans");
    expect(css).toContain("IBM Plex Mono");
  });
  it("defines the same token names for light, system-dark and explicit dark", () => {
    const names = (block: string) => [...block.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]).filter((n) => !n.startsWith("font-")).sort();
    const light = names(css.slice(css.indexOf(":root {"), css.indexOf("@media")));
    const media = names(css.slice(css.indexOf("@media"), css.indexOf(':root[data-theme="dark"]')));
    const explicit = names(css.slice(css.indexOf(':root[data-theme="dark"]')));
    expect(light.length).toBeGreaterThan(10);
    expect(media).toEqual(light);
    expect(explicit).toEqual(light);
    expect(css).toContain("prefers-color-scheme: dark");
    expect(css).toContain(':root:not([data-theme="light"])');
  });
  it("an explicit choice sets data-theme and is remembered; system clears it", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(readTheme()).toBe("dark");
    applyTheme("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(readTheme()).toBe("system");
  });
  it("the button cycles system -> light -> dark -> system", () => {
    render(<App />);
    const b = screen.getByTestId("theme");
    expect(b.textContent).toContain("system");
    fireEvent.click(b); expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    fireEvent.click(b); expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(b); expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("the build", () => {
  // round 2 (tester attempt 1, finding 5): Vite's modulepreload polyfill is code the notices do not name,
  // and the frame needs none (one entry chunk); it is off.
  it("ships no modulepreload polyfill", () => {
    expect((config as any).build?.modulePreload).toEqual({ polyfill: false });
  });
});
