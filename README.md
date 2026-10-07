# mcp-host-gateway

Hosted MCP edge: auth, rate limits, and paid entitlement in front of product MCPs (JobScout freemium wedge and siblings).

A client speaks MCP over Streamable HTTP to `https://gateway.example/mcp/<upstream>` with a bearer token. The gateway verifies the token, maps the caller to a plan, checks that the plan covers the upstream and the tool, applies a per-identity rate limit, then forwards the JSON-RPC call to the configured upstream URL and returns the result. It carries no product logic; the upstream MCP server does the work.

**Status:** v0. Design and acceptance checklist live in the Agentic Satellite Vault:

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
| Auth | Bearer JWT verified against the issuer's JWKS (`jose`), with `iss` and `aud` checked. Or `auth.mode: static` for development, tokens from an env var. Missing or invalid tokens get a JSON-RPC error `-32001` with HTTP 401. |
| Entitlement | Identity to plan (JWT `plan` claim, or the static token entry) to allowed upstreams and tools. Anything else gets `-32003` with HTTP 403 and a message naming the plan, upstream and tool. |
| Rate limit | In-memory token bucket per identity (optionally per identity and upstream), capacity and refill set by the plan's `rpm`. Over quota gets `-32029` with HTTP 429 and `Retry-After`. |
| Router | Forwards `initialize`, `ping`, `tools/list`, `tools/call`, `notifications/initialized` and `notifications/cancelled` to the upstream over Streamable HTTP via `fetch`. `tools/list` results are filtered to the grant, whether the upstream answers in JSON or SSE framing. Other methods get `-32601`. `Mcp-Session-Id` and `MCP-Protocol-Version` pass through both ways. HTTP `DELETE` (session end) is forwarded. |
| Health | `GET /health` and `GET /ready`, no tenant data. |
| Startup | Fails closed: missing issuer, unreachable JWKS, missing static tokens, missing upstreams, or a plan naming an unknown upstream or tool all stop the process with a non-zero exit. |
| Logs | JSON lines. Bearer tokens, JWTs, `Authorization` headers and secret-shaped keys are redacted. Bodies are never logged. |

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
  jobscout: { url: http://127.0.0.1:3000/mcp, tools_allow: [search_jobs, get_listing] }
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
upstreams:
  jobscout:
    url: https://jobscout.internal/mcp
    tools_allow: [search_jobs, get_listing]
    # auth_header_env: JOBSCOUT_UPSTREAM_AUTH   # env var with the full Authorization value for the upstream
    # timeout_ms: 30000
entitlements:
  free: { upstreams: [jobscout], rpm: 30 }
  paid: { upstreams: [jobscout, source_pack], rpm: 300 }
  # a plan may narrow an upstream's tools: tools: { jobscout: [search_jobs] }
rate:
  scope: identity        # or identity_upstream
```

The full annotated example is `examples/gateway.example.yaml`. Set `GATEWAY_CONFIG` to the file path (default `./gateway.yaml`).

Environment variables are listed in `.env.example`. None are committed with values.

## Error shape

Every rejection is a JSON-RPC 2.0 error object so an MCP client can show the reason:

```json
{ "jsonrpc": "2.0", "id": 5, "error": { "code": -32003, "message": "Forbidden: tool \"get_listing\" is not available on plan \"free\" for upstream \"jobscout\"", "data": { "plan": "free", "upstream": "jobscout", "tool": "get_listing" } } }
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| -32001 | 401 | Unauthenticated (missing, malformed, expired, wrong issuer or audience, bad signature) |
| -32003 | 403 | Forbidden by entitlement (plan, upstream or tool) |
| -32029 | 429 | Rate limit exceeded, `Retry-After` header set |
| -32600 | 400 | Invalid JSON-RPC request (batches, non-JSON bodies, oversize bodies) |
| -32601 | 404 | Method not routed, or unknown upstream path |
| -32002 | 502 | Upstream unreachable, timed out, or returned 5xx |

## v0 decisions (open questions from the design, answered)

| Question | v0 decision | Reason |
| --- | --- | --- |
| OAuth provider | Any issuer that publishes a JWKS and mints JWTs with `iss`, `aud`, `sub`, `exp` and a plan claim. No provider SDK. Static env tokens for dev and tests. | Keeps the gateway provider-neutral; the paid-account issuer can be chosen later without code changes. |
| SSE fallback | Streamable HTTP only. `GET /mcp/<upstream>` (server-initiated stream) returns 405. SSE-framed upstream responses are buffered and relayed, not streamed. | The 2025-06-18 transport is the target; legacy HTTP+SSE adds a second code path for no v0 customer. |
| Entitlement source of truth | Static YAML plan map in config, plus the token's `plan` claim to pick the plan. | One file to review in a PR; no billing system to call at request time. |
| npm vs deploy-only | Deploy-only. `private: true`, no publish. | Nothing to install as a library yet; a published package would imply an API contract v0 does not have. |

## MVP acceptance checklist

- [x] Edge process starts from config; fails closed if auth issuer or upstream config missing. (`test/config.test.ts`, `test/auth.test.ts`, `test/edge.test.ts`)
- [x] Unauthenticated call rejected with a clear MCP-facing error. (`test/edge.test.ts`)
- [x] Rate limit enforced in unit tests (over-quota denied). (`test/rate.test.ts`, and over HTTP in `test/edge.test.ts`)
- [x] Entitlement map denies an upstream or tool not on the caller's plan. (`test/entitlement.test.ts`, `test/edge.test.ts`)
- [x] At least one allowed path forwards to a stub upstream and returns a tool result. (`test/edge.test.ts`, in-process HTTP stub MCP)
- [x] No credentials in git; `.env.example` only.
- [x] British English in docs; no em dashes.

Deferred from v0, with reasons:

- Shared rate-limit store (Redis or similar). Single-process buckets are enough for one instance; add when a second instance exists.
- Streaming relay of SSE tool responses. Responses are buffered, which loses progress notifications on long tool calls but returns correct results. Revisit when an upstream needs it.
- Legacy HTTP+SSE transport and `GET` server-to-client streams. Not needed by the first upstream.
- Entitlement lookups against a billing system. Static YAML plus the token claim covers the freemium wedge.
- `resources/*` and `prompts/*` routing. Out of scope until an upstream exposes them; allowing them without filtering would widen the surface.

## Development

```sh
npm run check      # typecheck, lint, build, tests
npm run test       # build then node --test dist/test/*.test.js
```

Tests spin up in-process stub upstreams and a stub JWKS endpoint; nothing external is contacted. The same command is the verify step for a VPS when GitHub Actions is unavailable; see `docs/DEPLOYMENT.md`.

Layout: `src/edge` (HTTP server, errors), `src/auth`, `src/rate`, `src/entitlement`, `src/router`, `src/config.ts`, `src/log.ts`, `examples/`, `tests/` as `test/`, `docs/`.

## Licence

MIT. See `LICENSE`.
