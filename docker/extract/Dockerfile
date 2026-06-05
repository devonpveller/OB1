# openbrain-extract (P5.1) — content extraction sidecar.
# Sandboxed by posture (compose: non-root, cap_drop, restricted net). The
# tesseract binary is the only system dep beyond the Python wheels.
FROM python:3.12-slim

# tesseract-ocr for image OCR; nothing else (keep the untrusted-parsing
# surface minimal — no LibreOffice/headless converters that exec macros).
RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py ./

# Non-root runtime (defence in depth for untrusted file parsing).
RUN useradd -u 10020 -m extract
USER extract

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
