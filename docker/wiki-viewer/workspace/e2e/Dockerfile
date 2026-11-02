# The workspace's end-to-end runner (rw-p2b-workspace) - LAB ONLY, never shipped: playwright-core
# (Apache-2.0) drives the lab's headless Chromium over CDP; pg (MIT) reaches the disposable database.
# Built and tagged :wt-<id> by run-workspace-tests.ps1, removed at the end of the run.
FROM node:22-slim
WORKDIR /e2e
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
# rw-p8a1-core: the panels run (panels.e2e.mjs) is the same image with that script as its argument
COPY workspace.e2e.mjs panels.e2e.mjs ./
ENTRYPOINT ["node"]
CMD ["workspace.e2e.mjs"]
