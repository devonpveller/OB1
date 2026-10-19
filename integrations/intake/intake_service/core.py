"""The service core (I5): one envelope in, one D2-labelled result out, the I1 rows written.

FLOW OF POST /v1/intake (DESIGN-intake.md sections 2-5 and 7):
  1. the worker pool screens the body (pool.py: JSON parse, stage 1 + key, the connector binding
     check, screen() under the D38 wall clocks). A killed or dead worker -> `pending` (transient).
  2. D2 labels the result (service_decision: the library's second_opinion.decision with the
     policy READ AT START-UP - I4 R3-T2; never d2's default).
  3. ONE TRANSACTION writes it (store.py), under a per-item advisory lock:
       the item already stored and NOT errored  -> a REPEAT: the stored record is the answer,
                                                   nothing is written (DESIGN 3.2)
       the item stored but ERRORED              -> not an idempotency record (I2 review F-r1):
                                                   the row is overwritten by this screen
       a new hash for a known (source, id)      -> a new REVISION (n+1, supersedes the latest
                                                   hash), never an in-place rewrite (P1)
     label      bronze (intake.raw_items)   silver (intake.items)          intake.discards
     clean      kept (purged at 30 d)       done / clean
     pending    kept (re-screen, judge)     pending (scores: wait state)
     suspicious kept (purged at 30 d)       done / suspicious
     injected   deleted / never written     done / injected                one record (365 d)
     rejected   never written               rejected (when a key exists)
  4. the response: status, verdict, D2 row, reasons, stripped counts, labels; TEXT only for
     clean and suspicious (DESIGN 2: `injected` returns no text; `pending` is unreadable).

A repeat re-screens the body anyway (the worker computes the key; the text is never stored in
silver). THE STORED DECISION IS SERVED, consistently (intake-i5 attempt 1 F-T10): the label is the
stored one, and the text of this screen is returned only when the stored label is clean or
suspicious AND this screen produced, without an error, the SAME stage 1-6 evidence the stored
decision was made on (scores.service.evidence: rule, classifier, error). When the evidence
differs - a rules or classifier change since, a screen that errored - no text is returned,
`text_withheld` says why and `rescreen` is true: the stored label stands until the item is
re-screened (I9), and no text is ever served under a decision that this text did not get.

THE `scores` JSON of an item is stats.item_scores(result, wait_state) - exactly the keys stats.py
reads (I4 F-8) - plus one namespaced object, scores.service:
  revision, supersedes      the item's revision (stage 2)
  d2_row                    the D2 row that labelled it
  evidence                  {rule, classifier, error, judge_complete}: the stage 1-6 evidence
                            the loops decide with (the result itself is not stored)
  judge_input               {chunks, src, complete}: what the judge reads, kept ONLY while the
                            item waits for the second opinion and dropped at the decision (no
                            page text stays in silver)
  rescreen                  {attempts, first_at, next_at}: an errored item's re-screen state
  opinion                   the judge's last outcome, once decided
  lease_until               a loop's claim on the row (pool.claim_due)

THE LOOPS (Scheduler, in-process, each on its own period):
  second opinion  pending items whose judge ask is due, at most so_batch per sweep and
                  so_concurrency requests at once; second_opinion.advance() -> D2 -> the row
                  (injection -> bronze deleted + discard record; expiry -> suspicious)
  re-screen       errored pending items with bronze, re-screened through the pool with backoff;
                  after rescreen_max_attempts or the 24 h cap (D27) -> D2 `expired` -> suspicious
  purge           purge.run_all (I4; bounded batches, as the intake role)
"""
from __future__ import annotations

import base64
import datetime as dt
import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from intake import d2, purge, stats
from intake.result import IntakeResult
from intake.second_opinion import (JudgeInput, Step, WaitState, advance, judge_input,
                                   max_wait_seconds)

from . import pool as poolmod
from .store import ItemRow, StoreUnavailable

log = logging.getLogger("intake_service.core")

LABELS = ("clean", "suspicious", "injected", "pending", "rejected")
_STATUS = {"clean": "done", "suspicious": "done", "injected": "done", "pending": "pending",
           "rejected": "rejected"}
