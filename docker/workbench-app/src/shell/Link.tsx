import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { navigate } from "../lib/router";

// An in-app link: a real <a href> (so middle-click, copy link and screen readers work) that navigates
// without a page load on a plain left click.
export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={go} {...rest} />;
}
