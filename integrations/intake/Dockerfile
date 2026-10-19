# openbrain-intake (security-hardening-2026-10, build item I5): the intake service and its
# DB relay, one image (../../docker/docker-compose.yml, profile `intake`). Fork-owned.
#
# PINNED: the base image by digest; every Python package by version AND sha256
# (requirements-container.txt, installed with --require-hashes --no-deps --only-binary, so
# pip can install nothing that is not listed with its hash; torch is the CPU build from the
# PyTorch index, I3 F-4). The classifier files are NOT in the image: compose mounts them
# read-only at /models and the service checks their sha256 pins at start.
# RUNTIME: non-root (uid 10030), and the service runs on a read-only root FS (compose), so
# the bytecode is compiled here and nothing is written at run time except /tmp (tmpfs).
FROM python:3.13-slim@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b

ARG OB1_SHA=
LABEL org.opencontainers.image.revision="$OB1_SHA" \
      org.opencontainers.image.title="openbrain-intake" \
      org.opencontainers.image.description="intake: the screened way in for external content (I5)"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    INTAKE_CLASSIFIER_DIR=/models \
    HOME=/tmp

WORKDIR /app
COPY requirements-container.txt ./
RUN pip install --require-hashes --no-deps --only-binary=:all: \
        --index-url https://pypi.org/simple --extra-index-url https://download.pytorch.org/whl/cpu \
        -r requirements-container.txt \
 && python -c "import torch, transformers, tokenizers, safetensors, numpy, re2, psycopg; \
from transformers import DebertaV2Config, DebertaV2ForSequenceClassification; \
print('runtime ok: torch', torch.__version__, 'transformers', transformers.__version__, 'psycopg', psycopg.__version__)"

COPY intake ./intake
COPY transport ./transport
COPY intake_service ./intake_service
RUN python -m compileall -q intake transport intake_service \
 && python -c "import intake_service.__main__, intake_service.core, intake_service.web, intake_service.store, intake_service.relay; \
import intake.pipeline, intake.second_opinion, transport.http_gateway; print('import ok')" \
 && useradd --system --uid 10030 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin intake

USER 10030:10030
EXPOSE 8000
ENTRYPOINT ["python", "-m", "intake_service"]
CMD ["serve"]