_TEXT_LABELS = ("clean", "suspicious")


# -- D2 for the service -----------------------------------------------------------------------
def base_evidence(result: IntakeResult) -> dict:
    """The stage 1-6 evidence D2 reads (d2.evidence_from), as plain values to store."""
    ev = d2.evidence_from(result)
    return {"rule": ev.rule, "classifier": ev.classifier, "error": ev.error,
            "judge_complete": bool(result.judge_complete)}


def _ev(ev: dict, key: str, allowed: tuple, fallback: str) -> str:
    v = (ev or {}).get(key)
    return v if v in allowed else fallback


def service_decision(ev: dict, step: Step | None, complete: bool, policy: d2.Policy) -> d2.Decision:
    """second_opinion.decision() over STORED evidence (the loops have no IntakeResult). Same
    branches, same table; a value the store does not hold is `missing` (never `none`/`below`),
    an unknown error is `transient`."""
    rule = _ev(ev, "rule", d2.RULE_VALUES, "missing")
    clf = _ev(ev, "classifier", d2.CLASSIFIER_VALUES, "missing")
    err = _ev(ev, "error", d2.ERROR_VALUES, "transient")
    stored_complete = bool((ev or {}).get("judge_complete", False))
    if step is None or step.kind in ("wait", "retry"):
        return d2.decide(d2.Evidence(rule, clf, "awaiting" if step else "not_asked", stored_complete, err, False),
                         policy)
    if step.kind == "expired":
        return d2.decide(d2.Evidence(rule, clf, "awaiting", stored_complete, err, True), policy)
    return d2.decide(d2.Evidence(rule, clf, step.opinion.verdict, bool(complete), err, False), policy)


def _reasons_stored(result: IntakeResult) -> list[str]:
    return [f"{r.strength}:{r.rule}" for r in result.reasons]


def _reasons_from_stored(stored: list) -> list[dict]:
    out = []
    for s in stored or []:
        strength, _, rule = str(s).partition(":")
        out.append({"rule": rule, "strength": strength, "detail": ""})
    return out


def _errored(row: ItemRow) -> bool:
    return row.status == "pending" and row.scores.get("error") is not None


def _epoch(t: dt.datetime | None, default: float) -> float:
    return t.timestamp() if isinstance(t, dt.datetime) else default


