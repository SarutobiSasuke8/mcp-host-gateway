# mcp-host-gateway

Hosted MCP edge: auth, rate limits, and paid entitlement in front of product MCPs (JobScout freemium wedge and siblings).

A client speaks MCP over Streamable HTTP to `https://gateway.example/mcp/<upstream>` with a bearer token. The gateway verifies the token, maps the caller to a plan, checks that the plan covers the upstream and the tool, prompt or resource, applies a per-identity rate limit, then forwards the JSON-RPC call to the configured upstream URL and returns the result. It carries no product logic; the upstream MCP server does the work.

**Status:** v1 (production-ready edge for one VPS: shared rate store, streaming SSE relay, container, deploy recipe, audit log, end-to-end test against JobScout). Design and acceptance checklist live in the Agentic Satellite Vault:

`Workspace/Grok/Astraeus/Astraeus MCP Host Gateway Design.md`

in [SarutobiSasuke8/agentic-satellite-vault](https://github.com/SarutobiSasuke8/agentic-satellite-vault) (private).

## Not this project

- **Not** [mcp-dashboard](https://github.com/SarutobiSasuke8/mcp-dashboard) (local cost UI)
- **Not** [mcp-rack](https://github.com/SarutobiSasuke8/mcp-rack) (public catalogue)
- **Not** `asv-mcp-server` (ASV vault proposal gateway)

## What it does

```
client  ──Bearer──▶  gateway  ──▶  auth  ──▶  entitlement  ──▶  rate limit  ──▶  router  ──▶  upstream MCP
                       │                                                            ▲
                       └── JSON-RPC error (401 / 403 / 429 / 502) on any failure ───┘
```

| Stage | Behaviour |
| --- | --- |
| Auth | Bearer JWT verified against the issuer's JWKS (`jose`), with `iss` and `aud` checked. Or `auth.mode: static` for development, tokens from an env var. Missing or invalid tokens get a JSON-RPC error `-32001` with HTTP 401 and a `WWW-Authenticate: Bearer` challenge whose `resource_metadata` points MCP clients at the sign-in server. Keys are cached for seconds, not minutes, so revoked and newly issued tokens take effect quickly; see "Token freshness". |
| Entitlement | Identity to plan (JWT `plan` claim, or the static token entry) to allowed upstreams, tools, prompts and resource URI prefixes. Anything else gets `-32003` with HTTP 403 and a message naming the plan, upstream and tool, prompt or resource. Prompts and resources are deny by default: an upstream needs `prompts_allow` before any prompt is routed, and `resources_allow` before any resource is. |
| Rate limit | Token bucket per identity (optionally per identity and upstream), capacity and refill set by the plan's `rpm`, kept in a `RateStore`: SQLite (WAL) shared across processes and restarts in production, in-memory for tests. Every authenticated call counts, including ones then refused. Over quota gets `-32029` with HTTP 429 and `Retry-After`. |
| Router | Forwards `initialize`, `ping`, `tools/list`, `tools/call`, `notifications/initialized` and `notifications/cancelled` to the upstream over Streamable HTTP via `fetch`, plus `prompts/list` and `prompts/get` for upstreams with a `prompts_allow` list, and `resources/list`, `resources/templates/list` and `resources/read` for upstreams with a `resources_allow` list of URI prefixes. `tools/list`, `prompts/list`, `resources/list` and `resources/templates/list` results are filtered to the grant, whether the upstream answers in JSON or SSE framing. SSE answers are relayed event by event as they arrive (progress notifications reach the client during a long tool call), with the final result of `initialize` and the list methods re-shaped on the way through. `resources/subscribe` and `resources/unsubscribe` are never routed. A client that disconnects aborts the upstream request. Other methods get `-32601`. `Mcp-Session-Id` and `MCP-Protocol-Version` pass through both ways. HTTP `DELETE` (session end) is forwarded. |
| Honest capabilities | The `initialize` result is rewritten per caller: `capabilities` keeps `tools`, `prompts` only when the caller's grant has at least one prompt, and `resources` only when the grant has at least one URI prefix (with `subscribe` removed, since the gateway does not route it). `completions`, `logging`, `experimental` and any unknown capability are dropped, so a client is never told about a method the gateway would refuse. |
| Health | `GET /health` and `GET /ready`, no tenant data. |
| Startup | Fails closed: missing config, missing issuer, unreachable JWKS, missing static tokens, missing upstreams, a plan naming an unknown upstream, tool, prompt or resource prefix, or a rate store that cannot be opened all stop the process with a non-zero exit. |
| Logs | Operational log: JSON lines on stdout. Bearer tokens, JWTs, `Authorization` headers and secret-shaped keys are redacted. Bodies are never logged. |
| Audit | One JSON line per routed call to its own sink (file or stderr), with a fixed schema and no bodies or tokens. See "Audit log". Every response carries `X-Request-Id`, which matches the audit line. |

## Quick start

```sh
npm ci
npm run build
cp .env.example .env            # edit locally, never commit
cp examples/gateway.example.yaml gateway.yaml
npm start
```

Static dev mode, which needs no identity provider:

```yaml
# gateway.yaml
version: 1
auth: { mode: static, tokens_env: GATEWAY_STATIC_TOKENS }
upstreams:
  jobscout:
    url: http://127.0.0.1:3000/mcp
    tools_allow: [jobscout_list_sources, jobscout_search_jobs, jobscout_briefing]
    prompts_allow: [jobscout_setup, jobscout_find_jobs]
entitlements:
  free: { upstreams: [jobscout], rpm: 30 }
  paid: { upstreams: [jobscout], rpm: 300 }
```

```sh
export GATEWAY_STATIC_TOKENS=dev-free-token-0123456789:dev-free:free,dev-paid-token-0123456789:dev-paid:paid
npm start
curl -s -X POST localhost:8080/mcp/jobscout \
  -H 'Authorization: Bearer dev-paid-token-0123456789' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Static tokens are `token:subject:plan` entries, comma separated, at least 16 characters each. They are only ever read from the named env var; a committed file cannot carry one.

## Configuration

```yaml
version: 1
listen: { host: 127.0.0.1, port: 8080 }
auth:
  issuer: https://accounts.example.com     # jwt mode (default when mode is omitted)
  audience: mcp-host-gateway
  # jwks_url, plan_claim (default "plan"), default_plan (omit to deny tokens with no plan)
  # jwks_refresh_seconds: 5, jwks_cooldown_seconds: 1, jwks_max_stale_seconds: 60 (see "Token freshness")
  # resource_metadata_url (default <issuer>/.well-known/oauth-protected-resource/mcp/{upstream})
upstreams:
  jobscout:
    url: https://jobscout.internal/mcp
    tools_allow: [jobscout_list_sources, jobscout_search_jobs, jobscout_briefing]
    prompts_allow: [jobscout_setup, jobscout_find_jobs]   # optional; absent means no prompts/* routing
    # auth_header_env: JOBSCOUT_UPSTREAM_AUTH   # env var with the full Authorization value for the upstream
    # timeout_ms: 30000
  source_pack:
    url: https://source-pack.internal/mcp
    tools_allow: [list_sources, fetch_source]
    resources_allow: ["docs://public/", "sources://catalogue/"]   # optional; URI prefixes; absent means no resources/* routing
entitlements:
  free: { upstreams: [jobscout], rpm: 30 }
  paid: { upstreams: [jobscout, source_pack], rpm: 300 }
  # a plan may narrow an upstream's tools: tools: { jobscout: [jobscout_search_jobs] }
  # and its prompts: prompts: { jobscout: [jobscout_setup] }  ([] means no prompts on that plan)
  # and its resources: resources: { source_pack: ["docs://public/"] }  ([] means no resources on that plan)
rate:
  scope: identity        # or identity_upstream
  store: sqlite          # memory (default) | sqlite; see "Rate limits"
  sqlite_path: ./data/rate.sqlite
audit:
  sink: file             # stderr (default) | file; see "Audit log"
  path: ./data/audit.jsonl
```

The full annotated example is `examples/gateway.example.yaml`. Its JobScout tool and prompt names are exactly what jobscout-mcp `main` returns from `tools/list` and `prompts/list`, and a test fails if the example names anything else.

Prompt rules mirror tool rules: a plan's `prompts` narrowing may only name prompts in that upstream's `prompts_allow`, and only for upstreams on that plan, or the config is rejected at startup. Unlike `tools`, a plan may narrow prompts to an empty list, which hides the `prompts` capability from that plan's callers.

Resource rules follow the same pattern with URI prefixes instead of names. `resources_allow` is a list of plain string prefixes (no template braces, no whitespace); a resource is allowed when its URI starts with any of them, so end each prefix at a boundary the upstream's URIs respect, usually a trailing slash (`docs://public/` does not open `docs://publicity/`). `resources/list` is filtered to resources inside the prefixes, `resources/templates/list` to templates whose literal head (before the first `{`) is inside a prefix, and `resources/read` outside every prefix gets the same `-32003` as a tool outside the plan. A plan's `resources` narrowing may only list prefixes that equal or extend one of the upstream's, and an empty list hides the `resources` capability from that plan. `resources/subscribe` is never routed and `subscribe` is never advertised. Set `GATEWAY_CONFIG` to the file path (default `./gateway.yaml`).

Environment variables are listed in `.env.example`. None are committed with values.

## Token freshness

Revocation at the issuer works by removing a key from its JWKS: JobScout Pro, for example, signs each personal access token with its own key and drops that key when the token is revoked. So how quickly a revoked token stops working, and how quickly a new one starts, is decided by how long the gateway caches the JWKS. The gateway polls the JWKS on demand with three bounds:

| Setting (`auth.*`) | Default | Effect |
| --- | --- | --- |
| `jwks_refresh_seconds` | 5 | No token is verified against a key set older than this. The first call after it expires refetches before verifying (one fetch shared by every concurrent call). A revoked token stops working within this many seconds. |
| `jwks_cooldown_seconds` | 1 | A token whose key id is not in the cache triggers an immediate refetch, so a new token works on its first call. Refetches started this way, and retries after a failed fetch, are at least this far apart, so a stream of made-up key ids cannot flood the issuer. Worst case for a new token: this many seconds. |
| `jwks_max_stale_seconds` | 60 | If the issuer cannot be reached, the last good key set is still used for this long, then every call gets `-32004` with HTTP 503 and `Retry-After` until the issuer answers. Set it equal to `jwks_refresh_seconds` to fail closed at once. During an outage, revocation latency rises to this value. |

Measured locally with the defaults (`test/token-freshness.test.ts`, real clock, stub issuer): a revoked token was refused after about 5 s and a new token accepted after about 1 s. Before this change the gateway used jose's remote key set defaults: a 10 minute cache and a 30 second cooldown, which is what JobScout Pro measured.

A poll was chosen over a signed revocation webhook: it needs no shared secret, no new endpoint and no change at the issuer, it works across several gateway processes without coordination, and at one small JWKS request per process every 5 seconds of traffic the cost is negligible. Short-lived OAuth access tokens (minutes) are not revoked this way; they expire, and the issuer refuses to refresh them.

### Pointing clients at the sign-in server

Every 401 carries an RFC 6750 Bearer challenge with the RFC 9728 `resource_metadata` parameter that the MCP authorisation spec asks for, so a client can discover the authorisation server from the 401 alone:

```
WWW-Authenticate: Bearer realm="mcp-host-gateway", resource_metadata="https://pro.example.com/.well-known/oauth-protected-resource/mcp/jobscout", error="invalid_token", error_description="token expired"
```

`error` is omitted when the request had no `Authorization` header at all, `invalid_request` when the header is malformed and `invalid_token` when the token is rejected. The URL defaults to `<issuer>/.well-known/oauth-protected-resource/mcp/<upstream>`, which suits an issuer on the gateway's public host that publishes metadata per `/mcp/<upstream>` resource (JobScout Pro does). Otherwise set `auth.resource_metadata_url`; `{upstream}` in it is replaced by the upstream name. Static mode has no issuer and sends no `resource_metadata`.

## Rate limits

```yaml
rate:
  scope: identity            # or identity_upstream
  store: sqlite              # memory (default) | sqlite
  sqlite_path: ./data/rate.sqlite
```

Buckets sit behind a `RateStore` interface (`src/rate/index.ts`). Two implementations ship:

- `memory` (`TokenBucketLimiter`): one process, reset on restart. Tests and local dev.
- `sqlite` (`SqliteRateStore`): Node's built-in `node:sqlite`, WAL journal, one short `BEGIN IMMEDIATE` transaction per call with a 5 second busy timeout. Every gateway process that opens the same file shares one set of buckets, and the file outlives restarts.

**Why SQLite (WAL) and not Redis.** The gateway runs on one VPS today. SQLite on the data volume needs no extra service to run, patch, authenticate, back up or monitor, adds no network hop to every call, and has no native module to compile (the driver is built into Node 22.13+). WAL plus `BEGIN IMMEDIATE` serialises writers across processes on the host, so a restart, a crash, two worker processes, or an old and a new container overlapping during an upgrade all see the same quota. What it cannot do is span hosts: when a second VPS arrives, the plan is a `RedisRateStore` implementing the same interface (the bucket arithmetic is shared in `stepBucket`), selected by `rate.store: redis`. Tests prove the limit holds across a restart and across two separate gateway processes sharing the file (`test/rate-store.test.ts`).

## Audit log

```yaml
audit:
  sink: file                 # file | stderr (default)
  path: ./data/audit.jsonl
```

One JSON line per routed call (every request to `/mcp/<upstream>`, allowed or refused). It is written to its own sink, never to the operational log on stdout. Every key is always present, in this order; absent values are `null`.

| Key | Type | Meaning |
| --- | --- | --- |
| `ts` | string | ISO 8601 time the call finished |
| `request_id` | string | Gateway-generated UUID, also sent to the client as `X-Request-Id` |
| `subject` | string or null | Authenticated identity; null when authentication failed |
| `plan` | string or null | Plan, once resolved |
| `upstream` | string | Upstream from the path `/mcp/<upstream>` |
| `method` | string or null | JSON-RPC method, or `HTTP DELETE` / `HTTP GET` for non-POST requests; null if the body never parsed |
| `tool` | string or null | `params.name` of a `tools/call` |
| `prompt` | string or null | `params.name` of a `prompts/get` |
| `resource` | string or null | `params.uri` of a `resources/read` |
| `decision` | string | `allow`, `deny`, `rate_limited` or `upstream_error` |
| `reason` | string or null | Why the call was not allowed; `client_disconnected` when the client left mid-stream |
| `status` | integer | HTTP status returned; 499 when the client disconnected before the response finished |
| `duration_ms` | integer | Time from request start to response end, streaming included |

Example:

```json
{"ts":"2026-10-08T12:00:00.000Z","request_id":"0f8e4c1a-7b2d-4e5f-9a3c-1d2e3f4a5b6c","subject":"user-123","plan":"free","upstream":"jobscout","method":"tools/call","tool":"jobscout_deduplicate","prompt":null,"resource":null,"decision":"deny","reason":"Forbidden: tool \"jobscout_deduplicate\" is not available on plan \"free\" for upstream \"jobscout\"","status":403,"duration_ms":2}
```

Never written: request or response bodies, tool or prompt arguments, tool results, resource contents, headers, bearer tokens, upstream credentials or client IP addresses. String fields also pass through the log redaction and are capped at 256 characters, so a token smuggled into a tool name is still redacted. `test/audit.test.ts` drives allow, deny, rate-limited and upstream-error calls with canary values in the tokens, the upstream credential, the arguments and the response, and asserts none of them appear.

## Container

```sh
docker build -t mcp-host-gateway:local .
docker run --rm -p 8080:8080 \
  -v "$PWD/gateway.yaml:/etc/mcp-host-gateway/gateway.yaml:ro" \
  -v gateway-data:/app/data --env-file gateway.env mcp-host-gateway:local
```

Multi-stage build, runtime on `node:22-bookworm-slim` as the unprivileged `node` user, Docker `HEALTHCHECK` on `/health`. The config is mounted, never baked in: without it the container exits non-zero. `scripts/docker-smoke.sh` checks build, fail-closed start and healthy start. For a full single-VPS recipe (Caddy for TLS, JobScout as the example upstream, secrets, logs, upgrade and rollback) see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Error shape

Every rejection is a JSON-RPC 2.0 error object so an MCP client can show the reason:

```json
{ "jsonrpc": "2.0", "id": 5, "error": { "code": -32003, "message": "Forbidden: tool \"jobscout_deduplicate\" is not available on plan \"free\" for upstream \"jobscout\"", "data": { "plan": "free", "upstream": "jobscout", "tool": "jobscout_deduplicate" } } }
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| -32001 | 401 | Unauthenticated (missing, malformed, expired, wrong issuer or audience, bad signature) |
| -32003 | 403 | Forbidden by entitlement (plan, upstream, tool, prompt or resource URI) |
| -32029 | 429 | Rate limit exceeded, `Retry-After` header set |
| -32600 | 400 | Invalid JSON-RPC request (batches, non-JSON bodies, oversize bodies) |
| -32601 | 404 | Method not routed (including `prompts/*` on an upstream without `prompts_allow`, `resources/*` on one without `resources_allow`, and `resources/subscribe` anywhere), or unknown upstream path |
| -32002 | 502 | Upstream unreachable, timed out, or returned 5xx |
| -32004 | 503 | Token cannot be checked: the issuer's JWKS has been unreachable for longer than `jwks_max_stale_seconds`. `Retry-After` header set |

These are HTTP error statuses with a JSON-RPC error body. The official TypeScript client surfaces them as an `SdkHttpError` whose message contains the JSON-RPC body, so the code and reason reach the caller (see `test/e2e-jobscout.test.ts`).

## Decisions (open questions from the design, answered)

| Question | Decision | Reason |
| --- | --- | --- |
| OAuth provider | Any issuer that publishes a JWKS and mints JWTs with `iss`, `aud`, `sub`, `exp` and a plan claim. No provider SDK. Static env tokens for dev and tests. | Keeps the gateway provider-neutral; the paid-account issuer can be chosen later without code changes. |
| SSE fallback | Streamable HTTP only. `GET /mcp/<upstream>` (server-initiated stream) returns 405. SSE-framed upstream responses to POSTs are streamed through as they arrive (v1). | The 2025-06-18 transport is the target; legacy HTTP+SSE adds a second code path for no current customer. |
| Shared rate store (v1) | SQLite in WAL mode behind a `RateStore` interface. | One VPS: no extra service, survives restarts, shared by every process on the host. Redis is the next `RateStore` when a second host exists. See "Rate limits". |
| Reverse proxy (v1) | Caddy. | Automatic TLS, SSE relayed without buffering by default, small config. See `docs/DEPLOYMENT.md`. |
| Entitlement source of truth | Static YAML plan map in config, plus the token's `plan` claim to pick the plan. | One file to review in a PR; no billing system to call at request time. |
| npm vs deploy-only | Deploy-only. `private: true`, no publish. | Nothing to install as a library yet; a published package would imply an API contract v0 does not have. |
| Prompts (#3) | Routed per upstream behind a deny-by-default `prompts_allow`, narrowed per plan, `prompts/list` filtered and `prompts/get` gated like `tools/call`. `initialize` capabilities rewritten to what the caller can actually use. | JobScout exposes onboarding prompts (`jobscout_setup`, `jobscout_find_jobs`). Passing `initialize` through told clients about `prompts` and then answered `-32601`; an honest, smaller capability set is better than an error. |
| Resources (#9) | Routed per upstream behind a deny-by-default `resources_allow` list of URI prefixes, narrowed per plan, `resources/list` and `resources/templates/list` filtered to the prefixes and `resources/read` gated like `tools/call`. `subscribe` is neither routed nor advertised. | Hosted MCPs expose docs, schemas and job snapshots as resources. Prefix grants keep the policy in one YAML file and let an operator open `docs://public/` without opening `docs://internal/`. Subscriptions need a server-to-client stream the gateway does not relay. |

## MVP acceptance checklist

- [x] Edge process starts from config; fails closed if auth issuer or upstream config missing. (`test/config.test.ts`, `test/auth.test.ts`, `test/edge.test.ts`)
- [x] Unauthenticated call rejected with a clear MCP-facing error. (`test/edge.test.ts`)
- [x] Rate limit enforced in unit tests (over-quota denied). (`test/rate.test.ts`, and over HTTP in `test/edge.test.ts`)
- [x] Entitlement map denies an upstream or tool not on the caller's plan. (`test/entitlement.test.ts`, `test/edge.test.ts`)
- [x] At least one allowed path forwards to a stub upstream and returns a tool result. (`test/edge.test.ts`, in-process HTTP stub MCP)
- [x] No credentials in git; `.env.example` only.
- [x] British English in docs; no em dashes.

## v1 checklist

- [x] `RateStore` interface with in-memory and SQLite (WAL) stores; limits hold across a restart and across two gateway processes sharing the store. (`test/rate-store.test.ts`)
- [x] SSE responses streamed (first event reaches the client before the upstream finishes); client disconnect aborts the upstream; list filtering still applies. (`test/streaming.test.ts`)
- [x] Multi-stage, non-root Dockerfile with `/health` healthcheck and `.dockerignore`; fails closed without config. (`Dockerfile`, `scripts/docker-smoke.sh`, static checks in `test/deploy.test.ts`)
- [x] Single-VPS deploy recipe with Caddy for TLS and JobScout as the example upstream, placeholders only. (`docs/DEPLOYMENT.md`, `deploy/`)
- [x] Audit log with a documented schema; a test asserts no token or body leaks. (`test/audit.test.ts`)
- [x] Offline end-to-end test against the real JobScout HTTP server (pinned by git SHA) with the official MCP client. (`test/e2e-jobscout.test.ts`)
- [x] Revoked tokens refused and new tokens accepted within seconds; 401s carry `WWW-Authenticate` with `resource_metadata`. (#7, `test/token-freshness.test.ts`)
- [x] `resources/list`, `resources/templates/list` and `resources/read` routed behind a deny-by-default `resources_allow` prefix list; lists filtered, reads outside the prefixes forbidden, capability advertised only when granted. (#9, `test/resources.test.ts`)

Deferred, with reasons:

- Rate store across hosts (Redis). One VPS today; add a `RedisRateStore` when a second host exists.
- Legacy HTTP+SSE transport and `GET` server-to-client streams. Not needed by the first upstream; JobScout runs stateless.
- Production OAuth provider choice. Any JWKS issuer works; which one is a product decision.
- Entitlement lookups against a billing system. Static YAML plus the token claim covers the freemium wedge.
- `resources/subscribe` and `completions/complete`. Subscriptions need the server-to-client stream above; completions wait for an upstream that needs them. The gateway strips those capabilities from `initialize` so clients do not try.

## Development

```sh
npm run check      # typecheck, lint, build, tests (including the JobScout e2e)
npm run test       # build then node --test dist/test/*.test.js
npm run test:e2e   # just the JobScout end-to-end test
npm run docker:smoke   # docker build + fail-closed + healthcheck (needs a Docker daemon)
```

Requires Node 22.13 or newer (`node:sqlite`). Tests spin up in-process stub upstreams, a stub JWKS endpoint, real child gateway processes (for the shared rate store) and the real `jobscout-mcp-http` server from the pinned devDependency (`@sarutobi-sasuke/jobscout-mcp`, git SHA `621ddcf`), with every JobScout provider off; nothing external is contacted while tests run. `npm ci` itself fetches that dependency from GitHub. The same command is the verify step for a VPS when GitHub Actions is unavailable; see `docs/DEPLOYMENT.md`.

Layout: `src/edge` (HTTP server, errors), `src/auth`, `src/rate` (store interface, memory, SQLite), `src/entitlement`, `src/router` (routing, filtering, SSE relay), `src/audit.ts`, `src/config.ts`, `src/log.ts`, `examples/`, `deploy/`, `scripts/`, `test/`, `docs/`.

## Licence

MIT. See `LICENSE`.
