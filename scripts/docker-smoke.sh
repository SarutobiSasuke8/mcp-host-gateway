#!/bin/sh
# Container acceptance check for mcp-host-gateway. Needs a running Docker daemon.
#
#   1. docker build succeeds;
#   2. the container fails closed (exits non-zero) when no config is mounted;
#   3. with a valid config it starts and Docker reports it healthy via the /health healthcheck.
#
# Uses static dev auth with a synthetic token and a placeholder upstream; nothing external is
# contacted. Usage: sh scripts/docker-smoke.sh   (IMAGE=name:tag to override the tag)
set -eu

IMAGE="${IMAGE:-mcp-host-gateway:smoke}"
WORK="$(mktemp -d)"
CID=""
cleanup() {
  if [ -n "$CID" ]; then docker rm -f "$CID" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== 1. docker build"
docker build -t "$IMAGE" .

echo "== 2. no config: must exit non-zero"
if docker run --rm "$IMAGE"; then
  echo "FAIL: container started without a config" >&2
  exit 1
fi
echo "ok: exited non-zero without config"

echo "== 3. valid config: must become healthy"
cat > "$WORK/gateway.yaml" <<'YAML'
version: 1
listen: { host: 0.0.0.0, port: 8080 }
auth: { mode: static, tokens_env: GATEWAY_STATIC_TOKENS }
upstreams:
  jobscout: { url: "http://jobscout.invalid:8080/mcp", tools_allow: [jobscout_list_sources] }
entitlements:
  free: { upstreams: [jobscout], rpm: 30 }
rate: { store: sqlite, sqlite_path: /app/data/rate.sqlite }
audit: { sink: file, path: /app/data/audit.jsonl }
YAML
CID="$(docker run -d \
  -e GATEWAY_STATIC_TOKENS=smoke-token-0123456789:smoke:free \
  -v "$WORK/gateway.yaml:/etc/mcp-host-gateway/gateway.yaml:ro" \
  "$IMAGE")"

i=0
while [ "$i" -lt 45 ]; do
  STATUS="$(docker inspect -f '{{.State.Health.Status}}' "$CID" 2>/dev/null || echo missing)"
  RUNNING="$(docker inspect -f '{{.State.Running}}' "$CID" 2>/dev/null || echo false)"
  if [ "$STATUS" = "healthy" ]; then
    echo "ok: container healthy"
    docker exec "$CID" id -u | grep -qv '^0$' && echo "ok: running as non-root uid $(docker exec "$CID" id -u)"
    exit 0
  fi
  if [ "$RUNNING" != "true" ]; then
    echo "FAIL: container stopped" >&2
    docker logs "$CID" >&2 || true
    exit 1
  fi
  i=$((i + 1))
  sleep 2
done
echo "FAIL: container did not become healthy (last status: $STATUS)" >&2
docker logs "$CID" >&2 || true
exit 1