class Intake:
    def __init__(self, settings, pool, store, metrics, *, judge, clock=time.time):
        self.settings = settings
        self.pool = pool
        self.store = store
        self.metrics = metrics
        self.judge = judge
        self.clock = clock
        self.policy = settings.policy
        self.max_wait_s = max_wait_seconds(settings.retention)

    # -- POST /v1/intake ----------------------------------------------------------------------
    def handle(self, connector: str, body: bytes) -> tuple[int, dict]:
        def gate(info):
            if info is None:
                return None  # an invalid envelope: the screen returns its `rejected` result
            got = info["envelope"]["connector"]
            return None if got == connector else f"this key is not valid for connector {got!r}"

        try:
            out = self.pool.run(body, gate)
        except poolmod.Busy:
            return 503, {"error": "busy: no screening worker is free; retry later"}
        except poolmod.PoolError:
            return 503, {"error": "not ready: no screening worker is loaded; retry later"}
        self.metrics.observe("intake_screen_seconds", out.elapsed_s)
        if out.kind == "bad":
            return 400, {"error": out.detail}
        if out.kind == "skipped":
            return 403, {"error": out.detail}
        if out.kind in ("killed", "died"):
            if out.kind == "killed":
                self.metrics.inc("intake_worker_kills_total", phase=out.phase)
            else:
                self.metrics.inc("intake_worker_deaths_total")
            result = poolmod.killed_result(out)
        else:
            result = out.result
        self._observe(result)
        if result.key is None:
            if result.verdict == "rejected":
                self.metrics.inc("intake_items_total", connector=connector, label="rejected")
                return 422, self._response(None, result, "rejected", None, connector, None, None)
            # no key (the worker never announced one): nothing can be stored; the connector retries
            return 503, {"status": "pending", "error": {"kind": "transient", "detail": result.error}}
        env = (out.started or {}).get("envelope")
        try:
            return self._persist(connector, result, env)
        except StoreUnavailable as e:
            log.warning("store unavailable (%s): item not stored", e)
            return 503, {"error": "store unavailable; retry later"}

    def _decide(self, result: IntakeResult) -> d2.Decision | None:
        if result.verdict == "rejected":
            return None
        return service_decision(base_evidence(result), None, result.judge_complete, self.policy)

    def _persist(self, connector: str, result: IntakeResult, env: dict | None) -> tuple[int, dict]:
        key = result.key
        dec = self._decide(result)
        label = "rejected" if dec is None else dec.label
        now = self.clock()
        with self.store.transaction() as tx:
            tx.lock_item(key.source, key.external_id)
            existing = tx.get_item(key.source, key.external_id, key.sha256)
            if existing is not None and not _errored(existing):
                self.metrics.inc("intake_repeats_total", connector=connector)
                return 200, self._repeat_response(existing, result)
            if existing is not None:
                svc_old = existing.scores.get("service") or {}
                revision, supersedes = svc_old.get("revision"), svc_old.get("supersedes")
            else:
                latest = tx.latest(key.source, key.external_id, key.sha256)
                revision = 1 if latest is None else latest[0] + 1
                supersedes = None if latest is None else latest[1]
            raw_id = None
            if label in ("clean", "suspicious", "pending") and env is not None:
                raw_id = tx.upsert_raw(self._bronze(env, key))
            elif label in ("injected", "rejected"):
                tx.delete_raw(key.source, key.external_id, key.sha256)
            wait = None
            if dec is not None and dec.second_opinion:
                wait = WaitState(first_pending_at=now, attempts=0, next_attempt_at=now)
            scores = stats.item_scores(result, wait)
            svc = {"revision": revision, "supersedes": supersedes,
                   "d2_row": None if dec is None else dec.row,
                   "evidence": None if dec is None else base_evidence(result)}
            if wait is not None:
                ji = judge_input(result, connector=connector)
                svc["judge_input"] = {"chunks": list(ji.chunks), "src": ji.src, "complete": ji.complete}
            if result.error is not None:
                old = ((existing.scores.get("service") or {}).get("rescreen") or {}) if existing else {}
                svc["rescreen"] = {"attempts": int(old.get("attempts", 0)) + 1,
                                   "first_at": float(old.get("first_at", now)),
                                   "next_at": now + self.settings.rescreen_backoff_s}
            scores["service"] = svc
            if label == "injected":
                tx.insert_discard({"source": key.source, "connector": connector, "external_id": key.external_id,
                                   "raw_sha256": key.sha256,
                                   "reason": ",".join(_reasons_stored(result)) or dec.row,
                                   "scores": {k: scores[k] for k in ("classifier", "classifier_version")}
                                   | {"d2_row": dec.row}})
            row = {"raw_item_id": raw_id, "source": key.source, "connector": connector,
                   "external_id": key.external_id, "raw_sha256": key.sha256, "status": _STATUS[label],
                   "verdict": label if label in ("clean", "suspicious", "injected") else None,
                   "reasons": _reasons_stored(result), "counts": dict(result.counts), "scores": scores,
                   "classifier_version": result.classifier_version}
            if existing is not None:
                tx.update_item(existing.id, {k: v for k, v in row.items()
                                             if k not in ("source", "external_id", "raw_sha256")})
                item_id = existing.id
            else:
                item_id = tx.insert_item(row)
        self.metrics.inc("intake_items_total", connector=connector, label=label)
        if dec is not None:
            self.metrics.inc("intake_decided_total", row=dec.row)
        log.info("item %s connector=%s label=%s row=%s revision=%s", item_id, connector, label,
                 None if dec is None else dec.row, revision)
        return 200, self._response(item_id, result, label, dec, connector, revision, supersedes)

    @staticmethod
    def _bronze(env: dict, key) -> dict:
        return {"source": env["source"], "connector": env["connector"], "external_id": env["external_id"],
                "raw_sha256": key.sha256, "fetched_at": env["fetched_at"], "content_type": env["content_type"],
                "raw": env["raw"],
                "envelope": {"fetched_at": env["fetched_at"], "metadata": env.get("metadata") or {},
                             "links": env.get("links") or []}}

    # -- responses ----------------------------------------------------------------------------
    def _labels(self, label, connector, source, external_id, item_id, version) -> dict:
        return {"verdict": label, "connector": connector, "source": source, "external_id": external_id,
                "intake_id": item_id, "classifier": version, "flags": []}

    def _response(self, item_id, result: IntakeResult, label: str, dec, connector, revision, supersedes) -> dict:
        readable = label in _TEXT_LABELS and result.text is not None and result.error is None
        key = result.key
        return {
            "intake_id": item_id,
            "status": _STATUS[label],
            "verdict": label if label in ("clean", "suspicious", "injected") else None,
            "label": label,
            "d2_row": None if dec is None else dec.row,
            "repeat": False,
            "rescreen": False,
            "revision": revision,
            "supersedes": supersedes,
            "key": None if key is None else key.to_dict(),
            "reasons": [r.to_dict() for r in result.reasons],
            "stripped": dict(result.counts),
            "text": result.text if readable else None,
            "text_withheld": None,
            "title": result.title if readable else None,
            "links": [dict(x) for x in result.links] if readable else [],
            "attachments": [dict(x) for x in result.attachments] if label != "injected" else [],
            "labels": self._labels(label, connector, key.source if key else None,
                                   key.external_id if key else None, item_id, result.classifier_version),
            "error": None if result.error is None else {"kind": result.error_kind, "detail": result.error},
        }

    def _repeat_response(self, row: ItemRow, fresh: IntakeResult) -> dict:
        label = row.verdict if row.status == "done" else row.status
        svc = row.scores.get("service") or {}
        stored_ev = {k: (svc.get("evidence") or {}).get(k) for k in ("rule", "classifier", "error")}
        try:
            fresh_ev = {k: v for k, v in base_evidence(fresh).items() if k in stored_ev}                 if fresh.verdict != "rejected" else None
        except ValueError:
            fresh_ev = None
        same = fresh_ev is not None and fresh_ev == stored_ev and fresh.error is None
        withheld = None
        if label in _TEXT_LABELS and not same:
            withheld = ("this screen's evidence differs from the stored decision's "
                        f"(stored {stored_ev}, now {fresh_ev}); the stored label stands until a re-screen")
        readable = label in _TEXT_LABELS and same and fresh.text is not None
        rescreen = row.status != "rejected" and label != "injected" and (
            not same or fresh.classifier_version is None or fresh.classifier_version != row.classifier_version)
        return {
            "intake_id": row.id,
            "status": row.status,
            "verdict": row.verdict,
            "label": label,
            "d2_row": svc.get("d2_row"),
            "repeat": True,
            "rescreen": bool(rescreen),
            "revision": svc.get("revision"),
            "supersedes": svc.get("supersedes"),
            "key": {"source": row.source, "external_id": row.external_id, "sha256": row.raw_sha256},
            "reasons": _reasons_from_stored(row.reasons),
            "stripped": dict(row.counts),
            "text": fresh.text if readable else None,
            "text_withheld": withheld,
            "title": fresh.title if readable else None,
            "links": [dict(x) for x in fresh.links] if readable else [],
            "attachments": [],
            "labels": self._labels(label, row.connector, row.source, row.external_id, row.id,
                                   row.classifier_version),
            "error": None,
        }

    def _observe(self, result: IntakeResult) -> None:
        m = self.metrics
        for t in result.trace:
            m.inc("intake_stage_seconds_total", t.ms / 1000.0, stage=t.stage)
            m.inc("intake_stage_runs_total", stage=t.stage)
        for k, v in result.counts.items():
            if v:
                m.inc("intake_stripped_total", v, **{"class": k})
        if result.classifier is not None:
            score = result.classifier.get("max_score")
            if isinstance(score, (int, float)) and not isinstance(score, bool):
                m.observe("intake_classifier_max_score", float(score))
            if result.verdict == "clean" and result.classifier.get("chunks") == 0:
                m.inc("intake_clean_zero_chunks_total")
        if result.error is not None:
            m.inc("intake_errors_total", kind=result.error_kind or "transient")

    # -- the second-opinion loop --------------------------------------------------------------
    def sweep_second_opinion(self) -> int:
        now = self.clock()
        lease = now + self.settings.second_opinion.timeout_seconds + 60.0
        with self.store.transaction() as tx:
            rows = tx.claim_due("second_opinion", now, lease, self.settings.so_batch)
        if not rows:
            return 0
        with ThreadPoolExecutor(max_workers=self.settings.so_concurrency,
                                thread_name_prefix="intake-so") as ex:
            for f in [ex.submit(self._so_step, row) for row in rows]:
                try:
                    f.result()
                except StoreUnavailable as e:
                    log.warning("second opinion: store unavailable (%s)", e)
                except Exception as e:  # noqa: BLE001 - one item never stops the sweep
                    log.error("second opinion: step failed (%s)", type(e).__name__)
        return len(rows)

    def _so_step(self, row: ItemRow) -> None:
        sc = row.scores
        svc = sc.get("service") or {}
        jd = svc.get("judge_input") or {}
        ji = JudgeInput(chunks=tuple(str(c) for c in jd.get("chunks", ()) if str(c).strip()),
                        src=str(jd.get("src", "unknown")), complete=bool(jd.get("complete")))
        try:
            state = WaitState.from_dict(sc.get("second_opinion") or {})
        except ValueError:
            state = WaitState(first_pending_at=_epoch(row.created_at, self.clock()))
        step = advance(self.judge, ji, state, now=self.clock(), max_wait_s=self.max_wait_s)
        if step.opinion is not None:
            self.metrics.inc("intake_second_opinion_total", outcome=step.opinion.outcome)
        dec = service_decision(svc.get("evidence") or {}, step, ji.complete, self.policy)
        self._apply_decision(row, dec, step, extra={"opinion": None if step.opinion is None
                                                    else step.opinion.to_dict()})

    def _apply_decision(self, row: ItemRow, dec: d2.Decision, step: Step | None, extra: dict) -> None:
        item_id = row.id
        with self.store.transaction() as tx:
            # the same lock order as _persist: the per-item advisory lock, then the row
            tx.lock_item(row.source, row.external_id)
            cur = tx.get_item_by_id(item_id)
            if cur is None or cur.status != "pending":
                return
            scores = dict(cur.scores)
            if step is not None and scores.get("second_opinion") is not None:
                scores["second_opinion"] = step.state.to_dict()
            svc = dict(scores.get("service") or {})
            svc.pop("lease_until", None)
            if dec.label == "pending":
                scores["service"] = svc
                tx.update_item(cur.id, {"scores": scores})
                return
            svc.pop("judge_input", None)
            svc["d2_row"] = dec.row
            svc.update(extra)
            scores["service"] = svc
            if dec.label == "injected":
                tx.delete_raw(cur.source, cur.external_id, cur.raw_sha256)
                tx.insert_discard({"source": cur.source, "connector": cur.connector, "external_id": cur.external_id,
                                   "raw_sha256": cur.raw_sha256, "reason": dec.row,
                                   "scores": {"classifier": scores.get("classifier"),
                                              "classifier_version": scores.get("classifier_version"),
                                              "d2_row": dec.row}})
            tx.update_item(cur.id, {"status": "done", "verdict": dec.label, "scores": scores,
                                    "raw_item_id": None if dec.label == "injected" else cur.raw_item_id})
        self.metrics.inc("intake_items_total", connector=cur.connector, label=dec.label)
        self.metrics.inc("intake_decided_total", row=dec.row)
        log.info("item %s decided label=%s row=%s", item_id, dec.label, dec.row)

    # -- the re-screen loop -------------------------------------------------------------------
    def sweep_rescreen(self) -> int:
        now = self.clock()
        lease = now + self.settings.wall_transfer_s + self.settings.wall_stages_s + \
            self.settings.wall_classifier_s + 60.0
        with self.store.transaction() as tx:
            rows = tx.claim_due("rescreen", now, lease, self.settings.so_batch)
        for row in rows:
            try:
                self._rescreen(row, now)
            except StoreUnavailable as e:
                log.warning("re-screen: store unavailable (%s)", e)
            except Exception as e:  # noqa: BLE001
                log.error("re-screen: step failed (%s)", type(e).__name__)
        return len(rows)

    def _rescreen(self, row: ItemRow, now: float) -> None:
        svc = row.scores.get("service") or {}
        rs = svc.get("rescreen") or {}
        attempts = int(rs.get("attempts", 1))
        first_at = float(rs.get("first_at", _epoch(row.created_at, now)))
        if attempts >= self.settings.rescreen_max_attempts or now - first_at >= self.max_wait_s:
            dec = service_decision(svc.get("evidence") or {}, Step("expired", WaitState(first_at)), False,
                                   self.policy)
            self._apply_decision(row, dec, None, extra={})
            return
        with self.store.transaction() as tx:
            raw = tx.raw_by_id(row.raw_item_id)
        if raw is None:
            return
        env = raw["envelope"] or {}
        body = json.dumps({"source": raw["source"], "connector": raw["connector"],
                           "external_id": raw["external_id"],
                           "fetched_at": env.get("fetched_at") or "1970-01-01T00:00:00+00:00",
                           "content_type": raw["content_type"], "raw_encoding": "base64",
                           "raw": base64.b64encode(raw["raw"]).decode("ascii"),
                           "metadata": env.get("metadata") or {}, "links": env.get("links") or []}).encode()
        code, out = self.handle(row.connector, body)
        log.info("re-screen of item %s: http %s label=%s", row.id, code, out.get("label"))

    # -- purge and stats ----------------------------------------------------------------------
    def purge(self):
        reports = purge.run_all(self.store, retention=self.settings.retention)
        for r in reports:
            if r.deleted:
                self.metrics.inc("intake_purge_deleted_total", r.deleted, rule=r.rule)
        log.info("purge: %s", ", ".join(f"{r.rule}={r.deleted}{'+' if r.more else ''}" for r in reports))
        return reports

    def stats(self, since: dt.datetime | None) -> dict:
        return stats.collect(self.store, dt.datetime.now(dt.timezone.utc), since).to_dict()

    def gauges(self) -> dict:
        g: dict[str, float | None] = {}
        st = self.pool.status()
        g["intake_workers_ready"] = st.get("ready", 0)
        g["intake_workers_total"] = st.get("total", 0)
        try:
            q = stats.collect(self.store, dt.datetime.now(dt.timezone.utc)).queue
            g.update({"intake_pending_items": q.pending, "intake_pending_oldest_age_seconds": q.oldest_pending_age_s,
                      "intake_second_opinion_depth": q.second_opinion_depth,
                      "intake_second_opinion_oldest_age_seconds": q.second_opinion_oldest_age_s})
        except Exception as e:  # noqa: BLE001 - the counters still render
            log.warning("metrics: queue gauges unavailable (%s)", type(e).__name__)
        return g


class Scheduler:
    """The in-process loops, each on its own period; one failing run never stops a loop."""

    def __init__(self, svc: Intake):
        s = svc.settings
        self._loops = (("second-opinion", s.so_interval_s, svc.sweep_second_opinion),
                       ("re-screen", s.rescreen_interval_s, svc.sweep_rescreen),
                       ("purge", s.purge_interval_s, svc.purge))
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        for name, interval, fn in self._loops:
            t = threading.Thread(target=self._loop, args=(name, interval, fn), name=f"intake-{name}",
                                 daemon=True)
            t.start()
            self._threads.append(t)

    def _loop(self, name, interval, fn) -> None:
        while not self._stop.wait(interval):
            try:
                fn()
            except StoreUnavailable as e:
                log.warning("%s loop: store unavailable (%s)", name, e)
            except Exception as e:  # noqa: BLE001
                log.error("%s loop: %s", name, type(e).__name__)

    def stop(self) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(5)
