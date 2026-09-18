#!/usr/bin/env bash
# @type script
# @purpose Keep an authenticated annotation server and Cloudflare Tunnel alive together.

set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "Usage: $0 SAMPLING_ROOT ANNOTATIONS [PORT]" >&2
  exit 2
fi

sampling_root=$1
annotations=$2
port=${3:-8765}
token=${ANNOTATION_REVIEW_TOKEN:-}

if [[ -z "$token" ]]; then
  echo "Set ANNOTATION_REVIEW_TOKEN to a long random value before exposing the app." >&2
  exit 2
fi
if ! command -v cloudflared >/dev/null; then
  echo "cloudflared is required and was not found in PATH." >&2
  exit 2
fi

log_root=${ANNOTATION_REVIEW_LOG_DIR:-$(dirname "$annotations")/review-runtime}
mkdir -p "$log_root"
server_log="$log_root/server.log"
tunnel_log="$log_root/cloudflared.log"

python scripts/annotation-review/server.py \
  "$sampling_root" "$annotations" \
  --host 127.0.0.1 --port "$port" --access-token "$token" \
  >"$server_log" 2>&1 &
server_pid=$!

cleanup() {
  kill "$server_pid" "${tunnel_pid:-}" 2>/dev/null || true
  wait "$server_pid" "${tunnel_pid:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

ready=false
for _attempt in {1..50}; do
  if curl --silent --fail \
    --header "Authorization: Bearer $token" \
    "http://127.0.0.1:$port/api/state" >/dev/null; then
    ready=true
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    cat "$server_log" >&2
    exit 1
  fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then
  echo "Annotation server did not become ready; see $server_log" >&2
  exit 1
fi

echo "Annotation server is ready on 127.0.0.1:$port."
echo "Runtime logs: $log_root"
echo "After cloudflared prints the HTTPS URL, open: HTTPS_URL/?token=<your token>"

if [[ -n "${CLOUDFLARED_TUNNEL_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  tunnel_args=($CLOUDFLARED_TUNNEL_ARGS)
else
  tunnel_args=(tunnel --no-autoupdate --url "http://127.0.0.1:$port")
fi
cloudflared "${tunnel_args[@]}" > >(tee "$tunnel_log") 2>&1 &
tunnel_pid=$!
wait "$tunnel_pid"
