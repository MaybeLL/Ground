ARG BASE=node:22-bookworm
FROM ${BASE}
COPY worker.cjs /usr/local/bin/codex
RUN chmod 0755 /usr/local/bin/codex && ln -s /usr/local/bin/codex /usr/local/bin/claude
