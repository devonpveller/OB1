"""Every reachable OB1 flow of open_notebook, run through the fork's real ob1_repository module.

Runs INSIDE the lab image (FROM open_notebook:iks + the patched ob1_repository.py), against the
lab database only. The connection comes from the same env the service uses (OB1_DB_HOST,
OB1_DB_USER, OB1_DB_PASSWORD_FILE ...). embed() is replaced by a fixed 1024-dim vector (the lab
network has no embedding endpoint; the vector searches would otherwise return early and never
reach their SQL). Prints one JSON object: {"identity": ..., "flows": [{name, ok, sqlstate, error}]}.
Never prints a password. Fixture ids: fixtures.sql.
"""
from __future__ import annotations

import asyncio
import json
import sys
import traceback
import uuid

from open_notebook.database import ob1_repository as ob1

T1 = "11111111-1111-4111-8111-000000000001"
T2 = "11111111-1111-4111-8111-000000000002"
S1 = "22222222-2222-4222-8222-000000000001"
S2 = "22222222-2222-4222-8222-000000000002"
S3 = "22222222-2222-4222-8222-000000000003"
TOMBSTONED_URL = "https://lab.example/erased-page"
VEC = [0.01] * 1024
RUN = uuid.uuid4().hex[:12]


async def _fixed_embed(text):
    return list(VEC) if text else None


ob1.embed = _fixed_embed  # the module's own callers look it up at call time


def need(cond, what):
    if not cond:
        raise AssertionError(what)


async def f_test_connection():
    r = await ob1.test_connection()
    need(r.get("ok") is True and r.get("has_sources_table") and (r.get("source_count") or 0) >= 3,
         f"test_connection: {r.get('error') or r}")


async def f_create_thread_get_thread():
    t = await ob1.create_thread(f"lab created {RUN}", "made by flows.py")
    need(t.get("id") and t["name"].endswith(RUN), "create_thread returned no row")
    g = await ob1.get_thread(t["id"])
    need(g is not None and g["id"] == t["id"], "get_thread does not see the new thread")
    return t["id"]


async def f_get_thread():
    g = await ob1.get_thread(T1)
    need(g is not None and g["name"] == "lab thread one", "get_thread(T1)")


async def f_get_thread_sources():
    rows = await ob1.get_thread_sources(T1)
    need(any(r["id"] == S1 for r in rows), "get_thread_sources(T1) lacks S1")


async def f_count_thread_sources():
    need(await ob1.count_thread_sources(T1) >= 2, "count_thread_sources(T1) < 2")


async def f_list_sources():
    for sort_by, order in (("updated", "desc"), ("created", "asc")):
        rows = await ob1.list_sources(limit=50, sort_by=sort_by, sort_order=order)
        need(any(r["id"] == S1 for r in rows), f"list_sources {sort_by} {order}")


async def f_get_source():
    s = await ob1.get_source(S1)
    need(s is not None and s["title"] == "lab source one", "get_source(S1)")


async def f_get_thread_notes():
    rows = await ob1.get_thread_notes(T1)
    need(any(r["id"] == S3 for r in rows), "get_thread_notes(T1) lacks the synthesis note S3")


async def f_link_source_to_thread():
    tid = await f_create_thread_get_thread()
    await ob1.link_source_to_thread(tid, S2, link_type="deliberate", status="confirmed")
    await ob1.link_source_to_thread(tid, S2, link_type="deliberate", status="confirmed")  # ON CONFLICT
    rows = await ob1.get_thread_sources(tid)
    need([r["id"] for r in rows] == [S2], "link_source_to_thread: the link is not visible")


async def f_suggestion_cycle():
    # T2/S1 is a pending suggestion (fixtures.sql); every step goes through set_thread_source_status
    await ob1.set_thread_source_status(T2, S1, "pending")
    await ob1.accept_suggestion(T2, S1)
    need(any(r["id"] == S1 for r in await ob1.get_thread_sources(T2)), "accept_suggestion")
    await ob1.hide_suggestion(T2, S1)
    need(any(r["source_id"] == S1 for r in await ob1.get_hidden_suggestions(T2)), "hide_suggestion")
    await ob1.restore_suggestion(T2, S1)
    need(any(r["source_id"] == S1 for r in await ob1.get_suggestions(T2)), "restore_suggestion")


async def f_suggestion_reads():
    need(any(r["thread_id"] == T2 and r["source_id"] == S1 for r in await ob1.get_suggestions(None)),
         "get_suggestions(None)")
    need(any(r["source_id"] == S2 for r in await ob1.get_hidden_suggestions(None)), "get_hidden_suggestions")
    need(any(r["thread_id"] == T2 for r in await ob1.get_source_suggestions(S1)), "get_source_suggestions")
    need(any(r["thread_id"] == T2 for r in await ob1.get_source_hidden_suggestions(S2)),
         "get_source_hidden_suggestions")
    counts = await ob1.get_source_suggestion_counts()
    need(counts.get(S1, 0) >= 1 and S2 in counts, f"get_source_suggestion_counts {counts}")


