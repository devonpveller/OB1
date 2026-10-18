"""The service's metrics (DESIGN-intake.md section 7), rendered in the Prometheus text format
at GET /metrics (auth required) and readable by the tests.

Counters and histograms kept in-process (they reset when the service restarts):
  intake_requests_total{path,code}
  intake_items_total{connector,label}          label: clean|suspicious|injected|pending|rejected
  intake_repeats_total{connector}
  intake_errors_total{kind}                    transient|permanent (a screen that ended in error)
  intake_worker_kills_total{phase}             transfer|stages|classifier (the D38 wall clocks)
  intake_worker_deaths_total
  intake_screen_seconds                        histogram, the whole worker job
  intake_stage_seconds_total{stage} / intake_stage_runs_total{stage}   from the result trace
  intake_classifier_max_score                  histogram of the max chunk score
  intake_clean_zero_chunks_total               cleans the classifier scored over ZERO chunks
                                               (I3 review R-4: nothing to score is not evidence)
  intake_stripped_total{class}                 stage 3/4 counts (hidden_elements, tag, bidi, ...)
  intake_second_opinion_total{outcome}         the judge's outcomes (second_opinion.OUTCOMES)
  intake_decided_total{row}                    the D2 row that labelled an item
  intake_purge_deleted_total{rule}
Gauges read at scrape time (from the DB through stats.collect and from the pool):
  intake_pending_items, intake_pending_oldest_age_seconds, intake_second_opinion_depth,
  intake_second_opinion_oldest_age_seconds, intake_workers_ready, intake_workers_total

The section 7 alerts, as expressions over these:
  error rate        rate(intake_errors_total[1h]) / rate(intake_items_total[1h]) > 0.05
  pending > 24 h    intake_pending_oldest_age_seconds > 86400
  suspicious spike  increase(intake_items_total{label="suspicious"}[1h]) > 3 x its 7-day hourly mean
"""
from __future__ import annotations

import threading

SCREEN_BUCKETS = (0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0, 180.0)
SCORE_BUCKETS = (0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1.0)


def _esc(v: str) -> str:
    return str(v).replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _labels(labels: dict) -> str:
    if not labels:
        return ""
    return "{" + ",".join(f'{k}="{_esc(v)}"' for k, v in sorted(labels.items())) + "}"


class Metrics:
    def __init__(self):
        self._lock = threading.Lock()
        self._counters: dict[tuple, float] = {}
        self._hist: dict[str, tuple[tuple, list, list]] = {
            "intake_screen_seconds": (SCREEN_BUCKETS, [0] * (len(SCREEN_BUCKETS) + 1), [0.0]),
            "intake_classifier_max_score": (SCORE_BUCKETS, [0] * (len(SCORE_BUCKETS) + 1), [0.0]),
        }

    def inc(self, name: str, n: float = 1, **labels) -> None:
        key = (name, tuple(sorted(labels.items())))
        with self._lock:
            self._counters[key] = self._counters.get(key, 0) + n

    def observe(self, name: str, value: float) -> None:
        buckets, counts, total = self._hist[name]
        with self._lock:
            for i, b in enumerate(buckets):
                if value <= b:
                    counts[i] += 1
                    break
            else:
                counts[-1] += 1
            total[0] += value

    def value(self, name: str, **labels) -> float:
        with self._lock:
            if labels:
                return self._counters.get((name, tuple(sorted(labels.items()))), 0)
            return sum(v for (n, _), v in self._counters.items() if n == name)

    def render(self, gauges: dict[str, float | None]) -> str:
        out: list[str] = []
        with self._lock:
            names = sorted({n for n, _ in self._counters})
            for name in names:
                out.append(f"# TYPE {name} counter")
                for (n, labels), v in sorted(self._counters.items()):
                    if n == name:
                        out.append(f"{name}{_labels(dict(labels))} {v:g}")
            for name, (buckets, counts, total) in self._hist.items():
                out.append(f"# TYPE {name} histogram")
                acc = 0
                for b, c in zip(buckets, counts):
                    acc += c
                    out.append(f'{name}_bucket{{le="{b:g}"}} {acc}')
                acc += counts[-1]
                out.append(f'{name}_bucket{{le="+Inf"}} {acc}')
                out.append(f"{name}_sum {total[0]:g}")
                out.append(f"{name}_count {acc}")
        for name, v in sorted(gauges.items()):
            out.append(f"# TYPE {name} gauge")
            out.append(f"{name} {'NaN' if v is None else format(v, 'g')}")
        return "\n".join(out) + "\n"
