#!/usr/bin/env python3
"""check_fork_owned.py - fail when an UPSTREAM change would touch what this fork owns.

Operator decision D23 (2026-10-15): intake lives in OB1 on the condition that upstream OB1
can never overwrite or collide with it. Everything intake adds is namespaced, and
integrations/intake/FORK-OWNED.md lists it in a machine-read ```fork-owned``` block:

  path:        a repo path prefix (a directory ends in "/") - any change to a file under it
  path-glob:   an fnmatch pattern over the repo path (e.g. the docker/220-* initdb slot)
  identifier:  a whole-word token (a column name), matched case-insensitively - any ADDED or
               REMOVED line naming it, in any file
  pattern:     a case-insensitive regex (the `intake` schema and role, whose bare word is
               ordinary English) - any added or removed line matching it
  reviewed-upstream: <sha>  an upstream commit a human has reviewed against this list;
               a merge bringing in exactly that parent is accepted (the committed,
               reviewable override - there is no flag that skips the check)

Modes (exit 0 = clean, 1 = violation, 2 = could not check; 2 must be read as a failure):
  --diff FILE|-        check a unified diff (what the tests use)
  --upstream REF       check what REF changed since its merge-base with --head (default HEAD)
                       - run this before merging upstream into the fork
  --range OLD..NEW     for every merge commit in the range, check what each non-first parent
                       brought in since its merge-base with the first parent - this is what
                       the ai-stack pre-commit gate runs on an OB1 gitlink bump

Limits: a change that arrives WITHOUT a merge commit (a rebase or cherry-pick onto the fork)
is indistinguishable from fork work in --range mode; run --upstream before such an import.
Only stdlib; Python 3.8+.
"""
from __future__ import annotations

import argparse
import fnmatch
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

DEFAULT_MANIFEST = Path(__file__).resolve().parent.parent / "FORK-OWNED.md"
_BLOCK = re.compile(r"^```fork-owned[ \t]*\r?\n(.*?)^```", re.S | re.M)
_SHA = re.compile(r"[0-9a-f]{7,40}")


@dataclass
class Manifest:
    paths: List[str] = field(default_factory=list)
    globs: List[str] = field(default_factory=list)
    identifiers: List[str] = field(default_factory=list)
    patterns: List[str] = field(default_factory=list)
    reviewed: List[str] = field(default_factory=list)

    def compiled(self):
        # Case-INSENSITIVE: unquoted SQL identifiers fold to lower case, so SCREEN_VERDICT is
        # screen_verdict to postgres (round 2, tester F3).
        rx = [re.compile(r"(?<![A-Za-z0-9_])" + re.escape(i) + r"(?![A-Za-z0-9_])", re.I)
              for i in self.identifiers]
        rx += [re.compile(p, re.I) for p in self.patterns]
        return rx


def load_manifest(path) -> Manifest:
    text = Path(path).read_text(encoding="utf-8")
    m = Manifest()
    blocks = _BLOCK.findall(text)
    for block in blocks:
        for raw in block.splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            key, sep, value = line.partition(":")
            value = value.strip()
            if not sep or not value:
                raise ValueError(f"{path}: unparseable fork-owned line: {raw!r}")
            key = key.strip()
            if key == "path":
                m.paths.append(value)
            elif key == "path-glob":
                m.globs.append(value)
            elif key == "identifier":
                m.identifiers.append(value)
            elif key == "pattern":
                re.compile(value)
                m.patterns.append(value)
            elif key == "reviewed-upstream":
                if not _SHA.fullmatch(value):
                    raise ValueError(f"{path}: reviewed-upstream is not a commit sha: {value!r}")
                m.reviewed.append(value)
            else:
                raise ValueError(f"{path}: unknown fork-owned key {key!r}")
    if not m.paths or not (m.identifiers or m.patterns):
        raise ValueError(f"{path}: no ```fork-owned``` block with paths and identifiers/patterns "
                         "- an empty list would pass every diff, refusing")
    return m


def _unquote(p: str) -> str:
    p = p.strip()
    if len(p) >= 2 and p[0] == '"' and p[-1] == '"':
        p = p[1:-1].encode("latin-1", "backslashreplace").decode("unicode_escape").encode(
            "latin-1", "replace").decode("utf-8", "replace")
    return p


def _strip_side(p: str) -> Optional[str]:
    p = _unquote(p)
    if p == "/dev/null":
        return None
    if p[:2] in ("a/", "b/"):
        return p[2:]
    return p


