// rw-identity, the workspace half (over a fake back end, helpers.ts): the sign-in screen, the account
// menu, the impersonation banner, the admin panel's reason-first rule and the audit view.
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type Me, impersonate, loadMe, needsSignIn, setMe, signInHref } from "../src/lib/auth";
import { AccountMenu, AdminPanel, ImpersonationBanner, SignIn } from "../src/shell/Identity";
import { fakeApi, settle } from "./helpers";

const base: Me = {
  mode: "oidc", signed_in: true, kind: "user", subject_sub: "ak-alice", actor_sub: "ak-alice", name: "Alice", actor_name: "Alice",
  admin: false, impersonating: null, login: "/workbench/auth/login", logout: "/workbench/auth/logout",
};

afterEach(() => {
  cleanup();
  setMe(null);
});

describe("rw-identity: signed in first", () => {
  it("with sign-in on and no session the workspace shows only the sign-in link, returning to where the user was", async () => {
    fakeApi([["GET", "/workbench/auth/me", () => ({ ...base, signed_in: false, subject_sub: null })]]);
    const me = await loadMe();
    expect(needsSignIn(me)).toBe(true);
    render(<SignIn here="/workspace/?doc=documents/x.md" />);
    expect(screen.getByTestId("sign-in").getAttribute("href")).toBe(signInHref("/workspace/?doc=documents/x.md"));
    expect(signInHref("/workspace/?doc=documents/x.md")).toBe("/workbench/auth/login?return_to=%2Fworkspace%2F%3Fdoc%3Ddocuments%2Fx.md");
  });

  it("no sign-in configured (or an older workbench without /workbench/auth) = the workspace as before", async () => {
    fakeApi([["GET", "/workbench/auth/me", () => ({ ...base, mode: "default", signed_in: true })]]);
    expect(needsSignIn(await loadMe())).toBe(false);
    fakeApi([]);
    expect(await loadMe()).toBe(null);
    expect(needsSignIn(null)).toBe(false);
    render(<AccountMenu />);
    expect(screen.queryByTestId("sign-out")).toBeNull();
  });

  it("the account menu: the user's name and sign out; Admin only for admins", () => {
    setMe(base);
    const { unmount } = render(<AccountMenu />);
    expect(screen.getByTestId("account-name").textContent).toBe("Alice");
    expect(screen.getByTestId("sign-out")).toBeTruthy();
    expect(screen.queryByTestId("admin")).toBeNull();
    unmount();
    setMe({ ...base, admin: true });
    render(<AccountMenu />);
    expect(screen.getByTestId("admin")).toBeTruthy();
  });
});

describe("rw-identity: impersonation", () => {
  it("the banner is shown while impersonating - whom, who, why - and End switches back", async () => {
    const { bodies } = fakeApi([["POST", "/workbench/auth/impersonate/end", () => ({ impersonating: null })]]);
    setMe({ ...base, admin: true, subject_sub: "ak-bob", name: "Bob", actor_sub: "ak-admin", actor_name: "Admin", impersonating: { sub: "ak-bob", name: "Bob", reason: "ticket 42", since: "now" } });
    let ended = 0;
    render(<ImpersonationBanner onEnd={() => ended++} />);
    const b = screen.getByTestId("impersonation-banner");
    expect(b.getAttribute("role")).toBe("alert");
    expect(b.textContent).toContain("Viewing as Bob");
    expect(b.textContent).toContain("Admin");
    expect(b.textContent).toContain("ticket 42");
    await act(async () => { fireEvent.click(screen.getByTestId("end-impersonation")); await settle(); });
    expect(bodies.map((x) => `${x.method} ${x.url}`)).toContain("POST /workbench/auth/impersonate/end");
    expect(ended).toBe(1);
  });

  it("no banner when not impersonating", () => {
    setMe(base);
    render(<ImpersonationBanner />);
    expect(screen.queryByTestId("impersonation-banner")).toBeNull();
  });

  it("the admin panel: Impersonate stays disabled until a user AND a reason are given; then it sends both", async () => {
    const { bodies } = fakeApi([
      ["GET", "/workbench/auth/users", () => ({ users: [{ sub: "ak-admin", name: "Admin" }, { sub: "ak-bob", name: "Bob", email: "" }] })],
      ["POST", "/workbench/auth/impersonate", (_u, b) => ({ impersonating: { sub: b.sub, reason: b.reason } })],
    ]);
    setMe({ ...base, admin: true, actor_sub: "ak-admin", subject_sub: "ak-admin" });
    let switched = 0;
    render(<AdminPanel onSwitch={() => switched++} />);
    await act(async () => { await settle(); });
    const start = screen.getByTestId("imp-start") as HTMLButtonElement;
    expect([...(screen.getByTestId("imp-user") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["", "ak-bob"]);
    expect(start.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("imp-user"), { target: { value: "ak-bob" } });
    expect(start.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("imp-reason"), { target: { value: "ab " } });
    expect(start.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("imp-reason"), { target: { value: "\u200b\u200b\u200b\u200b\u200b\u200b\u200b\u200b\u200b" } });
    expect(start.disabled).toBe(true); // round 4: zero-width characters are not a reason
    fireEvent.change(screen.getByTestId("imp-reason"), { target: { value: "abcdefg" } });
    expect(start.disabled).toBe(true); // 8 visible characters at least
    fireEvent.change(screen.getByTestId("imp-reason"), { target: { value: "support ticket 42" } });
    expect(start.disabled).toBe(false);
    await act(async () => { fireEvent.click(start); await settle(); });
    expect(bodies.find((x) => x.url === "/workbench/auth/impersonate")?.body).toEqual({ sub: "ak-bob", reason: "support ticket 42" });
    expect(switched).toBe(1);
  });

  it("the client never sends an impersonation without a reason", async () => {
    const { bodies } = fakeApi([["POST", "/workbench/auth/impersonate", () => ({})]]);
    await expect(impersonate("ak-bob", "  ")).rejects.toThrow(/reason/);
    await expect(impersonate("ak-bob", "")).rejects.toThrow(/reason/);
    await expect(impersonate("ak-bob", "\u200b\u200b\u200b\u200b\u200b\u200b\u200b\u200b")).rejects.toThrow(/reason/);
    expect(bodies.length).toBe(0);
  });

  it("the audit view lists the log: when, admin, user, action, reason, request", async () => {
    fakeApi([
      ["GET", "/workbench/auth/users", () => ({ users: [] })],
      ["GET", "/workbench/auth/audit", () => ({ entries: [
        { id: 2, at: "2026-10-29 10:01", actor_sub: "ak-admin", subject_sub: "ak-bob", action: "request", reason: "ticket 42", method: "GET", route: "/workbench/contract/documents" },
        { id: 1, at: "2026-10-29 10:00", actor_sub: "ak-admin", subject_sub: "ak-bob", action: "impersonate.start", reason: "ticket 42", method: null, route: null },
      ] })],
    ]);
    setMe({ ...base, admin: true });
    render(<AdminPanel />);
    await act(async () => { fireEvent.click(screen.getByTestId("audit-load")); await settle(); });
    const rows = screen.getByTestId("audit-table").querySelectorAll("tbody tr");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("GET /workbench/contract/documents");
    expect(rows[1].textContent).toContain("impersonate.start");
  });
});
