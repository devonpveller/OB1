// The frame, the router, the colour tokens and the one fetch door.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { App } from "../src/App";
import { parseRoute, navigate } from "../src/lib/router";
import { api, raw, setFetcher, requestLog, clearRequestLog, isWorkbenchUrl, ApiError } from "../src/lib/api";
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
