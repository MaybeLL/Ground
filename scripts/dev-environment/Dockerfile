# Bootstrap needs network for public OS/npm dependencies; execution is offline.
FROM node:22-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git openssl procps ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/grounds-deps/typescript
COPY typescript/package.json typescript/package-lock.json ./
COPY typescript/binding.gyp ./
COPY typescript/native/ native/
COPY typescript/vendor/ vendor/
RUN npm ci --no-audit --no-fund --registry=https://registry.npmjs.org && node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npx --no-install playwright install --with-deps --only-shell chromium
WORKDIR /opt/grounds-deps/tui
COPY tui/package.json tui/package-lock.json ./
RUN npm ci --no-audit --no-fund --registry=https://registry.npmjs.org
COPY scripts/dev-environment/dependency-fingerprint.mjs /usr/local/lib/grounds-dependency-fingerprint.mjs
COPY scripts/dev-environment/grounds-dev /usr/local/bin/grounds-dev
RUN chmod 755 /usr/local/bin/grounds-dev
RUN mkdir -p /private && ln -s /workspace/node_modules/.grounds-dev/tmp /private/tmp
ARG GROUNDS_DEV_UID=1000
ARG GROUNDS_DEV_GID=1000
RUN if ! getent group "$GROUNDS_DEV_GID" >/dev/null; then groupadd -g "$GROUNDS_DEV_GID" grounds-developer; fi \
 && if ! getent passwd "$GROUNDS_DEV_UID" >/dev/null; then useradd --no-log-init -u "$GROUNDS_DEV_UID" -g "$GROUNDS_DEV_GID" -d /workspace/node_modules/.grounds-dev/home -M grounds-developer; fi
WORKDIR /workspace
