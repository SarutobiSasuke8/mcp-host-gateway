# Deployment (v1, single VPS)

This is the recipe for running the gateway on one VPS with TLS at a reverse proxy and JobScout as the example upstream. Every host name, email address and issuer below is a placeholder. Nothing in this repository deploys anything.

```
internet ──443──▶ Caddy (TLS, ACME) ──▶ gateway:8080 ──▶ jobscout:8080/mcp
                                          │
                                          └── /app/data volume: rate.sqlite (WAL), audit.jsonl
```

Files used, all in this repo:

| File | Goes to | Purpose |
| --- | --- | --- |
| `Dockerfile` | built on the VPS | Multi-stage image, runs as `node` (uid 1000), healthcheck on `/health`. |
| `deploy/compose.yaml` | `/opt/mcp-host-gateway/deploy/` | Caddy, gateway, JobScout. Only Caddy publishes ports. |
| `deploy/Caddyfile` | same directory | TLS and the `/mcp/*` reverse proxy. |
| `deploy/gateway.yaml` | `/etc/mcp-host-gateway/gateway.yaml` | Gateway config (JWT auth, SQLite rate store, file audit sink). |
| `deploy/gateway.env.example` | `/etc/mcp-host-gateway/gateway.env` | Gateway secrets (upstream credentials). Mode 0600. |
| `deploy/jobscout.env.example` | `/etc/mcp-host-gateway/jobscout.env` | JobScout settings and its optional bearer token. Mode 0600. |
| `deploy/.env.example` | `/opt/mcp-host-gateway/deploy/.env` | Compose substitution: domain, ACME email, image tag. |

## Why Caddy

Caddy over nginx for this recipe, for three reasons:

1. **TLS with no moving parts.** Caddy obtains and renews certificates by itself (ACME) from one line naming the domain. nginx needs certbot, a renewal timer and a reload hook, which is three more things to break on a single box.
2. **SSE is relayed without buffering.** Caddy flushes `text/event-stream` responses immediately (and the Caddyfile sets `flush_interval -1` explicitly). nginx buffers proxied responses by default and needs `proxy_buffering off`, `proxy_cache off` and HTTP/1.1 keep-alive tuning per location before streamed tool progress works. The gateway also sends `X-Accel-Buffering: no` so an nginx front end would behave, but Caddy needs nothing.
3. **Small config surface.** The whole proxy config is about 30 lines with safe defaults (HTTP to HTTPS redirect, HSTS header, no access log of `Authorization`).

nginx remains a fine choice if the VPS already runs it; the gateway does not depend on Caddy.

## Why SQLite (WAL) for the rate store

See the README section "Rate limits" for the full reasoning. In short: one VPS today, so a file on the `gateway-data` volume gives limits that survive restarts and container replacement and that are shared by every gateway process on the host (including an old and a new container running side by side during an upgrade), with no extra service to run or secure. A second VPS needs a network store; that is a new `RateStore` (Redis) behind the same interface.

## One-time setup

On a fresh Debian or Ubuntu VPS with Docker Engine and the compose plugin installed, a DNS `A`/`AAAA` record for `gateway.example.com` pointing at it, and ports 80 and 443 open:

```sh
sudo mkdir -p /opt/mcp-host-gateway /etc/mcp-host-gateway
sudo git clone https://github.com/SarutobiSasuke8/mcp-host-gateway.git /opt/mcp-host-gateway
cd /opt/mcp-host-gateway
sudo git checkout <release-commit>

# Config: copy, then replace every placeholder (issuer, audience, plans).
sudo cp deploy/gateway.yaml /etc/mcp-host-gateway/gateway.yaml

# Secrets: never in git. Fill from your secret store.
sudo install -m 0600 -o root -g root deploy/gateway.env.example /etc/mcp-host-gateway/gateway.env
sudo install -m 0600 -o root -g root deploy/jobscout.env.example /etc/mcp-host-gateway/jobscout.env

# Compose substitution values.
sudo cp deploy/.env.example deploy/.env
sudo "${EDITOR:-nano}" deploy/.env    # GATEWAY_DOMAIN, ACME_EMAIL, GATEWAY_TAG

cd deploy
sudo docker compose up -d --build
sudo docker compose ps                # gateway and jobscout should be "healthy"
```

### Secrets and environment

- **Client tokens** are JWTs minted by your issuer and verified against its JWKS. The gateway holds no client secret. Static tokens (`auth.mode: static`) are for development and tests only and must not be used here.
- **Upstream credentials.** If JobScout runs with `JOBSCOUT_HTTP_BEARER_TOKEN` (in `jobscout.env`), put the same value in `gateway.env` as `JOBSCOUT_UPSTREAM_AUTH=Bearer <value>` and uncomment `auth_header_env: JOBSCOUT_UPSTREAM_AUTH` in `gateway.yaml`. The gateway sends it upstream and never logs it.
- Both env files are `0600 root:root` and are read by Docker at container start. `.env` files are git-ignored.