def _owned(path: Optional[str], prefixes: List[str], globs: List[str] = ()) -> Optional[str]:
    if not path:
        return None
    for g in globs:
        if fnmatch.fnmatchcase(path, g):
            return g
    for pre in prefixes:
        if pre.endswith("/"):
            if path.startswith(pre):
                return pre
        elif path == pre:
            return pre
    return None


_DIFF_GIT = re.compile(r'^diff --git ("?a/.*?"?) ("?b/.*"?)$')


def check_diff(text: str, m: Manifest) -> List[str]:
    """Return one human-readable line per violation (empty list = clean)."""
    rules = m.compiled()
    out: List[str] = []
    cur = "?"
    in_hunk = False
    seen_paths = set()

    def flag_path(p):
        hit = _owned(p, m.paths, m.globs)
        if hit and p not in seen_paths:
            seen_paths.add(p)
            out.append(f"path {p} is fork-owned ({hit})")

    for line in text.splitlines():
        if line.startswith("diff --git "):
            in_hunk = False
            g = _DIFF_GIT.match(line)
            if g:
                a, b = _strip_side(g.group(1)), _strip_side(g.group(2))
                cur = b or a or "?"
                flag_path(a)
                flag_path(b)
            continue
        if not in_hunk:
            if line.startswith(("--- ", "+++ ")):
                p = _strip_side(line[4:].split("\t")[0])
                if p:
                    cur = p
                flag_path(p)
                continue
            if line.startswith(("rename from ", "rename to ", "copy from ", "copy to ")):
                p = line.split(" ", 2)[2]
                flag_path(_unquote(p))
                continue
        if line.startswith("@@"):
            in_hunk = True
            continue
        if in_hunk and line[:1] in ("+", "-"):
            body = line[1:]
            for rx in rules:
                if rx.search(body):
                    out.append(f"{cur}: changed line names fork-owned {rx.pattern!r}: {body.strip()[:160]}")
                    break
    return out


def _git(repo, *args) -> str:
    r = subprocess.run(["git", "-C", str(repo), "-c", "core.quotepath=false", *args],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout


def _upstream_diff(repo, base: str, ref: str) -> str:
    mb = _git(repo, "merge-base", base, ref).strip()
    return _git(repo, "diff", "--no-color", "--no-ext-diff", "-M", "-U0", mb, ref)


def check_upstream(repo, ref: str, m: Manifest, head: str = "HEAD") -> List[str]:
    return [f"[upstream {ref}] {v}" for v in check_diff(_upstream_diff(repo, head, ref), m)]


def check_range(repo, rng: str, m: Manifest) -> List[str]:
    out: List[str] = []
    for merge in _git(repo, "rev-list", "--merges", rng).split():
        parents = _git(repo, "rev-list", "--parents", "-n", "1", merge).split()[1:]
        for p in parents[1:]:
            if any(p.startswith(r) for r in m.reviewed):
                continue
            for v in check_diff(_upstream_diff(repo, parents[0], p), m):
                out.append(f"[merge {merge[:10]} brings {p[:10]}] {v}")
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    ap.add_argument("--repo", default=None, help="git repo (default: the one holding the manifest)")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--diff")
    mode.add_argument("--upstream")
    mode.add_argument("--range")
    ap.add_argument("--head", default="HEAD")
    a = ap.parse_args(argv)
    try:
        m = load_manifest(a.manifest)
        repo = a.repo or Path(a.manifest).resolve().parent
        if a.diff is not None:
            text = sys.stdin.read() if a.diff == "-" else Path(a.diff).read_text(
                encoding="utf-8", errors="replace")
            violations = check_diff(text, m)
        elif a.upstream is not None:
            violations = check_upstream(repo, a.upstream, m, head=a.head)
        else:
            violations = check_range(repo, a.range, m)
    except (OSError, ValueError, RuntimeError) as e:
        print(f"check_fork_owned: COULD NOT CHECK - {e}", file=sys.stderr)
        return 2
    if violations:
        print("check_fork_owned: FAIL - the change touches what this fork owns "
              "(integrations/intake/FORK-OWNED.md):")
        for v in violations:
            print("  " + v)
        return 1
    print("check_fork_owned: ok - nothing fork-owned is touched")
    return 0


if __name__ == "__main__":
    sys.exit(main())
