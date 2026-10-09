# mcp-host-gateway container image. Multi-stage: build with the full toolchain, run on a slim
# base as the unprivileged `node` user. Nothing here is deployed by this repo.
#
# Build:  docker build -t mcp-host-gateway:local .
# Run:    docker run --rm -p 8080:8080 \
#           -v "$PWD/gateway.yaml:/etc/mcp-host-gateway/gateway.yaml:ro" \
#           -v gateway-data:/app/data --env-file gateway.env mcp-host-gateway:local
#
# The config file is NOT baked in. Without one mounted at $GATEWAY_CONFIG the process exits
# non-zero at startup (fail closed), so a misconfigured container never serves traffic.

FROM node:22-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json ./
# --ignore-scripts: the JobScout devDependency is only needed by the e2e test, so it is fetched
# (git is present in this full image) but not built here.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npx tsc -p tsconfig.json && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    GATEWAY_CONFIG=/etc/mcp-host-gateway/gateway.yaml \
    GATEWAY_HEALTH_PORT=8080
WORKDIR /app
COPY --from=build --chown=root:root /src/package.json ./package.json
COPY --from=build --chown=root:root /src/node_modules ./node_modules
COPY --from=build --chown=root:root /src/dist/src ./dist/src
# Rate store (SQLite, WAL) and the audit file live on a volume owned by the runtime user.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.GATEWAY_HEALTH_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/src/main.js"]