### What fails closed

The gateway container exits non-zero, and Docker keeps restarting it without ever passing its healthcheck, if:

- no config file is mounted at `GATEWAY_CONFIG`, or the config is invalid;
- `auth.issuer` is missing, or the JWKS endpoint is unreachable or publishes no keys;
- a plan references an upstream, tool, prompt or resource prefix that is not configured;
- the SQLite rate store cannot be opened (for example the volume is read-only).

Caddy depends on the gateway being healthy, so a gateway that cannot start never receives traffic.

Once running, the gateway refetches the issuer's JWKS every few seconds of traffic (README "Token freshness"). If the issuer stays unreachable for longer than `auth.jwks_max_stale_seconds` (default 60), calls get HTTP 503 with `Retry-After` until it answers again; `/health` and `/ready` are unaffected.

## Health

- `GET /health` returns `{"status":"ok"}` once the process is up. Used by the Docker healthcheck.
- `GET /ready` returns 200 once startup probes passed, 503 before.

Both stay on the internal network: the Caddyfile only proxies `/mcp/*`. Neither reveals tenants, plans or upstream URLs.

## Logs

There are two separate streams.

| Stream | Where | Contents |
| --- | --- | --- |
| Operational log | container stdout (`docker compose logs gateway`), rotated by the json-file driver (10 MB x 5) | Startup, shutdown, warnings, per-call summaries. JSON lines, secrets redacted. Level from `GATEWAY_LOG_LEVEL`. |
| Audit log | `/app/data/audit.jsonl` on the `gateway-data` volume | One JSON line per routed call. Schema in the README, "Audit log". No bodies, no tokens. |

Read the audit trail on the host with:

```sh
sudo docker compose exec gateway tail -f /app/data/audit.jsonl
```

The audit file is append-only and is not rotated by the gateway. Rotate it with `logrotate` using `copytruncate` against the volume path (`docker volume inspect mcp-host-gateway_gateway-data` shows it), or ship it to your log store and truncate. Keep at least as long as your billing dispute window.

## Verify

```sh
curl -fsS https://gateway.example.com/mcp/jobscout \
  -H "Authorization: Bearer <a real JWT from your issuer>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A JSON-RPC result listing the tools on the token's plan means TLS, auth, entitlement, routing and the upstream all work. Then check the audit line for it appeared.

Before deploying a build, run the same checks as CI on any machine with Node 22.13 or newer, and the container check on any machine with Docker:

```sh
npm ci && npm run check      # typecheck, lint, all tests including the offline JobScout e2e
sh scripts/docker-smoke.sh   # docker build, fail-closed start, healthy start
```

## Upgrade

```sh
cd /opt/mcp-host-gateway
sudo git fetch && sudo git checkout <new-release-commit>
cd deploy
sudo sed -i 's/^GATEWAY_TAG=.*/GATEWAY_TAG=<new-short-sha>/' .env
sudo docker compose build gateway
sudo docker compose up -d gateway
sudo docker compose ps gateway        # wait for "healthy"
```

Rate limits carry over: the new container opens the same `rate.sqlite` on the `gateway-data` volume, so a restart or upgrade does not reset anyone's quota. Keep the previous image tag noted for rollback; `docker image ls mcp-host-gateway` lists them.

## Rollback

```sh
cd /opt/mcp-host-gateway/deploy
sudo sed -i 's/^GATEWAY_TAG=.*/GATEWAY_TAG=<previous-short-sha>/' .env
sudo docker compose up -d --no-build gateway
cd .. && sudo git checkout <previous-release-commit>   # keep the checkout in step with the image
```

If the previous image was pruned, check out the previous commit and run `docker compose build gateway` first. The rate store schema has not changed since v1 introduced it, so old and new images can share the volume. If a future release changes it, its notes will say so.

## Without containers

The same build runs under systemd if Docker is not wanted:

```ini
[Unit]
Description=mcp-host-gateway
After=network-online.target

[Service]
WorkingDirectory=/opt/mcp-host-gateway
EnvironmentFile=/etc/mcp-host-gateway/gateway.env
Environment=GATEWAY_CONFIG=/etc/mcp-host-gateway/gateway.yaml
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning dist/src/main.js
Restart=on-failure
User=mcpgw
StateDirectory=mcp-host-gateway

[Install]
WantedBy=multi-user.target
```

Point `rate.sqlite_path` and `audit.path` at `/var/lib/mcp-host-gateway/`, build with `npm ci && npm run build`, and keep the gateway bound to `127.0.0.1` behind Caddy.
