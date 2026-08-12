#!/usr/bin/env bash

set -euo pipefail

smoke_tmp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
pack_dir=$(mktemp -d "$smoke_tmp_root/biao-pack-smoke.XXXXXX")
consumer_dir=$(mktemp -d "$smoke_tmp_root/biao-consumer-smoke.XXXXXX")
workspace_dir=$(mktemp -d "$smoke_tmp_root/biao-workspace-smoke.XXXXXX")
service_pid=''
redis_pid=''
redis_container=''

reserve_port() {
  node -e 'const net=require("node:net"); const server=net.createServer(); server.listen(0,"127.0.0.1",()=>{console.log(server.address().port); server.close();});'
}

cleanup() {
  if [[ -n "$service_pid" ]]; then
    kill "$service_pid" 2>/dev/null || true
    wait "$service_pid" 2>/dev/null || true
  fi
  if [[ -n "$redis_pid" ]]; then
    kill "$redis_pid" 2>/dev/null || true
    wait "$redis_pid" 2>/dev/null || true
  fi
  if [[ -n "$redis_container" ]]; then
    docker rm --force "$redis_container" >/dev/null 2>&1 || true
  fi
  for path in "$pack_dir" "$consumer_dir" "$workspace_dir"; do
    case "$path" in
      "$smoke_tmp_root"/biao-*-smoke.*) rm -rf -- "$path" ;;
      *) echo "拒绝清理非 smoke 临时目录：$path" >&2 ;;
    esac
  done
}
trap cleanup EXIT

redis_port=$(reserve_port)
service_port=$(reserve_port)
if command -v redis-server >/dev/null 2>&1; then
  redis-server --bind 127.0.0.1 --port "$redis_port" --save '' --appendonly no \
    --dir "$pack_dir" >"$pack_dir/redis.log" 2>&1 &
  redis_pid=$!
elif command -v docker >/dev/null 2>&1; then
  redis_container=$(docker run --detach --rm --publish "127.0.0.1:$redis_port:6379" redis:7-alpine \
    redis-server --save '' --appendonly no)
else
  echo '安装包 smoke 需要 redis-server 或 Docker 来启动独立临时 Redis。' >&2
  exit 2
fi
smoke_redis_url="redis://127.0.0.1:$redis_port/0"

probe_smoke_redis() {
  if [[ -n "$redis_container" ]]; then
    docker exec "$redis_container" redis-cli ping 2>/dev/null | grep -q '^PONG$'
  else
    BIAO_REDIS_PROBE_URL="$smoke_redis_url" node scripts/redis-probe.mjs
  fi
}

for _ in {1..50}; do
  if probe_smoke_redis; then
    break
  fi
  sleep 0.1
done
probe_smoke_redis

package_name=$(npm pack --pack-destination "$pack_dir" --ignore-scripts --silent | tail -n 1)
npm install --prefix "$consumer_dir" "$pack_dir/$package_name" --ignore-scripts --no-audit --no-fund

installed_root="$consumer_dir/node_modules/@vtp/biao"
BIAO_BOOTSTRAP_TOKEN=ci-package-smoke-token /bin/sh "$installed_root/bootstrap.sh" --yes \
  --workspace "$workspace_dir" \
  --project "$workspace_dir" \
  --redis-url "$smoke_redis_url" \
  --port "$service_port" \
  --pm-agent codex

"$installed_root/.biao/doctor"
"$installed_root/.biao/pm" --help >/dev/null
"$installed_root/.biao/start" >"$consumer_dir/service.log" 2>&1 &
service_pid=$!

for _ in {1..50}; do
  if curl --fail --silent --show-error "http://127.0.0.1:$service_port/health" >"$consumer_dir/health.json"; then
    break
  fi
  sleep 0.1
done

grep -q '"ok":true' "$consumer_dir/health.json"
curl --fail --silent --show-error -H 'Accept: text/html' "http://127.0.0.1:$service_port/" | grep -qi '<!doctype html'
status_code=$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$service_port/status")
[[ "$status_code" == 401 ]]
. "$installed_root/.biao/config.env"
printf 'header = "Authorization: Bearer %s"\n' "$BIAO_API_TOKEN" \
  | curl --config - --fail --silent --show-error "http://127.0.0.1:$service_port/install" \
  | grep -q 'Installing CLI'
unset BIAO_API_TOKEN
BIAO_AGENT_ID=package-smoke-worker BIAO_EXEC_CMD=/bin/true "$installed_root/.biao/worker-custom"

echo '[biao] tarball install/bootstrap/doctor/CLI/service smoke 通过。'
