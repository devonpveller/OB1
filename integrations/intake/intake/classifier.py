"""Stage 6: the prompt-injection classifier (DESIGN-intake.md sections 3 and 8; operator D24,
D26).

Model: protectai/deberta-v3-base-prompt-injection-v2 (Apache-2.0, ungated), on CPU, pinned by
its Hugging Face repo revision AND the sha256 of every file this module reads (MODEL_FILES).
The files are fetched ONCE at build/setup time by tools/fetch_classifier.py, which verifies
them; at screen time nothing is fetched: the loader reads the files from INTAKE_CLASSIFIER_DIR,
checks each file's size and sha256 on the very bytes it then loads (no second read between the
check and the load), and builds the model from those bytes. Only safetensors weights are read
(no pickle). Hugging Face's offline switches are set before transformers is imported, and the
tests run with sockets disabled.

What it does:
  * The whole text is scored, in overlapping chunks of `chunk_tokens` tokens (special tokens
    included) that overlap by `overlap_tokens`: any span of at most `overlap_tokens` tokens is
    wholly inside at least one chunk, so a short payload on a chunk boundary is still seen
    whole. Section 9: 256-token chunks with a 32-token overlap catch mid-page payloads that a
    512 window dilutes (0.98 vs 0.89) for about the same CPU.
  * Fields scored: the body (the stage-4 NFKC copy the rules read), the side text (title, link
    texts and URLs, attachment names) and decoded TAG payloads. The score is the MAX over every
    chunk of every field.
  * The result says which chunks reached the threshold: field, character offsets into that
    field's text (the stage-4 copy, which is deterministic, so I4 can rebuild it), score.

What it never does (operator D24): decide `injected` or `clean`. A score >= threshold sends the
item to the second opinion (`pending`); a score below leaves the deterministic verdict as it
was. Any failure - missing or corrupt files, a hash mismatch, torch/transformers missing, a
tokenizer or model exception, the time or chunk budget - raises, and the pipeline turns that
into `pending` (stage 8), never `clean`.

Time: the tokenizer and one forward pass are single library calls that cannot be interrupted
in-process; the budget (config max_seconds) is checked before every chunk, so the overshoot is
one chunk (~0.3-0.7 s at 256 tokens on the reference host). A text longer than max_chunks is
refused before any model work. The killable worker (I5, operator D38) is the hard bound.

Precision (config, operator CPU-upgrade note): fp32, or int8 - torch dynamic INT8 (onednn;
per-channel weights, per-tensor dynamic activations) of the encoder Linear groups in config
int8_layers. Default: the attention output projection only. The groups whose input carries
DeBERTa's activation outlier channels (qkv and intermediate read LayerNorm outputs, ffn_output
reads the GELU output) moved eval scores by up to 1.0 when quantised (intake-i3 findings). On
the i7-7820X (AVX-512, no VNNI) INT8 is not faster than fp32 at all; re-measure with the eval
fixture after the CPU upgrade. Threads: config.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

from .config import ClassifierConfig, classifier_config

MODEL_REPO = "protectai/deberta-v3-base-prompt-injection-v2"
MODEL_REVISION = "90c9989b1a342275dd0d1a95aad283c04e075671"
MODEL_LICENSE = "Apache-2.0"
# Every file the loader reads: name -> (size in bytes, sha256). Fetched by
# tools/fetch_classifier.py from https://huggingface.co/<repo>/resolve/<revision>/<name>.
MODEL_FILES: dict[str, tuple[int, str]] = {
    "config.json": (994, "05079f4735092040b780d459027afab413faa6eeb66a548571a58832304b60bb"),
    "tokenizer.json": (8656744, "f0a66ad0d735d8dca9ecac4ff50fcdef4bb6adbadd2941a926844844d2c2059b"),
    "model.safetensors": (737719272, "6521cb8d0ac08148c81464899c424e6148fcc62befa371089fa4061d8b6e0424"),
}
INJECTION_LABEL = "INJECTION"

# The encoder Linear groups that int8 can quantise (config int8_layers picks among them).
INT8_GROUPS: dict[str, Callable[[str], bool]] = {
    "attention_output": lambda n: n.endswith("attention.output.dense"),
    "qkv": lambda n: n.endswith(("attention.self.query_proj", "attention.self.key_proj",
                                 "attention.self.value_proj")),
    "intermediate": lambda n: n.endswith("intermediate.dense"),
    "ffn_output": lambda n: n.endswith(".output.dense") and ".attention." not in n,
}

# Most flagged chunks listed in a result (the highest scores); the count is always given.
MAX_FLAGGED_LISTED = 32
# Tokenizer input is cut into segments of about this many characters, at whitespace, so the
# budget and the chunk cap are checked between segments (the normaliser strips and collapses
# blanks, so a cut at whitespace tokenises exactly as the whole text: tested).
TOKENIZE_SEGMENT_CHARS = 32_768


class ClassifierUnavailable(Exception):
    """The model cannot be used: files missing, corrupt, not the pinned ones, or the runtime
    is missing. The item stays `pending`."""


class ClassifierBudget(Exception):
    """The text is too long for the chunk cap, or scoring passed the time budget."""


def _offline_env() -> None:
    # set before transformers / huggingface_hub are imported: never reach the network
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"


def read_verified(model_dir: str | os.PathLike, name: str,
                  files: dict[str, tuple[int, str]] | None = None) -> bytes:
    """The file's bytes, after checking its size and sha256 against the pin. The caller loads
    from these same bytes."""
    files = MODEL_FILES if files is None else files
    size, sha = files[name]
    path = Path(model_dir) / name
    try:
        st = path.stat()
    except OSError as e:
        raise ClassifierUnavailable(f"{name}: missing ({type(e).__name__})") from None
    if st.st_size != size:
        raise ClassifierUnavailable(f"{name}: {st.st_size} bytes, pinned {size}")
    try:
        data = path.read_bytes()
    except OSError as e:
        raise ClassifierUnavailable(f"{name}: unreadable ({type(e).__name__})") from None
    got = hashlib.sha256(data).hexdigest()
    if len(data) != size or got != sha:
        raise ClassifierUnavailable(f"{name}: sha256 {got[:16]}... is not the pinned {sha[:16]}...")
    return data


def version(cfg: ClassifierConfig) -> str:
    prec = cfg.precision if cfg.precision != "int8" else f"int8[{'+'.join(cfg.int8_layers)}]"
    return f"{MODEL_REPO}@{MODEL_REVISION[:12]}/{prec}/c{cfg.chunk_tokens}o{cfg.overlap_tokens}"


@dataclass(frozen=True)
class ChunkScore:
    field: str
    start: int  # character offsets into the field's text
    end: int
    score: float

    def to_dict(self) -> dict:
        return {"field": self.field, "start": self.start, "end": self.end,
                "score": round(self.score, 6)}


@dataclass(frozen=True)
class Scored:
    version: str
    precision: str
    threads: int
    threshold: float
    max_score: float
    chunks: int
    flagged_count: int
    flagged: tuple[ChunkScore, ...] = field(default_factory=tuple)
    ms: float = 0.0

    @property
    def over_threshold(self) -> bool:
        return self.max_score >= self.threshold

    def to_dict(self) -> dict:
        return {"version": self.version, "precision": self.precision, "threads": self.threads,
                "threshold": self.threshold, "max_score": round(self.max_score, 6),
                "chunks": self.chunks, "flagged_count": self.flagged_count,
                "flagged": [c.to_dict() for c in self.flagged], "ms": round(self.ms, 1)}


class Classifier:
    """One loaded model. Loading is lazy (first score) and happens once; a failed load is
    remembered and raised again on every call (the files do not repair themselves; the
    worker is restarted after a fix)."""

    def __init__(self, cfg: ClassifierConfig | None = None, *,
                 files: dict[str, tuple[int, str]] | None = None,
                 clock: Callable[[], float] = time.perf_counter):
        self.cfg = cfg or classifier_config()
        self.version = version(self.cfg)
        self._files = MODEL_FILES if files is None else files
        self._clock = clock
        self._lock = threading.Lock()
        self._loaded = False
        self._load_error: BaseException | None = None
        self._tokenizer = None
        self._model = None
        self._torch = None
        self._cls = self._sep = 0
        self._inj = 1
        self._n_labels = 0  # set from the pinned config.json at load (else the model's own config)
        self.load_seconds = 0.0

    # -- loading -------------------------------------------------------------------------
    def load(self) -> None:
        with self._lock:
            if self._loaded:
                return
            if self._load_error is not None:
                raise ClassifierUnavailable(f"load failed earlier: {self._load_error}")
            t0 = time.perf_counter()
            try:
                self._load()
            except ClassifierUnavailable as e:
                self._load_error = e
                raise
            except Exception as e:  # noqa: BLE001 - anything else is "unavailable" too
                self._load_error = e
                raise ClassifierUnavailable(f"{type(e).__name__}: {e}"[:300]) from None
            self.load_seconds = time.perf_counter() - t0
            self._loaded = True

    def _load(self) -> None:
        d = self.cfg.model_dir
        if not d:
            raise ClassifierUnavailable("no model directory configured (INTAKE_CLASSIFIER_DIR)")
        # 1. every file checked against the pin BEFORE anything is parsed or loaded
        raw = {name: read_verified(d, name, self._files) for name in MODEL_FILES}
        _offline_env()
        try:
            import torch
            from safetensors.torch import load as st_load
            from tokenizers import Tokenizer
            from transformers import DebertaV2Config, DebertaV2ForSequenceClassification
        except ImportError as e:
            raise ClassifierUnavailable(f"runtime missing: {e}") from None
        conf = json.loads(raw["config.json"].decode("utf-8"))
        label2id = {str(k).upper(): int(v) for k, v in conf.get("label2id", {}).items()}
        if INJECTION_LABEL not in label2id:
            raise ClassifierUnavailable("config.json has no INJECTION label")
        tok = Tokenizer.from_str(raw["tokenizer.json"].decode("utf-8"))
        tok.no_truncation()
        tok.no_padding()
        cls_id, sep_id = tok.token_to_id("[CLS]"), tok.token_to_id("[SEP]")
        if cls_id is None or sep_id is None:
            raise ClassifierUnavailable("tokenizer has no [CLS]/[SEP]")
        torch.set_num_threads(self.cfg.threads)
        state = st_load(raw.pop("model.safetensors"))
        with torch.device("meta"):
            model = DebertaV2ForSequenceClassification(DebertaV2Config.from_dict(conf))
        model.load_state_dict(state, strict=True, assign=True)
        del state
        model.eval()
        if self.cfg.precision == "int8":
            model = _to_int8(torch, model, self.cfg.int8_layers)
        self._torch, self._tokenizer, self._model = torch, tok, model
        self._cls, self._sep, self._inj = cls_id, sep_id, label2id[INJECTION_LABEL]
        self._n_labels = len(label2id)

    # -- scoring -------------------------------------------------------------------------
    def tokenize(self, text: str, check: Callable[[], None]) -> tuple[list[int], list[tuple[int, int]]]:
        """Token ids and character offsets for the whole text, tokenised in whitespace-cut
        segments with the budget checked between them."""
        ids: list[int] = []
        offs: list[tuple[int, int]] = []
        pos, n = 0, len(text)
        step = self.cfg.chunk_tokens - 2 - self.cfg.overlap_tokens
        while pos < n:
            check()
            end = min(n, pos + TOKENIZE_SEGMENT_CHARS)
            if end < n:
                cut = max(text.rfind(c, pos + TOKENIZE_SEGMENT_CHARS // 2, end) for c in " \n\t")
                if cut > pos:
                    end = cut
            enc = self._tokenizer.encode(text[pos:end], add_special_tokens=False)
            ids.extend(enc.ids)
            offs.extend((a + pos, b + pos) for a, b in enc.offsets)
            pos = end
            if len(ids) > self.cfg.max_chunks * step + self.cfg.chunk_tokens:
                raise ClassifierBudget(f"text longer than {self.cfg.max_chunks} chunks")
        return ids, offs

    def windows(self, n_tokens: int) -> list[tuple[int, int]]:
        body = self.cfg.chunk_tokens - 2
        step = body - self.cfg.overlap_tokens
        out: list[tuple[int, int]] = []
        i = 0
        while i < n_tokens:
            out.append((i, min(i + body, n_tokens)))
            if i + body >= n_tokens:
                break
            i += step
        return out

    def score_ids(self, ids: list[int]) -> float:
        torch = self._torch
        x = torch.tensor([[self._cls, *ids, self._sep]], dtype=torch.long)
        with torch.inference_mode():
            logits = self._model(input_ids=x, attention_mask=torch.ones_like(x)).logits
            # I3 review R-1: a head with another number of classes would give a softmax over
            # the wrong set (3 logits [5,-5,0] scored 4.5e-05, `clean`); refuse it (pending)
            n = self._n_labels or _config_labels(self._model)
            if tuple(logits.shape) != (1, n):
                raise ValueError(f"model returned logits of shape {tuple(logits.shape)}, the pinned "
                                 f"config has {n} labels")
            return float(torch.softmax(logits.float(), -1)[0][self._inj])

    def score(self, fields: Iterable[tuple[str, str]]) -> Scored:
        """Score every field; raise on any failure (the pipeline fails closed)."""
        self.load()
        t0 = self._clock()
        end = t0 + self.cfg.max_seconds

        def check() -> None:
            if self._clock() > end:
                raise ClassifierBudget(f"classifier: passed {self.cfg.max_seconds:.1f}s")

        work = []
        total = 0
        for name, text in fields:
            if not text or not text.strip():
                continue
            ids, offs = self.tokenize(text, check)
            wins = self.windows(len(ids))
            total += len(wins)
            if total > self.cfg.max_chunks:
                raise ClassifierBudget(f"text longer than {self.cfg.max_chunks} chunks")
            work.append((name, ids, offs, wins))
        best = 0.0
        flagged: list[ChunkScore] = []
        for name, ids, offs, wins in work:
            for a, b in wins:
                check()
                p = self.score_ids(ids[a:b])
                if not (0.0 <= p <= 1.0):  # NaN or garbage: not a score
                    raise ValueError(f"classifier returned {p!r}")
                best = max(best, p)
                if p >= self.cfg.threshold:
                    flagged.append(ChunkScore(name, offs[a][0], offs[b - 1][1], p))
        flagged.sort(key=lambda c: -c.score)
        return Scored(version=self.version, precision=self.cfg.precision, threads=self.cfg.threads,
                      threshold=self.cfg.threshold, max_score=best, chunks=total,
                      flagged_count=len(flagged), flagged=tuple(flagged[:MAX_FLAGGED_LISTED]),
                      ms=(self._clock() - t0) * 1000)


def _config_labels(model) -> int:
    """The label count of a model built from the pinned config.json (its config.num_labels);
    0 - which refuses every score - for anything else."""
    n = getattr(getattr(model, "config", None), "num_labels", 0)
    return n if isinstance(n, int) and not isinstance(n, bool) and n > 0 else 0


def _to_int8(torch, model, groups):
    """Dynamic INT8 (per-channel weights, per-tensor dynamic activations; onednn) of the encoder
    Linear layers in the given groups; everything else stays fp32."""
    import warnings

    from torch.ao.quantization import per_channel_dynamic_qconfig, quantize_dynamic
    preds = [INT8_GROUPS[g] for g in groups]
    spec = {n: per_channel_dynamic_qconfig for n, m in model.named_modules()
            if isinstance(m, torch.nn.Linear) and ".encoder.layer." in f".{n}"
            and any(p(n) for p in preds)}
    if not spec:
        raise ClassifierUnavailable(f"int8: no layer in {groups}")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # torch.ao's deprecation notice (moving to torchao)
        return quantize_dynamic(model, spec, inplace=False)


# -- the process-wide default (what screen() uses when it is not handed one) ------------------
_default: Classifier | None = None
_default_lock = threading.Lock()


def default() -> Classifier:
    """The classifier configured from the environment, created once per process."""
    global _default
    with _default_lock:
        if _default is None:
            _default = Classifier(classifier_config())
        return _default


def set_default(clf) -> None:
    """Replace the process default (tests; a service that loads at start-up)."""
    global _default
    with _default_lock:
        _default = clf
