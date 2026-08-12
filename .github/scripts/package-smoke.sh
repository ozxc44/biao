#!/usr/bin/env bash

set -euo pipefail

smoke_tmp_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
pack_dir=$(mktemp -d "$smoke_tmp_root/biao-pack-smoke.XXXXXX")
consumer_dir=$(mktemp -d "$smoke_tmp_root/biao-consumer-smoke.XXXXXX")
workspace_dir=$(mktemp -d "$smoke_tmp_root/biao-workspace-smoke.XXXXXX")
service_pid=''

cleanup() {
  if [[ -n "$service_pid" ]]; then
    kill "$service_pid" 2>/dev/null || true
    wait "$service_pid" 2>/dev/null || true
  fi
  redis-cli -n 15 DEL biao:v1:hash:agent:package-smoke-worker >/dev/null 2>&1 || true
  for path in "$pack_dir" "$consumer_dir" "$workspace_dir"; do
    case "$path" in
      "$smoke_tmp_root"/biao-*-smoke.*) rm -rf -- "$path" ;;
      *) echo "拒绝清理非 smoke 临时目录：$path" >&2 ;;
    esac
  done
}
trap cleanup EXIT

package_name=$(npm pack --pack-destination "$pack_dir" --ignore-scripts --silent | tail -n 1)
npm install --prefix "$consumer_dir" "$pack_dir/$package_name" --ignore-scripts --no-audit --no-fund

installed_root="$consumer_dir/node_modules/@vtp/biao"
BIAO_BOOTSTRAP_TOKEN=ci-package-smoke-token /bin/sh "$installed_root/bootstrap.sh" --yes \
  --workspace "$workspace_dir" \
  --project "$workspace_dir" \
  --redis-url redis://127.0.0.1:6379/15 \
  --port 17450 \
  --pm-agent codex

"$installed_root/.biao/doctor"
"$installed_root/.biao/pm" --help >/dev/null
"$installed_root/.biao/start" >"$consumer_dir/service.log" 2>&1 &
service_pid=$!

for _ in {1..50}; do
  if curl --fail --silent --show-error http://127.0.0.1:17450/health >"$consumer_dir/health.json"; then
    break
  fi
  sleep 0.1
done

grep -q '"ok":true' "$consumer_dir/health.json"
curl --fail --silent --show-error -H 'Accept: text/html' http://127.0.0.1:17450/ | grep -qi '<!doctype html'
status_code=$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:17450/status)
[[ "$status_code" == 401 ]]
. "$installed_root/.biao/config.env"
printf 'header = "Authorization: Bearer %s"\n' "$BIAO_API_TOKEN" \
  | curl --config - --fail --silent --show-error http://127.0.0.1:17450/install \
  | grep -q 'Installing CLI'
unset BIAO_API_TOKEN
BIAO_AGENT_ID=package-smoke-worker BIAO_EXEC_CMD=/bin/true "$installed_root/.biao/worker-custom"

echo '[biao] tarball install/bootstrap/doctor/CLI/service smoke 通过。'
