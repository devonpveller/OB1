# rw-inlet-stamp lab only: the ChatGPT import's runtime (python + requests), tagged :wt-rw-inlet-stamp, removed after.
FROM python:3.12-slim
RUN pip install --no-cache-dir "requests>=2.28,<3"
