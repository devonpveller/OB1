# The contract test's Dredd image (rw-p0-contract). A test tool, never shipped; tagged
# rw-dredd:wt-<id> by run-contract-tests.ps1. Dredd 14.1.0 is MIT (THIRD-PARTY-NOTICES.md).
FROM node:20-alpine
RUN npm install -g dredd@14.1.0 && dredd --version
WORKDIR /spec
ENTRYPOINT ["dredd"]
