# Deployment (v0)

The gateway is a single Node process. It holds no state beyond in-memory rate buckets, so it restarts cleanly, but a multi-instance deployment needs a shared limiter (not in v0).

## Requirements

- Node 20.19 or newer (CI runs Node 22).
- A config file (see `examples/gateway.example.yaml`).
- In JWT mode: an OAuth or paid-account issuer that publishes a JWKS and mints tokens with `iss`, `aud`, `sub`, `exp` and a plan claim.
- In static mode: the `GATEWAY_STATIC_TOKENS` env var. Static mode is for development and tests only.

## Build and run

```sh
npm ci
npm run build
GATEWAY_CONFIG=./gateway.yaml npm start
```

`npm start` loads `.env` if present (Node's `--env-file-if-exists`). Never commit `.env`; copy `.env.example` and fill it locally or inject the variables from your secret store.

Startup fails closed. The process exits non-zero, with the reason on stderr, if:

- the config file is missing or invalid;
- `auth.issuer` is missing in JWT mode, or the JWKS endpoint is unreachable or publishes no keys;
- `GATEWAY_STATIC_TOKENS` is unset or malformed in static mode;
- no upstream is configured, or a plan references an upstream or tool that is not configured.

## Verify locally or on a VPS

GitHub Actions billing may be blocked on some repos, so the same check runs anywhere Node 22 is installed:

```sh
npm ci && npm run check
```

That runs `typecheck`, `lint` and the test suite (which spins up in-process stub upstreams and a stub JWKS endpoint; nothing external is contacted).

Smoke test a running instance in static mode:

```sh
export GATEWAY_STATIC_TOKENS=dev-paid-token-0123456789:dev-paid:paid
export GATEWAY_CONFIG=./gateway.yaml   # with auth.mode: static
npm start &
curl -s localhost:8080/health
curl -s localhost:8080/ready
curl -s -X POST localhost:8080/mcp/jobscout \
  -H 'Authorization: Bearer dev-paid-token-0123456789' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Process management

Any supervisor works. A minimal systemd unit:

```ini
[Unit]
Description=mcp-host-gateway
After=network-online.target

[Service]
WorkingDirectory=/opt/mcp-host-gateway
EnvironmentFile=/etc/mcp-host-gateway.env
ExecStart=/usr/bin/node dist/src/main.js
Restart=on-failure
User=mcpgw

[Install]
WantedBy=multi-user.target
```

`/etc/mcp-host-gateway.env` holds `GATEWAY_CONFIG` and any `*_UPSTREAM_AUTH` values, mode 0600.

## TLS and exposure

The gateway speaks plain HTTP. Put it behind a TLS-terminating reverse proxy (Caddy, nginx, a cloud load balancer) and bind `listen.host` to a private interface. Clients send bearer tokens, so plain HTTP must never be exposed to the internet.

Health endpoints for the proxy or orchestrator:

- `GET /health` returns `{"status":"ok"}` once the process is up.
- `GET /ready` returns 200 with `{"status":"ready","auth_mode":...,"upstreams":N}` once startup probes have passed, 503 before that.

Neither endpoint reveals tenant, plan or upstream URLs.

## Logs

One JSON object per line on stdout. Bearer tokens, JWTs, `Authorization` headers and any key ending in `_auth` are redacted before writing. Request and response bodies are never logged. Set `GATEWAY_LOG_LEVEL=debug|info|warn|error` (default `info`).

## Container

No Dockerfile ships in v0. A two-line one works: `FROM node:22-alpine`, copy the repo, `npm ci && npm run build`, `CMD ["node","dist/src/main.js"]`, with the config mounted and env injected at runtime.