async def f_explain_suggestion():
    rows = await ob1.explain_suggestion(T1, S2)
    need(any(r["title"] == "lab source one" for r in rows), "explain_suggestion(T1, S2)")


async def f_chunk_reads():
    need(await ob1.search_source_chunks(S1, "q"), "search_source_chunks")
    need(await ob1.source_chunk_spread(S1), "source_chunk_spread")
    need(await ob1.search_all_chunks("q"), "search_all_chunks")
    need(await ob1.search_thread_chunks(T1, "q"), "search_thread_chunks")


async def f_capture_source_into_thread():
    url = f"https://lab.example/capture-{RUN}"
    a = await ob1.capture_source_into_thread(thread_id=T1, content=f"captured {RUN}", url=url,
                                             title="cap", link_type="automatic",
                                             metadata={"on_source_id": "lab"})
    need(a["was_duplicate"] is False, "capture: first write is not new")
    b = await ob1.capture_source_into_thread(thread_id=T1, content=f"captured {RUN}", url=url, title="cap")
    need(b["was_duplicate"] is True and b["source_id"] == a["source_id"], "capture: dedup")
    need(any(r["id"] == a["source_id"] for r in await ob1.get_thread_sources(T1)), "capture: not linked")
    return a["source_id"]


async def f_capture_refuses_a_tombstoned_url():
    # the url gate trigger must SEE the tombstone (SELECT + the RLS policy on source_tombstones):
    # an erased url is refused with OBT01, never silently readmitted
    try:
        await ob1.capture_source_into_thread(thread_id=T1, content=f"erased {RUN}", url=TOMBSTONED_URL)
    except Exception as exc:
        need(getattr(exc, "sqlstate", None) == "OBT01", f"refused, but not by the gate: {exc!r}")
        return
    raise AssertionError("a tombstoned url was readmitted")


async def f_sync_extracted_source():
    url = f"https://lab.example/sync-{RUN}"
    sid = await ob1.sync_extracted_source(thread_ids=[T1, T2], content=f"extracted {RUN}", url=url,
                                          title="synced", content_type="web_article",
                                          metadata={"on_source_id": "lab-sync"})
    need(sid, "sync_extracted_source returned nothing")
    sid2 = await ob1.sync_extracted_source(thread_ids=[T1], content=f"re-extracted {RUN}", url=url, title="")
    need(sid2 == sid, "sync_extracted_source: not folded onto the same row")
    s = await ob1.get_source(sid)
    need(s and s["content"] == f"re-extracted {RUN}" and s["title"] == "synced", "sync: content not refreshed")
    return sid


async def f_unlink_source_all_threads():
    sid = await f_sync_extracted_source()
    need(await ob1.unlink_source_all_threads(sid) is True, "unlink_source_all_threads")
    need(not any(r["id"] == sid for r in await ob1.get_thread_sources(T1)), "unlink: still linked")


FLOWS = [
    ("test_connection", f_test_connection),
    ("create_thread+get_thread", f_create_thread_get_thread),
    ("get_thread", f_get_thread),
    ("get_thread_sources", f_get_thread_sources),
    ("count_thread_sources", f_count_thread_sources),
    ("list_sources", f_list_sources),
    ("get_source", f_get_source),
    ("get_thread_notes", f_get_thread_notes),
    ("link_source_to_thread", f_link_source_to_thread),
    ("suggestion_cycle(set_thread_source_status, accept/hide/restore)", f_suggestion_cycle),
    ("suggestion_reads", f_suggestion_reads),
    ("explain_suggestion", f_explain_suggestion),
    ("chunk_reads(search_source_chunks, source_chunk_spread, search_all_chunks, search_thread_chunks)", f_chunk_reads),
    ("capture_source_into_thread", f_capture_source_into_thread),
    ("capture_refuses_a_tombstoned_url", f_capture_refuses_a_tombstoned_url),
    ("sync_extracted_source", f_sync_extracted_source),
    ("unlink_source_all_threads", f_unlink_source_all_threads),
]


async def identity():
    try:
        pool = await ob1.get_pool()
        row = await pool.fetchrow(
            "SELECT current_user::text AS cu, session_user::text AS su, "
            "(SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS super, "
            "(SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls")
        return dict(row)
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}", "sqlstate": getattr(exc, "sqlstate", None)}


async def main(only):
    out = {"identity": await identity(), "flows": []}
    for name, fn in FLOWS:
        if only and name.split("(")[0] not in only:
            continue
        rec = {"name": name, "ok": True, "sqlstate": None, "error": None}
        try:
            await fn()
        except Exception as exc:  # recorded, never raised: the orchestrator judges
            rec.update(ok=False, sqlstate=getattr(exc, "sqlstate", None),
                       error=f"{type(exc).__name__}: {exc}"[:400])
            if "-v" in sys.argv:
                traceback.print_exc(file=sys.stderr)
        out["flows"].append(rec)
    await ob1.close_pool()
    print("FLOWS-JSON " + json.dumps(out, default=str))


if __name__ == "__main__":
    asyncio.run(main({a for a in sys.argv[1:] if not a.startswith("-")}))
