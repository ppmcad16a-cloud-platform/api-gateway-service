# ============================================================
# API Gateway Service - container image
#
# Multi-stage build:
#   1. "deps"    installs production dependencies only
#   2. "runtime" copies them + the source into a small image
#
# Security:
#   - runs as the unprivileged "node" user (not root)
#   - no dev dependencies, tests or .env files in the image
#   - started with "node" directly (not "npm start") so the
#     process receives SIGTERM and can shut down gracefully
# ============================================================

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: never run third-party install scripts at build time
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force


FROM node:22-alpine AS runtime
ENV NODE_ENV=production

# The app never runs npm/yarn at runtime, but the base image ships them
# (with their own vulnerable dependencies). Removing them shrinks the
# image and the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json index.js ./
COPY --chown=node:node lib ./lib

USER node
EXPOSE 3000

# Used by "docker run"/docker compose; Kubernetes uses its own probes.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "index.js"]
